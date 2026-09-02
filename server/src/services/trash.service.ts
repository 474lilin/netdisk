// 回收站/审计 定时清理任务（系统级，无用户上下文）
import { query, queryOne } from '../db/pool.js';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { removeObjectAllVersions } from '../lib/minio.js';

/** 系统级审计写入（无 HTTP 上下文：回收站自动清理等定时任务留痕用）
 *  user_id 为空、来源标记 system；审计失败不阻断主流程 */
async function writeSystemAudit(
  orgId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail: Record<string, unknown>,
  fileId?: string
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, target_type, target_id, file_id, detail, ip, user_agent)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, '', 'system')`,
      [orgId, action, targetType, targetId, fileId ?? null, JSON.stringify(detail)]
    );
  } catch (err) {
    logger.warn('system audit write failed', { action, message: (err as Error).message });
  }
}

interface PurgeFileRow {
  id: string;
  org_id: string;
  name: string;
  object_key: string;
  owner_id: string;
  size_bytes: number;
  sha256: string;
  dedup_ref: boolean;
}

/** 彻底删除单个文件：去重共享引用按引用计数决定是否删对象，其余删除元数据行，并写审计日志 */
async function purgeFileRow(f: PurgeFileRow): Promise<void> {
  const versions = await query<{ version_id: string }>(`SELECT version_id FROM file_versions WHERE file_id = $1`, [f.id]);
  const removeObject = (): Promise<void> =>
    removeObjectAllVersions(f.object_key, versions.rows.map((v) => v.version_id)).catch((err) =>
      logger.warn('purge object failed', { key: f.object_key, message: (err as Error).message })
    );
  let objectRemoved = true;
  if (f.dedup_ref) {
    const refs = await query<{ c: string }>(
      `SELECT COUNT(*)::int AS c FROM files WHERE org_id = $1 AND object_key = $2 AND id <> $3`,
      [f.org_id, f.object_key, f.id]
    );
    if (Number(refs.rows[0]?.c ?? 0) === 0) {
      await removeObject();
      await query(`DELETE FROM dedup_pool WHERE org_id = $1 AND sha256 = $2`, [f.org_id, f.sha256]);
    } else {
      // 去重共享引用仍被其他文件使用：仅删元数据，对象保留
      objectRemoved = false;
    }
  } else {
    await removeObject();
  }
  await query(`DELETE FROM file_versions WHERE file_id = $1`, [f.id]);
  await query(`DELETE FROM files WHERE id = $1`, [f.id]);
  await query(`UPDATE users SET used_bytes = GREATEST(used_bytes - $2, 0) WHERE id = $1`, [f.owner_id, f.size_bytes]);
  // 审计留痕：回收站超期自动彻底删除
  await writeSystemAudit(
    f.org_id,
    'trash_purge_file',
    'file',
    f.id,
    {
      name: f.name,
      sizeBytes: f.size_bytes,
      sha256: f.sha256.slice(0, 16),
      objectRemoved,
      dedupRef: f.dedup_ref,
      retentionDays: config.trashRetentionDays,
    },
    f.id
  );
}

/** 清理超期回收站：文件与目录（含子树对象）彻底删除，逐条写审计日志 */
export async function purgeExpiredTrash(): Promise<{ files: number; dirs: number }> {
  const cutoff = new Date(Date.now() - config.trashRetentionDays * 86400_000);
  let files = 0;
  let dirs = 0;

  // 1. 超期文件
  const expiredFiles = await query<PurgeFileRow>(
    `SELECT id, org_id, name, object_key, owner_id, size_bytes, sha256, dedup_ref
     FROM files WHERE is_deleted = TRUE AND deleted_at < $1 LIMIT 500`,
    [cutoff]
  );
  for (const f of expiredFiles.rows) {
    await purgeFileRow(f);
    files += 1;
  }

  // 2. 超期目录（整棵子树）
  const expiredDirs = await query<{ id: string; path: string; name: string; org_id: string }>(
    `SELECT id, path, name, org_id FROM directories WHERE is_deleted = TRUE AND deleted_at < $1 LIMIT 200`,
    [cutoff]
  );
  for (const d of expiredDirs.rows) {
    const subtreeFiles = await query<PurgeFileRow>(
      `SELECT f.id, f.org_id, f.name, f.object_key, f.owner_id, f.size_bytes, f.sha256, f.dedup_ref FROM files f
       JOIN directories dd ON dd.id = f.dir_id
       WHERE (dd.path = $1 OR dd.path LIKE $1 || '%')`,
      [d.path]
    );
    let removed = 0;
    for (const f of subtreeFiles.rows) {
      await purgeFileRow(f);
      removed += 1;
    }
    await query(`DELETE FROM directories WHERE path = $1 OR path LIKE $1 || '%'`, [d.path]);
    dirs += 1;
    files += removed;
    await writeSystemAudit(d.org_id, 'trash_purge_dir', 'dir', d.id, {
      name: d.name,
      subtreeFiles: removed,
      retentionDays: config.trashRetentionDays,
    });
  }

  if (files > 0 || dirs > 0) {
    logger.info('trash purge done', { files, dirs });
  }
  return { files, dirs };
}

/** 清理超期审计日志 */
export async function purgeExpiredAudit(): Promise<number> {
  const cutoff = new Date(Date.now() - config.auditRetentionDays * 86400_000);
  const r = await query(`DELETE FROM audit_logs WHERE created_at < $1`, [cutoff]);
  return r.rowCount ?? 0;
}

/** 清理长时间未完成的上传会话（孤儿分片）+ 历史已完成会话（保留 30 天） */
export async function cleanupStaleUploadSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 86400_000);
  const stale = await query<{ id: string }>(
    `SELECT id FROM upload_sessions WHERE status = 0 AND updated_at < $1 LIMIT 200`,
    [cutoff]
  );
  for (const s of stale.rows) {
    await query(`UPDATE upload_sessions SET status = 2, updated_at = now() WHERE id = $1`, [s.id]);
  }
  // 历史已完成/中止会话超过 30 天直接删除（仅元数据，不影响文件）
  const oldCutoff = new Date(Date.now() - 30 * 86400_000);
  const r = await query(`DELETE FROM upload_sessions WHERE status <> 0 AND updated_at < $1`, [oldCutoff]);
  return stale.rows.length + (r.rowCount ?? 0);
}

export async function quotaSummaryByDept(orgId: string): Promise<unknown[]> {
  return (await query(
    `SELECT d.id, d.name, d.quota_bytes AS quota, COALESCE(SUM(u.used_bytes), 0)::bigint AS used
     FROM departments d LEFT JOIN users u ON u.dept_id = d.id
     WHERE d.org_id = $1 GROUP BY d.id ORDER BY d.path`,
    [orgId]
  )).rows;
}

export { queryOne };
