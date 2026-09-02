// 存储配额：企业 / 部门 / 用户 三级限额（0 = 不限制），按"用户配额 > 部门配额 > 企业配额"取生效级别
import { query, queryOne } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { UserRow } from '../types/index.js';

export interface QuotaInfo {
  level: 'user' | 'dept' | 'org' | 'unlimited';
  limitBytes: number;
  usedBytes: number;
  userLimit: number;
  userUsed: number;
  deptLimit: number;
  deptUsed: number;
  orgLimit: number;
  orgUsed: number;
}

export async function getUserQuotaInfo(userId: string): Promise<QuotaInfo> {
  const row = await queryOne<{
    user_limit: number; user_used: number;
    dept_limit: number; dept_used: string;
    org_limit: number; org_used: string;
  }>(
    `SELECT
       u.quota_bytes AS user_limit, u.used_bytes AS user_used,
       COALESCE(d.quota_bytes, 0) AS dept_limit,
       COALESCE(SUM(CASE WHEN du.id IS NOT NULL THEN du.used_bytes END), 0)::bigint AS dept_used,
       COALESCE(o.quota_bytes, 0) AS org_limit,
       COALESCE(SUM(CASE WHEN ou.id IS NOT NULL THEN ou.used_bytes END), 0)::bigint AS org_used
     FROM users u
     LEFT JOIN departments d ON d.id = u.dept_id
     LEFT JOIN users du ON du.dept_id = u.dept_id AND du.status = 1
     LEFT JOIN orgs o ON o.id = u.org_id
     LEFT JOIN users ou ON ou.org_id = u.org_id AND ou.status = 1
     WHERE u.id = $1
     GROUP BY u.quota_bytes, u.used_bytes, d.quota_bytes, o.quota_bytes`,
    [userId]
  );
  if (!row) throw ApiError.notFound('用户不存在');

  const userLimit = Number(row.user_limit);
  const deptLimit = Number(row.dept_limit);
  const orgLimit = Number(row.org_limit);

  let level: QuotaInfo['level'] = 'unlimited';
  let limitBytes = 0;
  let usedBytes = Number(row.user_used);
  if (userLimit > 0) {
    level = 'user';
    limitBytes = userLimit;
  } else if (deptLimit > 0) {
    level = 'dept';
    limitBytes = deptLimit;
    usedBytes = Number(row.dept_used);
  } else if (orgLimit > 0) {
    level = 'org';
    limitBytes = orgLimit;
    usedBytes = Number(row.org_used);
  }

  return {
    level,
    limitBytes,
    usedBytes,
    userLimit,
    userUsed: Number(row.user_used),
    deptLimit,
    deptUsed: Number(row.dept_used),
    orgLimit,
    orgUsed: Number(row.org_used),
  };
}

export async function checkQuota(userId: string, deltaBytes: number): Promise<void> {
  if (deltaBytes <= 0) return;
  const info = await getUserQuotaInfo(userId);
  if (info.level === 'unlimited') return;
  if (info.usedBytes + deltaBytes > info.limitBytes) {
    throw ApiError.quotaExceeded(
      `存储空间不足：当前配额 ${(info.limitBytes / 1024 / 1024 / 1024).toFixed(2)} GB，已用 ${(info.usedBytes / 1024 / 1024 / 1024).toFixed(2)} GB`
    );
  }
}

/** 调整用户已用容量（上传加 / 删除减），允许为负值取 0 */
export async function applyUsedDelta(userId: string, deltaBytes: number): Promise<void> {
  if (deltaBytes === 0) return;
  await query(`UPDATE users SET used_bytes = GREATEST(used_bytes + $2, 0), updated_at = now() WHERE id = $1`, [
    userId,
    deltaBytes,
  ]);
}

/** 定时重算所有用量（兜底校正，避免异常残留）
 *  注意：回收站文件仍计入用量（删除进回收站不扣减，彻底删除才扣减），
 *  因此 SUM 必须包含全部文件（含 is_deleted=true），与实时维护语义一致。 */
export async function recomputeQuota(): Promise<void> {
  await query(
    `UPDATE users u SET used_bytes = COALESCE((SELECT SUM(f.size_bytes) FROM files f WHERE f.owner_id = u.id), 0)
     WHERE u.status = 1`
  );
  await query(
    `UPDATE orgs o SET quota_bytes = quota_bytes WHERE o.id = o.id` // no-op，保留占位
  );
  logger.info('quota recompute done');
}

export async function setUserQuota(userId: string, quotaBytes: number): Promise<void> {
  await query(`UPDATE users SET quota_bytes = $2, updated_at = now() WHERE id = $1`, [userId, quotaBytes]);
}

export async function setDeptQuota(deptId: string, quotaBytes: number): Promise<void> {
  await query(`UPDATE departments SET quota_bytes = $2, updated_at = now() WHERE id = $1`, [deptId, quotaBytes]);
}

export async function setOrgQuota(orgId: string, quotaBytes: number): Promise<void> {
  await query(`UPDATE orgs SET quota_bytes = $2, updated_at = now() WHERE id = $1`, [orgId, quotaBytes]);
}
