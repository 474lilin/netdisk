// =============================================================================
// 文件服务（核心业务）：
//   上传（单请求 / 分片断点续传）/ 下载 / 预览
//   目录操作（新建/重命名/移动/复制/批量）
//   版本管理（MinIO 对象版本控制 + 回滚）
//   回收站（删除/恢复/彻底删除）
//   去重秒传（零拷贝共享引用，不限文件大小）
// 对象 Key 与 S3 概念完全封装在服务层，前端不可见
// =============================================================================
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { Response } from 'express';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { computeObjectHash } from '../lib/blake3.js';
import { cacheGet, cacheSet, cacheDel } from '../lib/cache.js';
import {
  abortMultipart,
  completeMultipart,
  copyObject,
  createMultipart,
  dedupKey,
  getObjectStream,
  objectExists,
  objectKey,
  presignGet,
  presignPartPut,
  presignPut,
  removeObjectAllVersions,
  removeObjectsBulk,
  statObject,
  type PartInfo,
} from '../lib/minio.js';

// archiver：容器内为对象导出（{ZipArchive,...}，非旧版函数），用 createRequire 引入并标注最小接口
const require2 = createRequire(import.meta.url);
interface ArchiverLike {
  append(source: unknown, data: { name: string }): void;
  pipe(dest: NodeJS.WritableStream): NodeJS.WritableStream;
  on(event: string, cb: () => void): this;
  finalize(): Promise<void>;
  destroy(): void;
}
const archiverMod = require2('archiver') as {
  ZipArchive: new (opts?: Record<string, unknown>) => ArchiverLike;
};
import { config } from '../config/index.js';
import { ROLES, TARGET_TYPES, DIR_SCOPES, type AccessRights, type DedupPoolRow, type DirectoryRow, type FileListItem, type FileRow, type FileVersionRow, type UploadSessionRow } from '../types/index.js';
import { requireDirAccess, requireFileAccess, resolveDirAccess, isAncestor } from './permission.service.js';
import { applyUsedDelta, checkQuota } from './quota.service.js';
import type { AuthedUser } from '../middleware/auth.js';

// ---------- 工具 ----------

const NAME_RE = /^[^/\\]{1,255}$/;
// 控制字符（CR/LF/NUL 等）：防止写入 HTTP 头（x-amz-meta-name）造成头注入
const CONTROL_RE = /[\x00-\x1f\x7f]/;

/**
 * 文件/目录名校验（防穿越 + 防头注入）：
 * 1) 原始名：不允许 / \、. / ..、控制字符、长度 1-255
 * 2) URL 解码后二次校验（循环解码防双重编码）：拦截 %2F、%5C、%00、%0A 等编码穿越/控制字符
 * 注：对象 key 基于文件 ID（与文件名无关），本校验为纵深防御，且保护下载响应头与元数据头。
 */
export function validateFileName(name: string): void {
  let rawOk = NAME_RE.test(name) && name !== '.' && name !== '..' && !CONTROL_RE.test(name);
  if (!rawOk) {
    throw ApiError.badRequest('文件名不合法（不能包含路径分隔符/控制字符，长度 1-255）');
  }
  // URL 解码（最多 3 轮，拦截 %2F/%5C/%00/%0A 及双重编码 %252F 等）
  let decoded = name;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break; // 非法 % 序列：按原名（已通过原始校验）
    }
    if (next === decoded) break;
    decoded = next;
  }
  const decodedOk = NAME_RE.test(decoded) && decoded !== '.' && decoded !== '..' && !CONTROL_RE.test(decoded);
  if (!decodedOk) {
    throw ApiError.badRequest('文件名不合法（不能包含编码后的路径分隔符/控制字符，长度 1-255）');
  }
}

function fileToDto(file: FileRow, rights?: AccessRights): FileListItem {
  return {
    id: file.id,
    type: 'file',
    name: file.name,
    ext: file.ext,
    mime: file.mime_type,
    size: Number(file.size_bytes),
    sha256: file.sha256 || undefined,
    versionId: file.version_id,
    ownerId: file.owner_id,
    dirId: file.dir_id,
    deletedAt: file.deleted_at ? file.deleted_at.toISOString() : null,
    createdAt: file.created_at.toISOString(),
    updatedAt: file.updated_at.toISOString(),
    canWrite: rights?.write,
    canDelete: rights?.del,
    canShare: rights?.share,
  };
}

function dirToDto(dir: DirectoryRow, rights?: AccessRights): FileListItem {
  return {
    id: dir.id,
    type: 'dir',
    name: dir.name,
    scope: dir.scope,
    dirId: dir.parent_id ?? undefined,
    createdAt: dir.created_at.toISOString(),
    updatedAt: dir.updated_at.toISOString(),
    canWrite: rights?.write,
    canDelete: rights?.del,
    canShare: rights?.share,
  };
}

// =============================================================================
// 去重池后台注册与校验（大文件池异步执行：拷贝对象 + 校验哈希 + 置 verified）
// 同进程去重命中（小/中文件）可等待在途任务完成；超大文件不等待，池就绪后自动生效
// 并发限制：大批量上传（数万文件）时避免同时发起海量 MinIO 拷贝打爆对象存储
// =============================================================================
const POOL_JOB_CONCURRENCY = 8;
let poolJobActive = 0;
const poolJobQueue: Array<() => void> = [];
const poolJobs = new Map<string, Promise<void>>();

function poolJobSlot(): Promise<void> {
  if (poolJobActive < POOL_JOB_CONCURRENCY) {
    poolJobActive += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => poolJobQueue.push(resolve));
}

function poolJobRelease(): void {
  const next = poolJobQueue.shift();
  if (next) next();
  else poolJobActive -= 1;
}

/** 限流执行池任务：同一 sha 去重 + 全局并发上限 */
function schedulePoolJob(key: string, fn: () => Promise<void>): void {
  if (poolJobs.has(key)) return;
  const job = (async () => {
    await poolJobSlot();
    try {
      await fn();
    } catch (err) {
      logger.warn('pool job failed', { key, message: (err as Error).message });
    } finally {
      poolJobRelease();
    }
  })().finally(() => poolJobs.delete(key));
  poolJobs.set(key, job);
}

/** 校验池对象哈希（BLAKE3）：一致则置 verified；不一致则删除池对象与记录（防错误引用）
 *  传入 expectedSha 后，若段哈希缓存命中（由源对象校验写入）则纯 RAM 组合，免读 MinIO */
async function verifyDedupPool(orgId: string, sha256: string): Promise<void> {
  const poolKey = dedupKey(orgId, sha256);
  try {
    const stat = await statObject(poolKey);
    const realHash = await computeObjectHash(poolKey, stat.size, { orgId, expectedSha: sha256 });
    if (realHash === sha256) {
      await query(`UPDATE dedup_pool SET verified = TRUE WHERE org_id = $1 AND sha256 = $2`, [orgId, sha256]);
    } else {
      logger.warn('dedup pool background verify mismatch, removing pool', { orgId, sha256 });
      await removeObjectAllVersions(poolKey);
      await query(`DELETE FROM dedup_pool WHERE org_id = $1 AND sha256 = $2`, [orgId, sha256]);
    }
  } catch (err) {
    logger.warn('dedup pool background verify failed', { orgId, sha256, message: (err as Error).message, stack: (err as Error).stack });
  }
}

/** 后台注册：先对源对象哈希（写入段哈希缓存，池校验可复用免读），拷贝入池，再校验（命中缓存 -> 纯 RAM 组合） */
async function registerPoolAsync(orgId: string, sha256: string, sourceKey: string): Promise<void> {
  const poolKey = dedupKey(orgId, sha256);
  try {
    // 1) 对源对象计算哈希（同时校验客户端哈希是否可信；段哈希写入缓存）
    const srcStat = await statObject(sourceKey);
    const srcHash = await computeObjectHash(sourceKey, srcStat.size, { orgId, expectedSha: sha256 });
    if (srcHash !== sha256) {
      logger.warn('dedup pool source hash mismatch, skip registration', { orgId, sha256 });
      // 客户端哈希与源对象内容不符：池记录不可信，清理
      await removeObjectAllVersions(poolKey);
      await query(`DELETE FROM dedup_pool WHERE org_id = $1 AND sha256 = $2`, [orgId, sha256]);
      return;
    }
    // 2) 拷贝入池（池对象生命周期独立于源对象）
    if (!(await objectExists(poolKey))) {
      await copyObject(sourceKey, poolKey);
    }
    // 3) 校验池对象：段哈希缓存命中 -> 纯 RAM 组合；并校验大小完整性
    const poolStat = await statObject(poolKey);
    if (poolStat.size !== srcStat.size) {
      throw new Error(`pool size mismatch ${poolStat.size} != ${srcStat.size}`);
    }
    await verifyDedupPool(orgId, sha256);
  } catch (err) {
    logger.warn('dedup pool async register failed', { orgId, sha256, message: (err as Error).message });
  }
}

function schedulePoolRegistration(orgId: string, sha256: string, sourceKey: string): void {
  const key = `${orgId}:${sha256}`;
  schedulePoolJob(key, () => registerPoolAsync(orgId, sha256, sourceKey));
}

/**
 * 服务启动/定时扫描：恢复未完成的池注册校验（进程重启后，未 verified 的池记录重新入队）
 * 对象已存在则直接校验；对象缺失则清理无效记录
 */
export async function resumePendingPoolVerifications(): Promise<void> {
  const pending = await query<{ org_id: string; sha256: string }>(
    `SELECT org_id, sha256 FROM dedup_pool WHERE verified = FALSE`
  );
  for (const p of pending.rows) {
    const key = `${p.org_id}:${p.sha256}`;
    schedulePoolJob(key, async () => {
      const poolKey = dedupKey(p.org_id, p.sha256);
      if (!(await objectExists(poolKey))) {
        // 对象不存在（拷贝未完成/已丢失）：清理无效记录
        await query(`DELETE FROM dedup_pool WHERE org_id = $1 AND sha256 = $2`, [p.org_id, p.sha256]);
        return;
      }
      await verifyDedupPool(p.org_id, p.sha256);
    });
  }
  if (pending.rows.length > 0) {
    logger.info('resume pending pool verifications', { count: pending.rows.length });
  }
}

/**
 * 去重命中尝试（零拷贝共享引用）。返回创建的文件 DTO；未就绪/未验证时返回 null（走普通上传）
 * - 池对象缺失且后台注册进行中：小/中文件（<= DEDUP_INLINE_MAX）等待在途任务，超大文件不等待
 * - 未验证：小/中文件在线校验一次并缓存；超大文件跳过（池就绪后自动生效）
 */
async function tryDedupHit(
  user: AuthedUser,
  sha256: string,
  size: number,
  dirId: string,
  name: string,
  ext: string,
  mimeType: string,
  fileId: string
): Promise<FileListItem | null> {
  const poolKey = dedupKey(user.orgId, sha256);
  const jobKey = `${user.orgId}:${sha256}`;
  const reloadPool = (): Promise<DedupPoolRow | null> =>
    queryOne<DedupPoolRow>('SELECT * FROM dedup_pool WHERE org_id = $1 AND sha256 = $2', [user.orgId, sha256]);
  let pool = await reloadPool();
  try {
    if (!(await objectExists(poolKey))) {
      // 池对象尚未就绪：后台注册拷贝中
      if (size <= config.dedupInlineMax) {
        const inflight = poolJobs.get(jobKey);
        if (inflight) {
          await inflight;
          pool = await reloadPool();
        }
      }
      if (!(await objectExists(poolKey))) return null;
    }
    let verified = pool?.verified ?? false;
    if (!verified && size <= config.dedupInlineMax) {
      const stat = await statObject(poolKey);
      const realHash = await computeObjectHash(poolKey, stat.size, { orgId: user.orgId, expectedSha: sha256 });
      verified = realHash === sha256;
      if (verified) {
        await query(
          `INSERT INTO dedup_pool (org_id, sha256, size_bytes, verified) VALUES ($1, $2, $3, TRUE)
           ON CONFLICT (org_id, sha256) DO UPDATE SET verified = TRUE`,
          [user.orgId, sha256, size]
        );
      } else {
        logger.warn('dedup pool hash mismatch, skip dedup', { sha256 });
      }
    }
    if (!verified) return null; // 超大文件未验证：跳过，池就绪后自动生效

    // 零拷贝秒传：文件元数据直接引用去重池对象（多文件共享同一对象，不做数据复制）
    const r = await query<FileRow>(
      `INSERT INTO files (id, org_id, dir_id, owner_id, name, ext, mime_type, size_bytes, sha256, object_key, version_id, dedup_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '', TRUE) RETURNING *`,
      [fileId, user.orgId, dirId, user.id, name, ext, mimeType, size, sha256, poolKey]
    );
    await query(
      `INSERT INTO file_versions (file_id, object_key, version_id, size_bytes, sha256, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [fileId, poolKey, '', size, sha256, user.id]
    );
    await applyUsedDelta(user.id, size);
    return fileToDto(r.rows[0]);
  } catch (err) {
    logger.warn('dedup pool check failed, fallback to upload', { message: (err as Error).message, stack: (err as Error).stack });
    return null;
  }
}

async function getSubtreeDirIds(dirPath: string): Promise<{ id: string; path: string }[]> {
  const res = await query<{ id: string; path: string }>(
    `SELECT id, path FROM directories WHERE path = $1 OR path LIKE $1 || '%'`,
    [dirPath]
  );
  return res.rows;
}

// ---------- Redis 热点缓存（目录列表） ----------
const DIR_LIST_TTL = 30; // 秒；写操作（上传/改名/移动/删除/恢复/清空）会主动失效，TTL 仅兜底

// 键含 userId：列表项携带按用户 ACL 解析的权限摘要（canWrite 等），不可跨用户共享缓存
function dirListKey(orgId: string, userId: string, dirId: string): string {
  return `dir:${orgId}:${userId}:${dirId}`;
}

/** 目录列表缓存失效：操作涉及的目录及其父目录（内容变化影响父列表的子项展示） */
export async function invalidateDirCache(user: AuthedUser, ...dirIds: (string | null | undefined)[]): Promise<void> {
  const keys = [...new Set(dirIds.filter(Boolean) as string[])].map((id) => dirListKey(user.orgId, user.id, id));
  if (keys.length > 0) await cacheDel(...keys);
}

// ---------- 目录浏览 ----------

/** 目录列表：分页（offset/limit）。目录全部返回（数量少），文件按 name 分页；
 *  仅缓存首页（offset=0）——分页页直接查库（有索引），写操作失效整键不受影响 */
export async function listDir(
  user: AuthedUser,
  dirId: string,
  opts: { offset?: number; limit?: number } = {}
): Promise<{ items: FileListItem[]; dir: DirectoryRow; rights: AccessRights; total: number; hasMore: boolean }> {
  // 权限实时校验（不缓存，安全优先）
  const { dir, rights } = await resolveDirAccess(user, dirId);
  if (!rights.read) throw ApiError.forbidden('无权访问该目录');
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(5000, Math.max(1, opts.limit ?? 500));

  const cacheKey = dirListKey(user.orgId, user.id, dirId);
  if (offset === 0) {
    const cached = await cacheGet<{ items: FileListItem[]; total: number }>(cacheKey);
    if (cached) {
      return {
        items: cached.items,
        dir,
        rights,
        total: cached.total,
        hasMore: cached.items.length < cached.total,
      };
    }
  }

  const dirRes = await query<DirectoryRow>(
    `SELECT * FROM directories WHERE parent_id = $1 AND org_id = $2 AND is_deleted = FALSE ORDER BY name`,
    [dirId, user.orgId]
  );
  const fileRes = await query<FileRow>(
    `SELECT * FROM files WHERE dir_id = $1 AND org_id = $2 AND is_deleted = FALSE ORDER BY name LIMIT $3 OFFSET $4`,
    [dirId, user.orgId, limit, offset]
  );
  const countRes = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM files WHERE dir_id = $1 AND org_id = $2 AND is_deleted = FALSE`,
    [dirId, user.orgId]
  );
  const fileTotal = Number(countRes.rows[0]?.c ?? 0);

  // 批量解析子目录权限（ACL 可能不同），文件沿用父目录权限
  const dirs = dirRes.rows;
  interface AclRowLite {
    dir_id: string; target_type: number; target_id: string;
    can_read: boolean; can_write: boolean; can_delete: boolean; can_share: boolean;
  }
  const aclRows = dirs.length > 0
    ? await query<AclRowLite>(
        `SELECT dir_id, target_type, target_id, can_read, can_write, can_delete, can_share FROM acls WHERE dir_id = ANY($1)`,
        [dirs.map((d) => d.id)]
      )
    : { rows: [] as AclRowLite[] };

  const items: FileListItem[] = dirs.map((d) => {
    const acl = aclRows.rows.filter(
      (a) => a.dir_id === d.id && ((a.target_type === TARGET_TYPES.USER && a.target_id === user.id) || (a.target_type === TARGET_TYPES.DEPT && a.target_id === user.deptId) || (a.target_type === TARGET_TYPES.ORG && a.target_id === user.orgId))
    );
    const r: AccessRights = { ...rights };
    for (const a of acl) {
      r.read = r.read || a.can_read;
      r.write = r.write || a.can_write;
      r.del = r.del || a.can_delete;
      r.share = r.share || a.can_share;
    }
    return dirToDto(d, r);
  });
  const fileItems = fileRes.rows.map((f) => fileToDto(f, rights));
  items.push(...fileItems);
  const total = dirs.length + fileTotal;
  const hasMore = offset + fileItems.length < fileTotal;
  if (offset === 0) {
    await cacheSet(cacheKey, { items, total }, DIR_LIST_TTL);
  }
  return { items, dir, rights, total, hasMore };
}

export async function getBreadcrumb(user: AuthedUser, dirId: string): Promise<FileListItem[]> {
  const { dir } = await resolveDirAccess(user, dirId);
  const ids = dir.path.split('/').filter(Boolean);
  const crumbs: FileListItem[] = [];
  for (const id of ids) {
    const d = await queryOne<DirectoryRow>('SELECT * FROM directories WHERE id = $1 AND org_id = $2', [id, user.orgId]);
    if (d) crumbs.push(dirToDto(d));
  }
  crumbs.push(dirToDto(dir));
  return crumbs;
}

// ---------- 目录/文件操作 ----------

export async function mkdir(user: AuthedUser, parentId: string, name: string): Promise<FileListItem> {
  validateFileName(name);
  const parent = await requireDirAccess(user, parentId, 'write');
  const dup = await queryOne('SELECT 1 FROM directories WHERE parent_id = $1 AND name = $2 AND is_deleted = FALSE', [parentId, name]);
  if (dup) throw ApiError.conflict('同名文件夹已存在');
  const r = await query<DirectoryRow>(
    `INSERT INTO directories (org_id, dept_id, parent_id, owner_id, name, path, scope, created_by)
     VALUES ($1, $2, $3, $4, $5, '', $6, $7) RETURNING *`,
    [parent.org_id, parent.dept_id, parentId, parent.owner_id ?? user.id, name, parent.scope, user.id]
  );
  const d = r.rows[0];
  await query(`UPDATE directories SET path = $2 || id || '/' WHERE id = $1`, [d.id, parent.path]);
  await invalidateDirCache(user, parentId);
  return dirToDto(d, { read: true, write: true, del: true, share: true });
}

export async function renameItem(user: AuthedUser, id: string, type: 'file' | 'dir', name: string): Promise<void> {
  validateFileName(name);
  if (type === 'dir') {
    const dir = await requireDirAccess(user, id, 'write');
    const dup = await queryOne('SELECT 1 FROM directories WHERE parent_id = $1 AND name = $2 AND id <> $3 AND is_deleted = FALSE', [dir.parent_id, name, id]);
    if (dup) throw ApiError.conflict('同名文件夹已存在');
    await query(`UPDATE directories SET name = $2, updated_at = now() WHERE id = $1`, [id, name]);
    await invalidateDirCache(user, dir.parent_id);
  } else {
    const file = await requireFileAccess(user, id, 'write');
    const dup = await queryOne('SELECT 1 FROM files WHERE dir_id = $1 AND name = $2 AND id <> $3 AND is_deleted = FALSE', [file.dir_id, name, id]);
    if (dup) throw ApiError.conflict('同名文件已存在');
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    await query(`UPDATE files SET name = $2, ext = $3, updated_at = now() WHERE id = $1`, [id, name, ext]);
    await invalidateDirCache(user, file.dir_id);
  }
}

export interface TargetRef {
  type: 'file' | 'dir';
  id: string;
}

export async function moveItems(user: AuthedUser, targets: TargetRef[], targetDirId: string): Promise<void> {
  const targetDir = await requireDirAccess(user, targetDirId, 'write');
  const invalidateIds: (string | null)[] = [targetDirId];
  for (const t of targets) {
    if (t.type === 'dir') {
      const src = await requireDirAccess(user, t.id, 'delete');
      invalidateIds.push(src.parent_id, src.id);
      if (src.id === targetDirId || isAncestor(src.path, targetDir.path)) {
        throw ApiError.badRequest('不能移动到自身或其子目录');
      }
      const dup = await queryOne('SELECT 1 FROM directories WHERE parent_id = $1 AND name = $2 AND id <> $3 AND is_deleted = FALSE', [targetDirId, src.name, src.id]);
      if (dup) throw ApiError.conflict(`目标目录已存在同名文件夹：${src.name}`);
      const oldPath = src.path;
      await query(`UPDATE directories SET parent_id = $2, updated_at = now() WHERE id = $1`, [src.id, targetDirId]);
      const newPath = targetDir.path + src.id + '/';
      // 级联更新物化路径（含子孙）
      await query(`UPDATE directories SET path = $2 || substr(path, $3) WHERE path = $1 OR path LIKE $1 || '%'`, [
        oldPath,
        newPath,
        oldPath.length + 1,
      ]);
    } else {
      const file = await requireFileAccess(user, t.id, 'delete');
      invalidateIds.push(file.dir_id);
      const dup = await queryOne('SELECT 1 FROM files WHERE dir_id = $1 AND name = $2 AND id <> $3 AND is_deleted = FALSE', [targetDirId, file.name, file.id]);
      if (dup) throw ApiError.conflict(`目标目录已存在同名文件：${file.name}`);
      await query(`UPDATE files SET dir_id = $2, updated_at = now() WHERE id = $1`, [file.id, targetDirId]);
    }
  }
  await invalidateDirCache(user, ...invalidateIds);
}

export async function copyItems(user: AuthedUser, targets: TargetRef[], targetDirId: string): Promise<void> {
  await requireDirAccess(user, targetDirId, 'write');
  for (const t of targets) {
    if (t.type === 'file') {
      await copySingleFile(user, t.id, targetDirId);
    } else {
      await copyDirRecursive(user, t.id, targetDirId);
    }
  }
  await invalidateDirCache(user, targetDirId);
}

async function copySingleFile(user: AuthedUser, fileId: string, targetDirId: string): Promise<FileRow> {
  const src = await requireFileAccess(user, fileId, 'read');
  const newId = crypto.randomUUID();
  const newKey = objectKey(user.orgId, newId);
  await copyObject(src.object_key, newKey, src.version_id);
  const dup = await queryOne('SELECT 1 FROM files WHERE dir_id = $1 AND name = $2 AND is_deleted = FALSE', [targetDirId, src.name]);
  if (dup) throw ApiError.conflict(`目标目录已存在同名文件：${src.name}`);
  const r = await query<FileRow>(
    `INSERT INTO files (id, org_id, dir_id, owner_id, name, ext, mime_type, size_bytes, sha256, object_key, version_id, dedup_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [newId, user.orgId, targetDirId, user.id, src.name, src.ext, src.mime_type, src.size_bytes, src.sha256, newKey, src.version_id, src.dedup_ref]
  );
  await query(
    `INSERT INTO file_versions (file_id, object_key, version_id, size_bytes, sha256, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [newId, newKey, src.version_id, src.size_bytes, src.sha256, user.id]
  );
  await applyUsedDelta(user.id, src.size_bytes);
  return r.rows[0];
}

async function copyDirRecursive(user: AuthedUser, dirId: string, targetDirId: string): Promise<void> {
  const src = await requireDirAccess(user, dirId, 'read');
  const target = await queryOne<DirectoryRow>('SELECT * FROM directories WHERE id = $1', [targetDirId]);
  const newId = crypto.randomUUID();
  const newPath = (target?.path ?? '/') + newId + '/';
  await query(
    `INSERT INTO directories (id, org_id, dept_id, parent_id, owner_id, name, path, scope, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [newId, user.orgId, src.dept_id, targetDirId, user.id, src.name, newPath, src.scope, user.id]
  );
  // 递归子目录
  const childDirs = await query<DirectoryRow>('SELECT * FROM directories WHERE parent_id = $1 AND is_deleted = FALSE', [dirId]);
  for (const c of childDirs.rows) {
    await copyDirRecursive(user, c.id, newId);
  }
  // 复制文件
  const files = await query<FileRow>('SELECT * FROM files WHERE dir_id = $1 AND is_deleted = FALSE', [dirId]);
  for (const f of files.rows) {
    await copySingleFile(user, f.id, newId);
  }
}

// ---------- 回收站 ----------

export async function deleteToTrash(user: AuthedUser, targets: TargetRef[]): Promise<number> {
  let count = 0;
  const invalidateIds: (string | null)[] = [];
  await withTransaction(async (client) => {
    for (const t of targets) {
      if (t.type === 'dir') {
        const dir = await requireDirAccess(user, t.id, 'delete');
        invalidateIds.push(dir.parent_id, dir.id);
        const subtree = await getSubtreeDirIds(dir.path);
        if (subtree.length === 0) continue;
        const ids = subtree.map((s) => s.id);
        invalidateIds.push(...ids);
        await client.query(
          `UPDATE directories SET is_deleted = TRUE, deleted_at = now() WHERE id = ANY($1) AND is_deleted = FALSE`,
          [ids]
        );
        const fileRes = await client.query<{ id: string }>(
          `SELECT id FROM files WHERE dir_id = ANY($1) AND is_deleted = FALSE`,
          [ids]
        );
        if (fileRes.rows.length > 0) {
          await client.query(
            `UPDATE files SET is_deleted = TRUE, deleted_at = now(), deleted_by = $2 WHERE id = ANY($1)`,
            [fileRes.rows.map((r) => r.id), user.id]
          );
          count += fileRes.rows.length;
        }
      } else {
        const file = await requireFileAccess(user, t.id, 'delete');
        invalidateIds.push(file.dir_id);
        await client.query(
          `UPDATE files SET is_deleted = TRUE, deleted_at = now(), deleted_by = $2 WHERE id = $1`,
          [file.id, user.id]
        );
        count += 1;
      }
    }
  });
  await invalidateDirCache(user, ...invalidateIds);
  return count;
}

export async function restoreItems(user: AuthedUser, targets: TargetRef[]): Promise<number> {
  let count = 0;
  const invalidateIds: (string | null)[] = [];
  await withTransaction(async (client) => {
    for (const t of targets) {
      if (t.type === 'dir') {
        // 目录在回收站：恢复整棵子树（目录 + 其下所有已删文件）
        const dir = await queryOne<DirectoryRow>('SELECT * FROM directories WHERE id = $1 AND org_id = $2', [t.id, user.orgId]);
        if (!dir || !dir.is_deleted) continue;
        invalidateIds.push(dir.parent_id, dir.id);
        const fallbackRoot = await getOrgRoot(user.orgId);
        let parentOk = true;
        if (dir.parent_id) {
          const parent = await queryOne<{ is_deleted: boolean }>('SELECT is_deleted FROM directories WHERE id = $1', [dir.parent_id]);
          if (!parent || parent.is_deleted) parentOk = false;
        }
        await client.query(
          `UPDATE directories SET is_deleted = FALSE, deleted_at = NULL
           WHERE (path = $1 OR path LIKE $1 || '%') AND is_deleted = TRUE`,
          [dir.path]
        );
        if (!parentOk) {
          // 原父目录已不存在：挂回企业公共盘根目录，并级联修正物化路径
          invalidateIds.push(fallbackRoot.id);
          const oldPrefix = dir.path;
          const newPrefix = fallbackRoot.path + dir.id + '/';
          await client.query(`UPDATE directories SET parent_id = $2 WHERE id = $1`, [dir.id, fallbackRoot.id]);
          await client.query(
            `UPDATE directories SET path = $2 || substr(path, $3)
             WHERE path = $1 OR path LIKE $1 || '%'`,
            [oldPrefix, newPrefix, oldPrefix.length + 1]
          );
        }
        const subtree = await getSubtreeDirIds(dir.path);
        invalidateIds.push(...subtree.map((s) => s.id));
        const fileRes = await client.query<{ id: string }>(
          `SELECT f.id FROM files f
           JOIN directories d ON d.id = f.dir_id
           WHERE (d.path = $1 OR d.path LIKE $1 || '%') AND f.is_deleted = TRUE`,
          [dir.path]
        );
        if (fileRes.rows.length > 0) {
          await client.query(`UPDATE files SET is_deleted = FALSE, deleted_at = NULL WHERE id = ANY($1)`, [fileRes.rows.map((r) => r.id)]);
          count += fileRes.rows.length;
        }
        count += 1;
      } else {
        const file = await queryOne<FileRow>('SELECT * FROM files WHERE id = $1 AND org_id = $2', [t.id, user.orgId]);
        if (!file || !file.is_deleted) continue;
        invalidateIds.push(file.dir_id);
        const dir = await queryOne<DirectoryRow>('SELECT * FROM directories WHERE id = $1', [file.dir_id]);
        if (!dir || dir.is_deleted) {
          const fallbackRoot = await getOrgRoot(user.orgId);
          invalidateIds.push(fallbackRoot.id);
          await client.query(`UPDATE files SET dir_id = $2 WHERE id = $1`, [file.id, fallbackRoot.id]);
        }
        await client.query(`UPDATE files SET is_deleted = FALSE, deleted_at = NULL WHERE id = $1`, [file.id]);
        count += 1;
      }
    }
  });
  await invalidateDirCache(user, ...invalidateIds);
  return count;
}

export async function purgeItems(user: AuthedUser, targets: TargetRef[]): Promise<number> {
  let count = 0;
  const invalidateIds: (string | null)[] = [];
  // 目录 purge 性能优化（v1.1.3 回收站清空提速）：
  // ① 对象删除用 S3 批量 DeleteObjects（单请求 1000 key，替代逐对象限流 8——万级文件网络调用从 N 降到 N/1000）
  // ② DB 行删除用批量 SQL（ANY 数组，替代逐条 DELETE + 逐条 quota 更新）
  // ③ 目录子树先合并去重，避免同批多个目录重复扫描/重复删除
  const PURGE_BATCH = 2000;

  // 批量删除对象（含去重共享引用判断），失败不阻断 DB 清理（孤儿对象由 GC 兜底）
  // 返回需要清理 dedup_pool 的 (org_id, sha256) 集合
  const deleteObjectsBulk = async (files: FileRow[]): Promise<Array<{ org_id: string; sha256: string }>> => {
    const poolToClean: Array<{ org_id: string; sha256: string }> = [];
    // 1) 收集版本信息（一次批量查询）
    const ids = files.map((f) => f.id);
    const verRes = await query<{ file_id: string; version_id: string }>(
      `SELECT file_id, version_id FROM file_versions WHERE file_id = ANY($1)`,
      [ids]
    );
    const versionsByFile = new Map<string, string[]>();
    for (const v of verRes.rows) {
      if (!versionsByFile.has(v.file_id)) versionsByFile.set(v.file_id, []);
      versionsByFile.get(v.file_id)!.push(v.version_id);
    }
    // 2) 独立对象批量删（非 dedup_ref）；dedup_ref 单独处理（共享对象，引用归零才删）
    const indep = files.filter((f) => !f.dedup_ref);
    if (indep.length > 0) {
      const keys = indep.map((f) => f.object_key);
      // 分批 1000
      for (let i = 0; i < keys.length; i += 1000) {
        await removeObjectsBulk(keys.slice(i, i + 1000)).catch(() => undefined);
      }
      // 补删已知版本（批量删除只删当前版本；历史版本由版本记录删除——此处直接尝试带版本删）
      for (const f of indep) {
        const vids = versionsByFile.get(f.id);
        if (vids && vids.length > 0) {
          await removeObjectAllVersions(f.object_key, vids).catch(() => undefined);
        }
      }
    }
    // 3) dedup_ref：引用计数归零才删池对象 + 标记池清理
    const dedupRefs = files.filter((f) => f.dedup_ref);
    if (dedupRefs.length > 0) {
      for (const f of dedupRefs) {
        const refs = await query<{ c: string }>(
          `SELECT COUNT(*)::int AS c FROM files WHERE org_id = $1 AND object_key = $2 AND id <> $3`,
          [f.org_id, f.object_key, f.id]
        );
        if (Number(refs.rows[0]?.c ?? 0) === 0) {
          poolToClean.push({ org_id: f.org_id, sha256: f.sha256 });
          await removeObjectAllVersions(f.object_key).catch(() => undefined);
        }
      }
    }
    return poolToClean;
  };

  // DB 行批量删除（事务内，批量 SQL + 聚合 quota）
  const deleteRowsBulk = async (files: FileRow[]): Promise<void> => {
    const ids = files.map((f) => f.id);
    // 聚合 quota：按 owner 汇总扣减
    const deltaByOwner = new Map<string, number>();
    for (const f of files) {
      deltaByOwner.set(f.owner_id, (deltaByOwner.get(f.owner_id) ?? 0) - f.size_bytes);
    }
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM file_versions WHERE file_id = ANY($1)`, [ids]);
      await client.query(`DELETE FROM share_grants WHERE file_id = ANY($1)`, [ids]);
      await client.query(`DELETE FROM files WHERE id = ANY($1)`, [ids]);
      // 聚合扣减 quota（一次 per-owner UPDATE，替代逐条）
      for (const [ownerId, delta] of deltaByOwner) {
        if (delta !== 0) {
          await applyUsedDelta(ownerId, delta);
        }
      }
    });
  };

  // 收集去重后的目录子树（同一回收站子树只处理一次）
  const collectedDirIds = new Set<string>();
  const collectedFiles: FileRow[] = [];
  const purgeDir = async (t: TargetRef): Promise<void> => {
    // 防御：仅允许彻底删除回收站中的目录（is_deleted=TRUE），禁止通过 purge 误删活跃目录
    const dir = await queryOne<DirectoryRow>('SELECT * FROM directories WHERE id = $1 AND org_id = $2', [t.id, user.orgId]);
    if (!dir || !dir.is_deleted) return;
    invalidateIds.push(dir.parent_id, dir.id);
    // 子树限定为已删除目录（与软删的回收站范围一致），防止 path 前缀误匹配活跃目录
    const subtree = await query<{ id: string; path: string }>(
      `SELECT id, path FROM directories WHERE (path = $1 OR path LIKE $1 || '%') AND is_deleted = TRUE`,
      [dir.path]
    );
    let added = false;
    for (const s of subtree.rows) {
      if (!collectedDirIds.has(s.id)) {
        collectedDirIds.add(s.id);
        invalidateIds.push(s.id);
        added = true;
      }
    }
    if (!added) return; // 整棵子树已被其他 target 覆盖
    // 收集子树文件（含已由其他目录收集的 dir 下的文件——文件按 dir_id 去重）
    const fileRes = await query<FileRow>(
      `SELECT * FROM files WHERE dir_id = ANY($1) AND is_deleted = TRUE`,
      [[...subtree.rows.map((s) => s.id)]]
    );
    const seen = new Set<string>();
    for (const f of fileRes.rows) {
      if (!seen.has(f.id)) {
        seen.add(f.id);
        collectedFiles.push(f);
      }
    }
  };

  // 先收集（目录+文件），全部收集完后统一批量删除——避免同批目录反复触发子树查询
  for (const t of targets) {
    if (t.type === 'dir') {
      await purgeDir(t);
    } else {
      const file = await queryOne<FileRow>('SELECT * FROM files WHERE id = $1 AND org_id = $2', [t.id, user.orgId]);
      if (!file || !file.is_deleted) continue;
      invalidateIds.push(file.dir_id);
      collectedFiles.push(file);
    }
  }

  // 文件去重后分批处理
  const uniqFiles: FileRow[] = [];
  const seenFiles = new Set<string>();
  for (const f of collectedFiles) {
    if (!seenFiles.has(f.id)) {
      seenFiles.add(f.id);
      uniqFiles.push(f);
    }
  }
  let poolToClean: Array<{ org_id: string; sha256: string }> = [];
  for (let i = 0; i < uniqFiles.length; i += PURGE_BATCH) {
    const batch = uniqFiles.slice(i, i + PURGE_BATCH);
    poolToClean = poolToClean.concat(await deleteObjectsBulk(batch));
    await deleteRowsBulk(batch);
    count += batch.length;
  }

  // 清理引用归零的 dedup_pool（批量）
  if (poolToClean.length > 0) {
    const seenPool = new Set<string>();
    const poolIds = poolToClean.filter((p) => {
      const k = `${p.org_id}:${p.sha256}`;
      if (seenPool.has(k)) return false;
      seenPool.add(k);
      return true;
    });
    for (const p of poolIds) {
      await query(`DELETE FROM dedup_pool WHERE org_id = $1 AND sha256 = $2`, [p.org_id, p.sha256]).catch(() => undefined);
    }
  }

  // 目录行删除（回收站目录整棵删除）
  if (collectedDirIds.size > 0) {
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM directories WHERE id = ANY($1) AND is_deleted = TRUE`, [[...collectedDirIds]]);
    });
  }

  await invalidateDirCache(user, ...invalidateIds);
  return count;
}

/**
 * 清空回收站（高性能专用）：服务端一次性拉取全部回收站目录与文件，
 * 目录子树合并去重后批量删除对象与 DB 行。相比前端逐批 purge（每批 100/1000 targets），
 * 单请求完成，消除逐目录子树查询与多次 HTTP 往返的开销。
 * 返回删除的文件数（不含目录）。
 */
export async function emptyTrash(user: AuthedUser): Promise<number> {
  const isAdmin = user.role === ROLES.ADMIN;
  const where = isAdmin ? 'org_id = $1' : 'owner_id = $1';
  const params = [isAdmin ? user.orgId : user.id];

  // 1. 回收站目录（全部）——只保留「顶层回收站目录」（path 深度最小的），子树由顶层目录覆盖
  const dirRes = await query<DirectoryRow>(
    `SELECT * FROM directories WHERE ${isAdmin ? 'org_id' : 'owner_id'} = $1 AND is_deleted = TRUE`,
    params
  );
  const allDirs = dirRes.rows;
  // 顶层目录：没有被其他回收站目录 path 前缀包含的
  const topDirs = allDirs.filter((d) => !allDirs.some((o) => o.id !== d.id && (d.path.startsWith(o.path))));
  const topDirIds = topDirs.map((d) => d.id);
  // 全部回收站目录 id（含子树）
  const allDirIds = allDirs.map((d) => d.id);
  console.log('emptyTrash: dirs=', allDirs.length, 'top=', topDirIds.length);

  // 2. 回收站文件（全部）
  const fileRes = await query<FileRow>(
    `SELECT * FROM files WHERE ${where} AND is_deleted = TRUE`,
    params
  );
  const allFiles = fileRes.rows;
  console.log('emptyTrash: files=', allFiles.length);

  // 3. 批量删除对象（独立对象用 S3 批量删除；dedup 引用处理引用计数）
  const indep = allFiles.filter((f) => !f.dedup_ref);
  for (let i = 0; i < indep.length; i += 1000) {
    await removeObjectsBulk(indep.slice(i, i + 1000).map((f) => f.object_key)).catch(() => undefined);
  }
  // 补删已知版本 + dedup 引用归零清理
  const dedupRefs = allFiles.filter((f) => f.dedup_ref);
  for (const f of dedupRefs) {
    const refs = await query<{ c: string }>(
      `SELECT COUNT(*)::int AS c FROM files WHERE org_id = $1 AND object_key = $2 AND id <> $3 AND is_deleted = FALSE`,
      [f.org_id, f.object_key, f.id]
    );
    if (Number(refs.rows[0]?.c ?? 0) === 0) {
      await removeObjectAllVersions(f.object_key).catch(() => undefined);
      await query(`DELETE FROM dedup_pool WHERE org_id = $1 AND sha256 = $2`, [f.org_id, f.sha256]).catch(() => undefined);
    }
  }

  // 4. 批量删除 DB 行（文件 + 目录 + 关联表）
  const allIds = allFiles.map((f) => f.id);
  // 聚合 quota
  const deltaByOwner = new Map<string, number>();
  for (const f of allFiles) {
    deltaByOwner.set(f.owner_id, (deltaByOwner.get(f.owner_id) ?? 0) - f.size_bytes);
  }
  await withTransaction(async (client) => {
    if (allIds.length > 0) {
      await client.query(`DELETE FROM file_versions WHERE file_id = ANY($1)`, [allIds]);
      await client.query(`DELETE FROM share_grants WHERE file_id = ANY($1)`, [allIds]);
      await client.query(`DELETE FROM files WHERE id = ANY($1) AND is_deleted = TRUE`, [allIds]);
    }
    if (allDirIds.length > 0) {
      await client.query(`DELETE FROM directories WHERE id = ANY($1) AND is_deleted = TRUE`, [allDirIds]);
    }
  });
  for (const [ownerId, delta] of deltaByOwner) {
    if (delta !== 0) await applyUsedDelta(ownerId, delta);
  }

  // 5. 缓存失效
  const invalidateIds: (string | null)[] = [...topDirIds, ...allDirIds];
  await invalidateDirCache(user, ...invalidateIds);
  return allFiles.length;
}

async function purgeObjectAndRows(client: { query: typeof query }, file: FileRow): Promise<void> {
  const versions = await client.query<{ version_id: string }>(`SELECT version_id FROM file_versions WHERE file_id = $1`, [file.id]);
  if (file.dedup_ref) {
    // 去重共享引用：仅当无其他文件仍引用该池对象时才删除对象，并清理池记录
    const refs = await client.query<{ c: string }>(
      `SELECT COUNT(*)::int AS c FROM files WHERE org_id = $1 AND object_key = $2 AND id <> $3`,
      [file.org_id, file.object_key, file.id]
    );
    if (Number(refs.rows[0]?.c ?? 0) === 0) {
      await removeObjectAllVersions(file.object_key, versions.rows.map((v) => v.version_id));
      await client.query(`DELETE FROM dedup_pool WHERE org_id = $1 AND sha256 = $2`, [file.org_id, file.sha256]);
    }
  } else {
    await removeObjectAllVersions(file.object_key, versions.rows.map((v) => v.version_id));
    // 注：真实上传文件不清理其池副本——池作为去重缓存保留（支持删除后重传秒传）；
    //     零引用池由每日 GC（POOL_GC_DAYS 后）统一清理，限界存储增长（见 gcOrphanPools）
  }
  await client.query(`DELETE FROM file_versions WHERE file_id = $1`, [file.id]);
  await client.query(`DELETE FROM files WHERE id = $1`, [file.id]);
  await client.query(`DELETE FROM share_grants WHERE file_id = $1`, [file.id]);
  await applyUsedDelta(file.owner_id, -file.size_bytes);
}

/**
 * 去重池 GC：清理超过保留期（POOL_GC_DAYS）且无任何文件引用的池记录及其对象。
 * 池是去重缓存（支持删除后重传秒传），但若长期无引用则回收存储。
 */
export async function gcOrphanPools(): Promise<number> {
  const expired = await query<{ org_id: string; sha256: string; size_bytes: string }>(
    `SELECT p.org_id, p.sha256, p.size_bytes FROM dedup_pool p
     WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.object_key = p.org_id || '/_dedup/' || p.sha256)
       AND p.created_at < now() - make_interval(days => $1)`,
    [config.poolGcDays]
  );
  let count = 0;
  for (const p of expired.rows) {
    try {
      await removeObjectAllVersions(dedupKey(p.org_id, p.sha256));
      await query(`DELETE FROM dedup_pool WHERE org_id = $1 AND sha256 = $2`, [p.org_id, p.sha256]);
      count++;
    } catch (err) {
      logger.warn('gcOrphanPools remove failed', { sha256: p.sha256.slice(0, 12), message: (err as Error).message });
    }
  }
  if (count > 0) {
    logger.info('gcOrphanPools', { count, sizeBytes: expired.rows.reduce((s, r) => s + Number(r.size_bytes), 0) });
  }
  return count;
}

export async function listTrash(
  user: AuthedUser,
  opts: { offset?: number; limit?: number } = {}
): Promise<{ items: FileListItem[]; total: number }> {
  const isAdmin = user.role === ROLES.ADMIN;
  const where = isAdmin ? 'org_id = $1' : 'owner_id = $1';
  const params = [isAdmin ? user.orgId : user.id];
  // 分页：目录 + 文件统一排序（deleted_at DESC），跨表合并分页（LIMIT 2000 兼容旧调用）
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(5000, Math.max(1, opts.limit ?? 2000));
  // 总数（回收站展示/清空进度用）
  const [fc, dc] = await Promise.all([
    query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM files WHERE ${where} AND is_deleted = TRUE`, params),
    query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM directories WHERE ${isAdmin ? 'org_id' : 'owner_id'} = $1 AND is_deleted = TRUE`, params),
  ]);
  const total = Number(fc.rows[0]?.c ?? 0) + Number(dc.rows[0]?.c ?? 0);
  // 两类各取「offset+limit」后按 deleted_at 归并截断（offset 越界返回空）
  const take = offset + limit;
  const [files, dirs] = await Promise.all([
    query<FileRow>(
      `SELECT * FROM files WHERE ${where} AND is_deleted = TRUE ORDER BY deleted_at DESC LIMIT $2`,
      [...params, take]
    ),
    query<DirectoryRow>(
      `SELECT * FROM directories WHERE ${isAdmin ? 'org_id' : 'owner_id'} = $1 AND is_deleted = TRUE ORDER BY deleted_at DESC LIMIT $2`,
      [...params, take]
    ),
  ]);
  type Merged = { deletedAt: number; kind: 'dir' | 'file'; dto: FileListItem };
  const merged: Merged[] = [
    ...dirs.rows.map((d) => ({ deletedAt: d.deleted_at?.getTime() ?? 0, kind: 'dir' as const, dto: dirToDto(d) })),
    ...files.rows.map((f) => ({ deletedAt: f.deleted_at?.getTime() ?? 0, kind: 'file' as const, dto: fileToDto(f) })),
  ];
  merged.sort((a, b) => b.deletedAt - a.deletedAt);
  const items = merged.slice(offset, offset + limit).map((m) => m.dto);
  return { items, total };
}

async function getOrgRoot(orgId: string): Promise<DirectoryRow> {
  const root = await queryOne<DirectoryRow>(
    `SELECT * FROM directories WHERE org_id = $1 AND scope = $2 AND parent_id IS NULL AND is_deleted = FALSE LIMIT 1`,
    [orgId, DIR_SCOPES.ORG]
  );
  if (!root) throw ApiError.notFound('企业公共盘根目录不存在');
  return root;
}

// ---------- 版本管理 ----------

export async function listVersions(user: AuthedUser, fileId: string): Promise<{ current: FileListItem; versions: FileVersionRow[] }> {
  const file = await requireFileAccess(user, fileId, 'read');
  const versions = await query<FileVersionRow>(
    `SELECT * FROM file_versions WHERE file_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [fileId]
  );
  return { current: fileToDto(file), versions: versions.rows };
}

export async function rollbackVersion(user: AuthedUser, fileId: string, versionId: string): Promise<FileRow> {
  const file = await requireFileAccess(user, fileId, 'write');
  const ver = await queryOne<FileVersionRow>('SELECT * FROM file_versions WHERE file_id = $1 AND version_id = $2', [fileId, versionId]);
  if (!ver) throw ApiError.notFound('版本不存在');
  if (!ver.version_id) throw ApiError.badRequest('去重秒传文件无独立版本，不支持回滚（重新上传即可）');
  if (ver.version_id === file.version_id) throw ApiError.badRequest('该版本已是当前版本');
  const result = await copyObject(file.object_key, file.object_key, ver.version_id);
  await query(
    `UPDATE files SET version_id = $2, size_bytes = $3, sha256 = $4, updated_at = now() WHERE id = $1`,
    [fileId, result.versionId, ver.size_bytes, ver.sha256]
  );
  await query(
    `INSERT INTO file_versions (file_id, object_key, version_id, size_bytes, sha256, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [fileId, file.object_key, result.versionId, ver.size_bytes, ver.sha256, user.id]
  );
  return (await queryOne<FileRow>('SELECT * FROM files WHERE id = $1', [fileId]))!;
}

// ---------- 下载 / 预览（签名 URL） ----------

export async function getDownloadUrl(user: AuthedUser, fileId: string): Promise<string> {
  const file = await requireFileAccess(user, fileId, 'read');
  return presignGet(file.object_key, config.minio.presignExpiry, {
    'response-content-disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
  });
}

// 文件夹 zip 打包下载上限（防滥用；超出返回错误）
const MAX_ZIP_FILES = 10000;

/**
 * 文件夹 zip 流式下载：遍历目录树收集文件，逐个从 MinIO 流式读入 archiver，pipe 到响应。
 * 相对路径保持目录结构（zip 内为 目录名/子目录/文件）。
 */
export async function streamDirZip(user: AuthedUser, dirId: string, res: Response): Promise<void> {
  const { dir, rights } = await resolveDirAccess(user, dirId);
  if (!rights.read) throw ApiError.forbidden('无权访问该目录');

  const subtree = await query<{ id: string; path: string; name: string }>(
    `SELECT id, name, path FROM directories WHERE path = $1 OR path LIKE $1 || '%'`,
    [dir.path]
  );
  const nameById = new Map(subtree.rows.map((d) => [d.id, d.name]));
  const zip = new archiverMod.ZipArchive();
  const top = dir.name; // zip 内顶层目录名（压缩软件习惯：压缩包内含顶层文件夹）
  let count = 0;
  try {
    for (const d of subtree.rows) {
      // 相对路径：物化 path 是 id 链，转换为名字链（sub/ 而非 <uuid>/）
      const relIds = d.path.startsWith(dir.path) ? d.path.slice(dir.path.length).split('/').filter(Boolean) : [];
      const relDir = relIds.map((id) => nameById.get(id) ?? id).join('/');
      const files = await query<FileRow>(
        `SELECT * FROM files WHERE dir_id = $1 AND is_deleted = FALSE ORDER BY name`,
        [d.id]
      );
      if (files.rows.length === 0 && relDir) {
        // 空目录：保留结构
        zip.append('', { name: `${top}/${relDir}/` });
        continue;
      }
      for (const f of files.rows) {
        count += 1;
        if (count > MAX_ZIP_FILES) {
          zip.destroy();
          res.destroy(new Error('文件夹文件过多，请分批下载'));
          return;
        }
        const entryPath = `${top}/${relDir ? relDir + '/' : ''}${f.name}`;
        const stream = await getObjectStream(f.object_key);
        zip.append(stream, { name: entryPath });
      }
    }
  } catch (err) {
    logger.warn('dir zip failed', { dirId, message: (err as Error).message });
    throw err;
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(dir.name + '.zip')}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  zip.pipe(res);
  await zip.finalize();
  await new Promise<void>((resolve) => res.on('finish', resolve));
  logger.info('dir zip downloaded', { dirId, files: count });
}

// 预览 MIME 映射（按扩展名强制正确 Content-Type，不依赖上传时记录的 mime_type）
const PREVIEW_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo', m4v: 'video/x-m4v',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', json: 'application/json', xml: 'application/xml',
};

export async function getPreviewUrl(user: AuthedUser, fileId: string): Promise<{ url: string; file: FileRow }> {
  const file = await requireFileAccess(user, fileId, 'read');
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  const contentType = PREVIEW_MIME[ext] || file.mime_type || 'application/octet-stream';
  return {
    url: await presignGet(file.object_key, config.minio.presignExpiry, { 'response-content-type': contentType }),
    file,
  };
}

// ---------- 上传（单请求 / 分片断点续传） ----------

export interface UploadInitResult {
  dedup: boolean;
  session?: { id: string; mode: number; partSize: number; totalParts: number };
  presignedUrl?: string;
  file?: FileListItem;
}

export async function initUpload(
  user: AuthedUser,
  input: { dirId: string; name: string; size: number; sha256?: string; mimeType?: string }
): Promise<UploadInitResult> {
  validateFileName(input.name);
  const dir = await requireDirAccess(user, input.dirId, 'write');
  const size = Math.max(0, Math.floor(input.size || 0));
  const sha256 = (input.sha256 || '').toLowerCase();
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) throw ApiError.badRequest('sha256 格式不合法');

  // 同名文件已存在 -> 允许覆盖：complete 阶段作为「新版本」写入（MinIO 版本控制保留历史，可回滚）
  const existing = await queryOne<FileRow>('SELECT * FROM files WHERE dir_id = $1 AND name = $2 AND is_deleted = FALSE', [input.dirId, input.name]);
  const isOverwrite = Boolean(existing);

  // 同名且内容一致（哈希相同）：无需上传、不产生新版本，直接秒传成功
  //
  // v1.1.14 加固：**秒传前必须确认对象真的还在**。历史实现只看数据库哈希就返回 dedup=true，
  // 一旦 MinIO 对象因误删/清理/迁移而缺失，就会把"内容其实已经没了"的文件判为秒传成功——
  // 用户界面上看到上传完成，下载却 404（2026-09-17 整桶误删后的重传场景会 100% 踩中）。
  // 现在：对象不存在 → 不秒传，继续走真实上传（覆盖语义下用的还是同一个 object_key）。
  if (isOverwrite && sha256 && existing!.sha256 === sha256) {
    if (await objectExists(existing!.object_key)) {
      return { dedup: true, file: fileToDto(existing!) };
    }
    logger.warn('同名同哈希但 MinIO 对象缺失，放弃秒传改走真实上传', {
      fileId: existing!.id,
      objectKey: existing!.object_key,
      dedupRef: existing!.dedup_ref,
    });
  }

  // 配额校验（覆盖时按增量计算；新增按全量）
  const delta = isOverwrite ? size - Number(existing!.size_bytes) : size;
  await checkQuota(user.id, delta);

  const ext = input.name.includes('.') ? input.name.split('.').pop()!.toLowerCase() : '';
  // 覆盖场景复用原对象 Key（MinIO 版本控制在同一 Key 下保留历史版本，支持回滚）；
  // 若原文件是去重引用（object_key 指向共享池对象），覆盖必须改用独立 Key，避免污染池对象；
  // 新增场景使用随机 UUID 作为文件 ID 与对象 Key
  const fileId = isOverwrite ? existing!.id : crypto.randomUUID();
  const key = isOverwrite
    ? existing!.dedup_ref
      ? objectKey(user.orgId, existing!.id)
      : existing!.object_key
    : objectKey(user.orgId, fileId);
  const metaData: Record<string, string> = {
    // 元数据头值必须 ASCII 安全：中文等非 Latin-1 字符直接放 HTTP 头会 ERR_INVALID_CHAR
    // （Node http 拒绝；分片上传 createMultipart 为后端请求，必现 500）。URI 编码存 MinIO。
    'x-amz-meta-name': encodeURIComponent(input.name),
    'x-amz-meta-owner': user.id,
    'x-amz-meta-org': user.orgId,
    'Content-Type': input.mimeType || 'application/octet-stream',
  };
  if (sha256) metaData['x-amz-meta-sha256'] = sha256;

  // 去重秒传（不限文件大小）：命中去重池 -> 文件元数据零拷贝引用池对象（纯元数据操作）
  //   - 池已验证(verified)：直接毫秒级秒传
  //   - 池未就绪/未验证：小/中文件（<= DEDUP_INLINE_MAX）等待在途后台任务或在线校验；超大文件不等待，走普通上传
  //   - 同名覆盖场景跳过（走新版本语义，避免污染池对象）
  if (sha256 && size > 0 && !isOverwrite) {
    const dedupFile = await tryDedupHit(user, sha256, size, input.dirId, input.name, ext, input.mimeType || 'application/octet-stream', fileId);
    if (dedupFile) {
      return { dedup: true, file: dedupFile };
    }
  }

  const mode = size <= config.smallFileThreshold ? 1 : 2;
  // 会话 ID：新增时即文件 ID（complete 直接落库）；覆盖时用新随机 UUID（文件 ID 保持原值）
  const sessionId = isOverwrite ? crypto.randomUUID() : fileId;

  if (mode === 1) {
    // 单请求直传：后端签发 PUT 签名 URL
    const url = await presignPut(key);
    await query(
      `INSERT INTO upload_sessions (id, org_id, user_id, dir_id, file_name, file_size, sha256, object_key, mode, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 0)`,
      [sessionId, user.orgId, user.id, input.dirId, input.name, size, sha256, key]
    );
    return { dedup: false, session: { id: sessionId, mode, partSize: 0, totalParts: 1 }, presignedUrl: url };
  }

  // 分片上传：创建 MinIO Multipart，返回 uploadId（断点续传依据）
  const uploadId = await createMultipart(key, metaData);
  const totalParts = size > 0 ? Math.ceil(size / config.partSize) : 1;
  await query(
    `INSERT INTO upload_sessions (id, org_id, user_id, dir_id, file_name, file_size, sha256, object_key, upload_id, mode, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 2, 0)`,
    [sessionId, user.orgId, user.id, input.dirId, input.name, size, sha256, key, uploadId]
  );
  return { dedup: false, session: { id: sessionId, mode, partSize: config.partSize, totalParts } };
}

export async function presignUploadParts(user: AuthedUser, sessionId: string, partNumbers: number[]): Promise<Array<{ partNumber: number; url: string; expires: number }>> {
  const session = await queryOne<UploadSessionRow>('SELECT * FROM upload_sessions WHERE id = $1', [sessionId]);
  if (!session || session.user_id !== user.id) throw ApiError.notFound('上传会话不存在');
  if (session.status !== 0) throw ApiError.badRequest('上传会话已结束');
  if (session.mode !== 2) throw ApiError.badRequest('该会话不支持分片');
  const unique = [...new Set(partNumbers)].filter((n) => n >= 1);
  const expiry = config.minio.presignExpiry;
  const urls = await Promise.all(
    unique.map(async (n) => ({
      partNumber: n,
      url: await presignPartPut(session.object_key, session.upload_id, n, expiry),
      expires: expiry,
    }))
  );
  return urls;
}

/**
 * 上报已上传分片号（断点续传服务端登记，v1.1 第三轮 3.2）
 * 客户端在分片 PUT 完成后批量上报；服务端合并进 uploaded_parts（去重）
 * 用于跨设备/清 localStorage 后恢复：GET /upload/parts 可查询已传分片
 */
export async function reportUploadedParts(user: AuthedUser, sessionId: string, partNumbers: number[]): Promise<{ uploaded: number[] }> {
  const session = await queryOne<UploadSessionRow>('SELECT * FROM upload_sessions WHERE id = $1', [sessionId]);
  if (!session || session.user_id !== user.id) throw ApiError.notFound('上传会话不存在');
  if (session.status !== 0) throw ApiError.badRequest('上传会话已结束');
  const unique = [...new Set(partNumbers)].filter((n) => Number.isInteger(n) && n >= 1);
  if (unique.length === 0) return { uploaded: session.uploaded_parts ?? [] };
  // 合并去重（避免并发覆盖）：读-改-写
  const merged = [...new Set([...(session.uploaded_parts ?? []), ...unique])];
  await query(`UPDATE upload_sessions SET uploaded_parts = $2, updated_at = now() WHERE id = $1`, [sessionId, merged]);
  return { uploaded: merged };
}

/** 查询已上传分片号（断点续传恢复入口，v1.1 第三轮 3.2） */
export async function getUploadedParts(user: AuthedUser, sessionId: string): Promise<{ uploaded: number[]; totalParts: number; partSize: number; size: number }> {
  const session = await queryOne<UploadSessionRow>('SELECT * FROM upload_sessions WHERE id = $1', [sessionId]);
  if (!session || session.user_id !== user.id) throw ApiError.notFound('上传会话不存在');
  return {
    uploaded: session.uploaded_parts ?? [],
    totalParts: session.file_size > 0 ? Math.ceil(Number(session.file_size) / config.partSize) : 1,
    partSize: config.partSize,
    size: Number(session.file_size),
  };
}

export async function completeUpload(user: AuthedUser, sessionId: string, clientParts?: PartInfo[]): Promise<FileListItem> {
  const session = await queryOne<UploadSessionRow>('SELECT * FROM upload_sessions WHERE id = $1', [sessionId]);
  if (!session || session.user_id !== user.id) throw ApiError.notFound('上传会话不存在');
  if (session.status !== 0) throw ApiError.badRequest('上传会话已结束');

  let size = 0;
  let etag = '';
  let versionId: string | undefined;

  if (session.mode === 1) {
    const stat = await statObject(session.object_key);
    size = stat.size;
    etag = stat.etag;
    versionId = stat.versionId;
  } else {
    // 分片：客户端回传各分片 ETag（来自 PUT 响应头），MinIO 侧校验一致性
    if (!clientParts || clientParts.length === 0) {
      // 注意：不再 abortMultipart——客户端可能只是「分片清单为空」（服务端占位分片/并发竞态），
      // 中止会销毁仍可恢复的分片数据；会话交由每日定时任务清理。
      throw ApiError.badRequest('缺少已上传分片信息');
    }
    const parts = [...clientParts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      const result = await completeMultipart(
        session.object_key,
        session.upload_id,
        parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
      );
      etag = result.etag;
      const stat = await statObject(session.object_key);
      size = stat.size;
      versionId = stat.versionId;
    } catch (err) {
      // 幂等自愈（v1.1.8）：NoSuchUpload = 该 uploadId 在 MinIO 侧已不存在，
      // 常见于「重复 complete」——客户端暂停/超时后重试、网络重发、并发提交。
      // 若对象已存在且大小与声明一致，说明分片其实已合并成功 → 视为已完成继续落库，
      // 而不是返回 500 让任务永久失败（这正是用户看到的「上传卡住 / 服务内部错误」）。
      const code = (err as { code?: string }).code;
      const st = code === 'NoSuchUpload' ? await statObject(session.object_key).catch(() => null) : null;
      const declared = Number(session.file_size);
      if (st && (declared === 0 ? st.size > 0 : st.size === declared)) {
        logger.warn('completeUpload: NoSuchUpload 但对象已存在，按已完成处理', {
          session: session.id,
          key: session.object_key,
          size: st.size,
        });
        etag = st.etag;
        size = st.size;
        versionId = st.versionId;
      } else {
        throw err;
      }
    }
  }

  // 大小校验：客户端声明的大小必须与实际一致（PG BIGINT 返回为字符串，需归一为数字）
  const declaredSize = Number(session.file_size);
  if (declaredSize > 0 && size !== declaredSize) {
    logger.warn('upload size mismatch', { session: session.id, expect: declaredSize, actual: size });
    await removeObjectAllVersions(session.object_key);
    await query(`UPDATE upload_sessions SET status = 3 WHERE id = $1`, [session.id]);
    throw ApiError.badRequest('上传文件大小与声明不一致，已终止');
  }

  // 服务端哈希校验（小文件）：保证去重与审计可信（BLAKE3 并行计算；通过后写段哈希缓存供池校验复用）
  let finalSha = session.sha256;
  if (session.sha256 && size <= config.verifyShaThreshold) {
    const realHash = await computeObjectHash(session.object_key, size, { orgId: user.orgId, expectedSha: session.sha256 });
    if (realHash !== session.sha256) {
      await removeObjectAllVersions(session.object_key);
      await query(`UPDATE upload_sessions SET status = 3 WHERE id = $1`, [session.id]);
      throw ApiError.badRequest('文件哈希校验失败，已终止上传');
    }
    finalSha = realHash;
  }

  const ext = session.file_name.includes('.') ? session.file_name.split('.').pop()!.toLowerCase() : '';

  // 事务主体：查重 -> 新增或同名覆盖（新版本）。并发同名竞态（23505）会在 PG 中使事务进入
  // aborted 状态，无法在同一事务内继续执行；故由外层 catch 回滚后在新事务中重试一次
  // （此时查重可命中另一事务已提交的行 -> 走覆盖分支），保证绝不返回 500。
  const txBody = async (client: { query: typeof query }): Promise<FileRow> => {
    const existing = await client.query<FileRow>(
      `SELECT * FROM files WHERE dir_id = $1 AND name = $2 AND is_deleted = FALSE`,
      [session.dir_id, session.file_name]
    );
    let file: FileRow;
    if (existing.rows.length > 0) {
      // 同名覆盖 -> 新版本（MinIO 版本控制保留历史）；脱离去重共享引用改为独立对象
      const old = existing.rows[0];
      await client.query(
        `UPDATE files SET object_key = $2, size_bytes = $3, sha256 = $4, version_id = $5, dedup_ref = FALSE, updated_at = now() WHERE id = $1`,
        [old.id, session.object_key, size, finalSha, versionId]
      );
      await applyUsedDelta(user.id, size - Number(old.size_bytes));
      file = (await client.query<FileRow>('SELECT * FROM files WHERE id = $1', [old.id])).rows[0];
    } else {
      const r = await client.query<FileRow>(
        `INSERT INTO files (id, org_id, dir_id, owner_id, name, ext, mime_type, size_bytes, sha256, object_key, version_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [session.id, user.orgId, session.dir_id, user.id, session.file_name, ext, 'application/octet-stream', size, finalSha, session.object_key, versionId]
      );
      await applyUsedDelta(user.id, size);
      file = r.rows[0];
    }
    await client.query(
      `INSERT INTO file_versions (file_id, object_key, version_id, size_bytes, sha256, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [file.id, file.object_key, versionId, size, finalSha, user.id]
    );
    await client.query(`UPDATE upload_sessions SET status = 1, updated_at = now() WHERE id = $1`, [session.id]);
    return file;
  };

  let result: FileRow;
  try {
    result = await withTransaction((client) => txBody(client));
  } catch (err) {
    // 并发同名竞态：唯一约束 23505 -> 事务已 aborted，回滚后重试一次（新事务命中覆盖分支）
    if ((err as { code?: string }).code === '23505') {
      logger.warn('completeUpload concurrent same-name conflict, retrying as overwrite', {
        dirId: session.dir_id, name: session.file_name,
      });
      result = await withTransaction((client) => txBody(client));
    } else {
      throw err;
    }
  }

  // 目录列表缓存失效：上传落库后立即可见（若期间被缓存）
  await invalidateDirCache(user, session.dir_id);

  // 入库去重池（不限大小）：后续相同文件秒传
  //   - 大文件：登记未验证 + 后台异步拷贝校验（complete 不阻塞；池就绪后重复上传自动秒传）
  //   - 小/中文件（<= verifyShaThreshold）：哈希已在 complete 中由服务端重算验证（可信），
  //     池注册（拷贝对象）走后台异步，complete 立即返回——避免每次上传都同步 MinIO 拷贝拖慢
  //     大批量小文件上传；同进程重复上传经 tryDedupHit 等待在途任务，池就绪后仍可秒传
  if (finalSha && size > 0) {
    const poolKey = dedupKey(user.orgId, finalSha);
    const registered = await queryOne('SELECT 1 FROM dedup_pool WHERE org_id = $1 AND sha256 = $2', [user.orgId, finalSha]);
    if (!registered) {
      if (size <= config.verifyShaThreshold) {
        // 小/中文件：登记（verified=FALSE 先占位，防并发重复注册）后异步拷贝+校验
        try {
          await query(
            `INSERT INTO dedup_pool (org_id, sha256, size_bytes, verified) VALUES ($1, $2, $3, FALSE)
             ON CONFLICT (org_id, sha256) DO UPDATE SET size_bytes = EXCLUDED.size_bytes`,
            [user.orgId, finalSha, size]
          );
        } catch (err) {
          logger.warn('dedup pool register row failed', { message: (err as Error).message });
        }
        // 后台异步：拷贝对象入池 + 校验哈希 + 置 verified（哈希已在 complete 验证，校验走段缓存极快）
        schedulePoolRegistration(user.orgId, finalSha, session.object_key);
      } else {
        try {
          await query(
            `INSERT INTO dedup_pool (org_id, sha256, size_bytes, verified) VALUES ($1, $2, $3, FALSE)
             ON CONFLICT (org_id, sha256) DO UPDATE SET size_bytes = EXCLUDED.size_bytes`,
            [user.orgId, finalSha, size]
          );
        } catch (err) {
          logger.warn('dedup pool register row failed', { message: (err as Error).message });
        }
        // 后台异步：拷贝对象入池 + 校验哈希 + 置 verified（客户端哈希不可直接信任）
        schedulePoolRegistration(user.orgId, finalSha, session.object_key);
      }
    }
  }

  return fileToDto(result);
}

export async function abortUpload(user: AuthedUser, sessionId: string): Promise<void> {
  const session = await queryOne<UploadSessionRow>('SELECT * FROM upload_sessions WHERE id = $1', [sessionId]);
  if (!session || session.user_id !== user.id) return;
  if (session.status !== 0) return;
  if (session.mode === 2 && session.upload_id) {
    await abortMultipart(session.object_key, session.upload_id);
  } else {
    await removeObjectAllVersions(session.object_key).catch(() => undefined);
  }
  await query(`UPDATE upload_sessions SET status = 2, updated_at = now() WHERE id = $1`, [session.id]);
}

// ---------- 内部授权（share_grants） ----------

export async function listGrants(user: AuthedUser, id: string, type: 'file' | 'dir'): Promise<unknown[]> {
  const col = type === 'file' ? 'file_id' : 'dir_id';
  if (type === 'file') await requireFileAccess(user, id, 'read');
  else await requireDirAccess(user, id, 'read');
  return (await query(`SELECT * FROM share_grants WHERE ${col} = $1 ORDER BY created_at DESC`, [id])).rows;
}

export async function addGrant(
  user: AuthedUser,
  input: { fileId?: string; dirId?: string; targetType: number; targetId: string; canWrite: boolean; canDelete: boolean }
): Promise<void> {
  if (!input.fileId && !input.dirId) throw ApiError.badRequest('必须指定文件或目录');
  const validTypes: number[] = [TARGET_TYPES.USER, TARGET_TYPES.DEPT, TARGET_TYPES.ORG];
  if (!validTypes.includes(input.targetType)) {
    throw ApiError.badRequest('授权目标类型不合法');
  }
  if (input.fileId) {
    await requireFileAccess(user, input.fileId, 'share');
    await query(
      `INSERT INTO share_grants (org_id, file_id, target_type, target_id, can_write, can_delete, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [user.orgId, input.fileId, input.targetType, input.targetId, input.canWrite, input.canDelete, user.id]
    );
  } else {
    await requireDirAccess(user, input.dirId!, 'share');
    await query(
      `INSERT INTO share_grants (org_id, dir_id, target_type, target_id, can_write, can_delete, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [user.orgId, input.dirId, input.targetType, input.targetId, input.canWrite, input.canDelete, user.id]
    );
  }
}

export async function removeGrant(user: AuthedUser, grantId: string): Promise<void> {
  const grant = await queryOne<{ file_id: string | null; dir_id: string | null }>('SELECT file_id, dir_id FROM share_grants WHERE id = $1', [grantId]);
  if (!grant) throw ApiError.notFound('授权不存在');
  if (grant.file_id) await requireFileAccess(user, grant.file_id, 'share');
  else await requireDirAccess(user, grant.dir_id!, 'share');
  await query(`DELETE FROM share_grants WHERE id = $1`, [grantId]);
}

// ---------- 目录 ACL ----------

export async function listAcls(user: AuthedUser, dirId: string): Promise<unknown[]> {
  await requireDirAccess(user, dirId, 'read');
  return (await query(`SELECT * FROM acls WHERE dir_id = $1 ORDER BY created_at DESC`, [dirId])).rows;
}

export async function upsertAcl(
  user: AuthedUser,
  input: { dirId: string; targetType: number; targetId: string; canRead: boolean; canWrite: boolean; canDelete: boolean; canShare: boolean }
): Promise<void> {
  await requireDirAccess(user, input.dirId, 'write');
  const validTypes: number[] = [TARGET_TYPES.USER, TARGET_TYPES.DEPT, TARGET_TYPES.ORG];
  if (!validTypes.includes(input.targetType)) {
    throw ApiError.badRequest('授权目标类型不合法');
  }
  await query(
    `INSERT INTO acls (dir_id, target_type, target_id, can_read, can_write, can_delete, can_share, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (dir_id, target_type, target_id)
     DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write,
                   can_delete = EXCLUDED.can_delete, can_share = EXCLUDED.can_share`,
    [input.dirId, input.targetType, input.targetId, input.canRead, input.canWrite, input.canDelete, input.canShare, user.id]
  );
}

export async function removeAcl(user: AuthedUser, aclId: number): Promise<void> {
  const acl = await queryOne<{ dir_id: string }>('SELECT dir_id FROM acls WHERE id = $1', [aclId]);
  if (!acl) throw ApiError.notFound('ACL 不存在');
  await requireDirAccess(user, acl.dir_id, 'write');
  await query(`DELETE FROM acls WHERE id = $1`, [aclId]);
}

export { fileToDto, dirToDto };
