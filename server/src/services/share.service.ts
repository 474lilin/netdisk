// =============================================================================
// 分享服务：内网分享链接（密码/有效期/次数） + 内部人员授权（share_grants）
// 私有化约束：链接仅在内网可达，禁止外网暴露（部署层通过防火墙保证）
// =============================================================================
import crypto from 'node:crypto';
import { query, queryOne } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { presignGet } from '../lib/minio.js';
import { config } from '../config/index.js';
import { cacheGet, cacheSet, cacheDel } from '../lib/cache.js';
import { DIR_SCOPES, type DirectoryRow, type FileListItem, type FileRow, type ShareLinkDto, type ShareLinkRow } from '../types/index.js';
import { requireDirAccess, requireFileAccess } from './permission.service.js';
import type { AuthedUser } from '../middleware/auth.js';

function newToken(): string {
  return crypto.randomBytes(12).toString('base64url');
}

export async function createShare(
  user: AuthedUser,
  input: { fileId?: string; dirId?: string; password?: string; expiresAt?: string | null; maxAccessCount?: number; allowDownload?: boolean }
): Promise<ShareLinkDto> {
  if (!input.fileId && !input.dirId) throw ApiError.badRequest('必须指定文件或目录');
  if (input.password !== undefined && input.password.length > 0 && input.password.length < 4) {
    throw ApiError.badRequest('分享密码至少 4 位');
  }
  let targetName = '';
  let isDir = false;
  if (input.fileId) {
    const file = await requireFileAccess(user, input.fileId, 'share');
    targetName = file.name;
  } else {
    const dir = await requireDirAccess(user, input.dirId!, 'share');
    targetName = dir.name;
    isDir = true;
  }

  const token = newToken();
  const passwordHash = input.password ? await hashPassword(input.password) : '';
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw ApiError.badRequest('有效期必须晚于当前时间');
  }
  const r = await query<ShareLinkRow>(
    `INSERT INTO share_links (org_id, token, file_id, dir_id, password_hash, expires_at, max_access_count, allow_download, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      user.orgId,
      token,
      input.fileId ?? null,
      input.dirId ?? null,
      passwordHash,
      expiresAt,
      input.maxAccessCount ?? 0,
      input.allowDownload ?? true,
      user.id,
    ]
  );
  const row = r.rows[0];
  return shareToDto(row, targetName, isDir);
}

export function shareUrl(token: string): string {
  return `/share/${token}`;
}

function shareToDto(row: ShareLinkRow, targetName: string, isDir: boolean): ShareLinkDto {
  return {
    id: row.id,
    token: row.token,
    url: shareUrl(row.token),
    targetName,
    isDir,
    hasPassword: Boolean(row.password_hash),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    maxAccessCount: Number(row.max_access_count),
    accessCount: Number(row.access_count),
    allowDownload: row.allow_download,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listMyShares(user: AuthedUser): Promise<ShareLinkDto[]> {
  const rows = await query<ShareLinkRow>(
    `SELECT * FROM share_links WHERE created_by = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 500`,
    [user.id]
  );
  const dtos: ShareLinkDto[] = [];
  for (const row of rows.rows) {
    if (row.file_id) {
      const f = await queryOne<FileRow>('SELECT name FROM files WHERE id = $1', [row.file_id]);
      dtos.push(shareToDto(row, f?.name ?? '文件已删除', false));
    } else if (row.dir_id) {
      const d = await queryOne<DirectoryRow>('SELECT name FROM directories WHERE id = $1', [row.dir_id]);
      dtos.push(shareToDto(row, d?.name ?? '目录已删除', true));
    }
  }
  return dtos;
}

export async function revokeShare(user: AuthedUser, id: string): Promise<void> {
  const row = await queryOne<ShareLinkRow>('SELECT * FROM share_links WHERE id = $1', [id]);
  if (!row) throw ApiError.notFound('分享不存在');
  if (row.created_by !== user.id && user.role !== 1) throw ApiError.forbidden('只能撤销自己创建的分享');
  await query(`UPDATE share_links SET revoked_at = now() WHERE id = $1`, [id]);
  // 撤销必须立即生效：清除该分享的元信息缓存
  await cacheDel(shareMetaKey(row.token));
}

// ---------- 公共访问（无登录，凭 token） ----------

export interface ShareMeta {
  valid: boolean;
  needPassword: boolean;
  name?: string;
  isDir?: boolean;
  size?: number;
  allowDownload?: boolean;
  expired?: boolean;
  revoked?: boolean;
  countReached?: boolean;
  createdAt?: string;
  ownerName?: string;
}

// 分享元信息缓存：静态配置（密码/有效期上限/名称/所有者等）缓存，访问计数不缓存（实时校验）
const SHARE_META_TTL = 15; // 秒；revokeShare 会立即失效，TTL 仅兜底（含到期边界）

function shareMetaKey(token: string): string {
  return `share:${token}`;
}

interface ShareMetaCache {
  needPassword: boolean;
  name: string;
  isDir: boolean;
  size: number;
  allowDownload: boolean;
  createdAt: string;
  ownerName: string;
  expiresAt: string | null;
  maxAccessCount: number;
  revokedAt: string | null;
}

export async function getShareMeta(token: string): Promise<ShareMeta> {
  // 1) 缓存命中：静态字段直接取，访问计数实时查（保证撤销/到期/次数上限判定精确）
  const cached = await cacheGet<ShareMetaCache>(shareMetaKey(token));
  if (cached) {
    if (cached.revokedAt) return { valid: false, needPassword: false, revoked: true };
    if (cached.expiresAt && new Date(cached.expiresAt) < new Date()) {
      return { valid: false, needPassword: false, expired: true };
    }
    const cnt = await queryOne<{ c: string }>('SELECT access_count::text AS c FROM share_links WHERE token = $1', [token]);
    if (!cnt) return { valid: false, needPassword: false };
    const accessCount = Number(cnt.c);
    if (cached.maxAccessCount > 0 && accessCount >= cached.maxAccessCount) {
      return { valid: false, needPassword: false, countReached: true };
    }
    return {
      valid: true,
      needPassword: cached.needPassword,
      name: cached.name,
      isDir: cached.isDir,
      size: cached.size,
      allowDownload: cached.allowDownload,
      createdAt: cached.createdAt,
      ownerName: cached.ownerName,
    };
  }

  // 2) 缓存未命中：落库查询并回填
  const row = await queryOne<ShareLinkRow>('SELECT * FROM share_links WHERE token = $1', [token]);
  if (!row) return { valid: false, needPassword: false };
  // 先快照 ISO 字符串（后续早退分支会窄化 Date 类型，导致再次访问报 never）
  const revokedAtIso = row.revoked_at ? row.revoked_at.toISOString() : null;
  const expiresAtIso = row.expires_at ? row.expires_at.toISOString() : null;
  if (row.revoked_at) return { valid: false, needPassword: false, revoked: true };
  if (row.expires_at && row.expires_at < new Date()) return { valid: false, needPassword: false, expired: true };
  if (Number(row.max_access_count) > 0 && Number(row.access_count) >= Number(row.max_access_count)) {
    return { valid: false, needPassword: false, countReached: true };
  }  const needPassword = Boolean(row.password_hash);
  let name = '';
  let isDir = false;
  let size = 0;
  if (row.file_id) {
    const f = await queryOne<FileRow>('SELECT name, size_bytes FROM files WHERE id = $1', [row.file_id]);
    name = f?.name ?? '（文件已删除）';
    size = Number(f?.size_bytes ?? 0);
  } else if (row.dir_id) {
    const d = await queryOne<DirectoryRow>('SELECT name FROM directories WHERE id = $1', [row.dir_id]);
    name = d?.name ?? '（目录已删除）';
    isDir = true;
  }
  const owner = row.created_by
    ? await queryOne<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [row.created_by])
    : null;

  const payload: ShareMetaCache = {
    needPassword,
    name,
    isDir,
    size,
    allowDownload: row.allow_download,
    createdAt: row.created_at.toISOString(),
    ownerName: owner?.display_name ?? '',
    expiresAt: expiresAtIso,
    maxAccessCount: Number(row.max_access_count),
    revokedAt: revokedAtIso,
  };
  // TTL：上限 15s；若设置了有效期则精确到到期时刻（到期即失效，不残留过期缓存）
  let ttl = SHARE_META_TTL;
  if (row.expires_at) {
    const remainSec = Math.ceil((row.expires_at.getTime() - Date.now()) / 1000);
    if (remainSec <= 0) return { valid: false, needPassword: false, expired: true };
    ttl = Math.min(ttl, remainSec);
  }
  await cacheSet(shareMetaKey(token), payload, ttl);

  return {
    valid: true,
    needPassword,
    name,
    isDir,
    size,
    allowDownload: row.allow_download,
    createdAt: row.created_at.toISOString(),
    ownerName: owner?.display_name ?? '',
  };
}

async function assertShareUsable(row: ShareLinkRow, password?: string): Promise<void> {
  if (!row) throw ApiError.notFound('分享不存在或已失效');
  if (row.revoked_at) throw ApiError.forbidden('分享已被撤销');
  if (row.expires_at && row.expires_at < new Date()) throw ApiError.forbidden('分享已过期');
  if (Number(row.max_access_count) > 0 && Number(row.access_count) >= Number(row.max_access_count)) {
    throw ApiError.forbidden('分享访问次数已达上限');
  }
  if (row.password_hash) {
    if (!password) throw ApiError.forbidden('该分享需要密码');
    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) throw ApiError.forbidden('分享密码错误');
  }
}

export async function downloadShare(token: string, password?: string, fileId?: string): Promise<{ url: string; name: string }> {
  const row = await queryOne<ShareLinkRow>('SELECT * FROM share_links WHERE token = $1', [token]);
  if (!row) throw ApiError.notFound('分享不存在或已失效');
  await assertShareUsable(row, password);

  // 目录分享：支持下载子树内任意文件（fileId 指定）
  if (row.dir_id) {
    if (!fileId) throw ApiError.badRequest('请指定要下载的文件');
    const file = await queryOne<FileRow>('SELECT * FROM files WHERE id = $1 AND is_deleted = FALSE', [fileId]);
    if (!file) throw ApiError.notFound('文件已不存在');
    const dir = await queryOne<DirectoryRow>('SELECT * FROM directories WHERE id = $1', [file.dir_id]);
    const root = await queryOne<DirectoryRow>('SELECT * FROM directories WHERE id = $1', [row.dir_id]);
    if (!dir || !root || !(dir.path === root.path || dir.path.startsWith(root.path))) {
      throw ApiError.forbidden('文件不在分享范围内');
    }
    const url = await presignGet(file.object_key, config.minio.presignExpiry, {
      'response-content-disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
    });
    await query(`UPDATE share_links SET access_count = access_count + 1 WHERE id = $1`, [row.id]);
    return { url, name: file.name };
  }

  if (!row.file_id) throw ApiError.notFound('该分享不支持直接下载');
  const file = await queryOne<FileRow>('SELECT * FROM files WHERE id = $1', [row.file_id]);
  if (!file) throw ApiError.notFound('文件已不存在');
  const url = await presignGet(file.object_key, config.minio.presignExpiry, {
    'response-content-disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
  });
  await query(`UPDATE share_links SET access_count = access_count + 1 WHERE id = $1`, [row.id]);
  return { url, name: file.name };
}

export async function listShareDir(
  token: string,
  password?: string,
  dirId?: string
): Promise<{ items: FileListItem[]; current: FileListItem | null; ancestors: FileListItem[] }> {
  const row = await queryOne<ShareLinkRow>('SELECT * FROM share_links WHERE token = $1', [token]);
  if (!row || !row.dir_id) throw ApiError.notFound('该分享不是目录分享');
  await assertShareUsable(row, password);
  const root = await queryOne<DirectoryRow>('SELECT * FROM directories WHERE id = $1', [row.dir_id]);
  if (!root) throw ApiError.notFound('目录已不存在');

  // 校验浏览目标在分享子树内
  let current = root;
  if (dirId) {
    const d = await queryOne<DirectoryRow>('SELECT * FROM directories WHERE id = $1', [dirId]);
    if (!d || !(d.path === root.path || d.path.startsWith(root.path))) {
      throw ApiError.forbidden('不在分享范围内');
    }
    current = d;
  }
  const dirs = await query<DirectoryRow>(
    `SELECT * FROM directories WHERE parent_id = $1 AND is_deleted = FALSE ORDER BY name`,
    [current.id]
  );
  const files = await query<FileRow>(
    `SELECT * FROM files WHERE dir_id = $1 AND is_deleted = FALSE ORDER BY name`,
    [current.id]
  );
  const items: FileListItem[] = [
    ...dirs.rows.map((d) => ({
      id: d.id, type: 'dir' as const, name: d.name, scope: d.scope,
      createdAt: d.created_at.toISOString(), updatedAt: d.updated_at.toISOString(),
    })),
    ...files.rows.map((f) => ({
      id: f.id, type: 'file' as const, name: f.name, ext: f.ext, mime: f.mime_type, size: Number(f.size_bytes),
      createdAt: f.created_at.toISOString(), updatedAt: f.updated_at.toISOString(),
    })),
  ];
  await query(`UPDATE share_links SET access_count = access_count + 1 WHERE id = $1`, [row.id]);

  // 祖先链（分享根 → 当前目录的父级），供前端面包屑/返回上级
  // 只返回分享子树内部分：从分享根（root.path 的最后一段）开始，不含分享范围外节点
  const ancestors: FileListItem[] = [];
  if (current.id !== root.id) {
    const ids = current.path.split('/').filter(Boolean);
    const rootIdx = root.path.split('/').filter(Boolean).length - 1; // root 自身在链中的位置
    for (let i = rootIdx; i < ids.length - 1; i++) {
      const a = await queryOne<DirectoryRow>('SELECT * FROM directories WHERE id = $1', [ids[i]]);
      if (a) ancestors.push({ id: a.id, type: 'dir', name: a.name, scope: a.scope, createdAt: a.created_at.toISOString(), updatedAt: a.updated_at.toISOString() });
    }
  }

  return {
    items,
    current: { id: current.id, type: 'dir', name: current.name, scope: current.scope, createdAt: current.created_at.toISOString(), updatedAt: current.updated_at.toISOString() },
    ancestors,
  };
}

/** 定时清理：过期分享 */
export async function cleanupExpiredShares(): Promise<number> {
  const r = await query(
    `UPDATE share_links SET revoked_at = now()
     WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at < now()
     RETURNING id`
  );
  return r.rowCount ?? 0;
}
