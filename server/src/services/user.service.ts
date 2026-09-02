// 用户管理（企业管理员）
import crypto from 'node:crypto';
import { query, queryOne } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import { ROLES, type UserRow } from '../types/index.js';
import { ensurePersonalRoot } from './org.service.js';

export async function listUsers(orgId: string, opts: { page: number; pageSize: number; q?: string }): Promise<{ items: UserRow[]; total: number }> {
  const where: string[] = ['u.org_id = $1'];
  const params: unknown[] = [orgId];
  if (opts.q) {
    params.push(`%${opts.q}%`);
    where.push(`(u.username ILIKE $${params.length} OR u.display_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
  }
  const offset = (opts.page - 1) * opts.pageSize;
  params.push(opts.pageSize, offset);
  const whereSql = where.join(' AND ');
  const count = await query<{ total: string }>(`SELECT COUNT(*)::int AS total FROM users u WHERE ${whereSql}`, params.slice(0, -2));
  const items = await query<UserRow>(
    `SELECT u.*, d.name AS dept_name FROM users u
     LEFT JOIN departments d ON d.id = u.dept_id
     WHERE ${whereSql}
     ORDER BY u.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: items.rows, total: Number(count.rows[0]?.total ?? 0) };
}

export interface CreateUserInput {
  username: string;
  displayName: string;
  email?: string;
  phone?: string;
  role: number;
  deptId?: string | null;
  quotaBytes?: number;
  initialPassword?: string;
}

export async function createUser(orgId: string, input: CreateUserInput, createdBy: string): Promise<UserRow> {
  const exist = await queryOne('SELECT id FROM users WHERE org_id = $1 AND username = $2', [orgId, input.username]);
  if (exist) throw ApiError.conflict('登录名已存在');
  if (input.deptId) {
    const dept = await queryOne('SELECT id FROM departments WHERE id = $1 AND org_id = $2', [input.deptId, orgId]);
    if (!dept) throw ApiError.notFound('部门不存在');
  }
  if (![ROLES.ADMIN, ROLES.DEPT_ADMIN, ROLES.EMPLOYEE].includes(input.role as never)) {
    throw ApiError.badRequest('角色不合法');
  }
  const passwordHash = await hashPassword(input.initialPassword || randomPassword());
  const r = await query<UserRow>(
    `INSERT INTO users (org_id, username, password_hash, display_name, email, phone, role, dept_id, quota_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      orgId,
      input.username,
      passwordHash,
      input.displayName,
      input.email ?? '',
      input.phone ?? '',
      input.role,
      input.deptId ?? null,
      input.quotaBytes ?? 0,
    ]
  );
  const user = r.rows[0];
  await ensurePersonalRoot({ query }, orgId, user.id);
  return user;
}

export interface UpdateUserInput {
  displayName?: string;
  email?: string;
  phone?: string;
  role?: number;
  deptId?: string | null;
  status?: number;
  quotaBytes?: number;
}

export async function updateUser(orgId: string, userId: string, input: UpdateUserInput, operatorId: string): Promise<void> {
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1 AND org_id = $2', [userId, orgId]);
  if (!user) throw ApiError.notFound('用户不存在');
  if (userId === operatorId && (input.status === 0 || input.role !== undefined && input.role !== user.role)) {
    throw ApiError.forbidden('不能禁用或降级自己');
  }
  if (input.role !== undefined && !input.role) {
    if (user.role === ROLES.ADMIN) {
      const admins = await queryOne<{ c: string }>('SELECT COUNT(*)::int AS c FROM users WHERE org_id = $1 AND role = 1 AND status = 1', [orgId]);
      if (Number(admins?.c ?? 0) <= 1) throw ApiError.conflict('至少保留一名企业管理员');
    }
  }
  const sets: string[] = [];
  const params: unknown[] = [userId];
  const fields: Array<[string, unknown]> = [
    ['display_name', input.displayName],
    ['email', input.email],
    ['phone', input.phone],
    ['role', input.role],
    ['dept_id', input.deptId],
    ['status', input.status],
    ['quota_bytes', input.quotaBytes],
  ];
  for (const [col, val] of fields) {
    if (val !== undefined) {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (sets.length > 0) {
    await query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  }
}

export async function resetUserPassword(userId: string, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [userId, passwordHash]);
  // 吊销该用户全部会话
  await query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}

export async function deleteUser(orgId: string, userId: string, operatorId: string): Promise<void> {
  if (userId === operatorId) throw ApiError.forbidden('不能删除自己');
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1 AND org_id = $2', [userId, orgId]);
  if (!user) throw ApiError.notFound('用户不存在');
  if (user.role === ROLES.ADMIN) {
    const admins = await queryOne<{ c: string }>('SELECT COUNT(*)::int AS c FROM users WHERE org_id = $1 AND role = 1', [orgId]);
    if (Number(admins?.c ?? 0) <= 1) throw ApiError.conflict('至少保留一名企业管理员');
  }
  const files = await queryOne<{ c: string }>('SELECT COUNT(*)::int AS c FROM files WHERE owner_id = $1', [userId]);
  if (Number(files?.c ?? 0) > 0) throw ApiError.conflict('该用户名下仍有文件，请先迁移或删除其文件');
  await query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM users WHERE id = $1`, [userId]);
}

export function randomPassword(len = 12): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^&*';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}
