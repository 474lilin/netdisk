// 组织架构：企业 / 部门 / 根目录 引导与维护
import { query, queryOne, withTransaction } from '../db/pool.js';
import { config } from '../config/index.js';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { hashPassword } from '../lib/password.js';
import { DIR_SCOPES, ROLES, type DirectoryRow, type OrgRow, type UserRow } from '../types/index.js';
import { getAuthProvider } from '../ldap/provider.js';

// ---------- 引导：默认企业 / 管理员 / 根目录（幂等，首次启动执行） ----------

export async function ensureBootstrap(): Promise<void> {
  await withTransaction(async (client) => {
    // 1. 默认企业
    let org = await queryOne<OrgRow>('SELECT * FROM orgs ORDER BY created_at LIMIT 1');
    if (!org) {
      const r = await client.query<OrgRow>(
        `INSERT INTO orgs (name, code) VALUES ('默认企业', 'default') RETURNING *`
      );
      org = r.rows[0];
      logger.info('bootstrap: 默认企业已创建', { orgId: org.id });
    }

    // 2. 企业公共盘根目录
    let orgRoot = await queryOne<DirectoryRow>(
      `SELECT * FROM directories WHERE org_id = $1 AND scope = $2 AND parent_id IS NULL LIMIT 1`,
      [org.id, DIR_SCOPES.ORG]
    );
    if (!orgRoot) {
      const r = await client.query<DirectoryRow>(
        `INSERT INTO directories (org_id, name, path, scope) VALUES ($1, '企业公共盘', '', $2) RETURNING *`,
        [org.id, DIR_SCOPES.ORG]
      );
      orgRoot = r.rows[0];
      await client.query(`UPDATE directories SET path = '/' || id || '/' WHERE id = $1`, [orgRoot.id]);
      logger.info('bootstrap: 企业公共盘根目录已创建', { dirId: orgRoot.id });
    }

    // 3. 初始管理员（ADMIN_USERNAME / ADMIN_PASSWORD 驱动）
    if (!config.admin.password) {
      throw new Error('未配置 ADMIN_PASSWORD，无法引导初始管理员');
    }
    let admin = await queryOne<UserRow>(
      `SELECT * FROM users WHERE org_id = $1 AND username = $2`,
      [org.id, config.admin.username]
    );
    if (!admin) {
      const passwordHash = await hashPassword(config.admin.password);
      const r = await client.query<UserRow>(
        `INSERT INTO users (org_id, username, password_hash, display_name, role)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [org.id, config.admin.username, passwordHash, config.admin.displayName, ROLES.ADMIN]
      );
      admin = r.rows[0];
      logger.info('bootstrap: 初始管理员已创建', { userId: admin.id });
    }

    // 4. 管理员个人空间根目录
    await ensurePersonalRoot(client, org.id, admin.id);
  });
}

export async function ensurePersonalRoot(client: { query: typeof query }, orgId: string, userId: string): Promise<DirectoryRow> {
  let root = await queryOne<DirectoryRow>(
    `SELECT * FROM directories WHERE org_id = $1 AND scope = $2 AND owner_id = $3 AND parent_id IS NULL LIMIT 1`,
    [orgId, DIR_SCOPES.PRIVATE, userId]
  );
  if (!root) {
    const orgRoot = await queryOne<DirectoryRow>(
      `SELECT * FROM directories WHERE org_id = $1 AND scope = $2 AND parent_id IS NULL LIMIT 1`,
      [orgId, DIR_SCOPES.ORG]
    );
    const r = await client.query<DirectoryRow>(
      `INSERT INTO directories (org_id, parent_id, owner_id, name, path, scope, created_by)
       VALUES ($1, $2, $3, '我的空间', '', $4, $3) RETURNING *`,
      [orgId, orgRoot?.id ?? null, userId, DIR_SCOPES.PRIVATE]
    );
    root = r.rows[0];
    await client.query(`UPDATE directories SET path = '/' || id || '/' WHERE id = $1`, [root.id]);
  }
  return root;
}

// ---------- 部门 ----------

export async function createDepartment(orgId: string, name: string, parentId: string | null, quotaBytes: number, createdBy: string): Promise<{ id: string }> {
  const parent = parentId ? await queryOne<{ path: string; org_id: string }>('SELECT path, org_id FROM departments WHERE id = $1', [parentId]) : null;
  if (parentId && (!parent || parent.org_id !== orgId)) throw ApiError.notFound('上级部门不存在');
  const r = await query<{ id: string }>(
    `INSERT INTO departments (org_id, parent_id, name, path, quota_bytes) VALUES ($1, $2, $3, '', $4) RETURNING id`,
    [orgId, parentId, name, quotaBytes]
  );
  const deptId = r.rows[0].id;
  await query(`UPDATE departments SET path = $2 || id || '/' WHERE id = $1`, [deptId, parent?.path ?? '/']);
  // 部门盘根目录（挂在企业公共盘下）
  const orgRoot = await queryOne<DirectoryRow>(
    `SELECT * FROM directories WHERE org_id = $1 AND scope = $2 AND parent_id IS NULL LIMIT 1`,
    [orgId, DIR_SCOPES.ORG]
  );
  if (orgRoot) {
    const dir = await query<DirectoryRow>(
      `INSERT INTO directories (org_id, dept_id, parent_id, name, path, scope, created_by)
       VALUES ($1, $2, $3, $4, '', $5, $6) RETURNING *`,
      [orgId, deptId, orgRoot.id, name, DIR_SCOPES.DEPT, createdBy]
    );
    const d = dir.rows[0];
    await query(`UPDATE directories SET path = '/' || id || '/' WHERE id = $1`, [d.id]);
  }
  return { id: deptId };
}

export async function updateDepartment(deptId: string, data: { name?: string; quotaBytes?: number }): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [deptId];
  if (data.name !== undefined) {
    params.push(data.name);
    sets.push(`name = $${params.length}`);
  }
  if (data.quotaBytes !== undefined) {
    params.push(data.quotaBytes);
    sets.push(`quota_bytes = $${params.length}`);
  }
  if (sets.length === 0) return;
  await query(`UPDATE departments SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
}

export async function deleteDepartment(deptId: string): Promise<void> {
  const children = await queryOne<{ c: string }>('SELECT COUNT(*)::int AS c FROM departments WHERE parent_id = $1', [deptId]);
  if (Number(children?.c ?? 0) > 0) throw ApiError.conflict('请先删除子部门');
  const users = await queryOne<{ c: string }>('SELECT COUNT(*)::int AS c FROM users WHERE dept_id = $1 AND status = 1', [deptId]);
  if (Number(users?.c ?? 0) > 0) throw ApiError.conflict('请先移出该部门下的用户');
  await query('DELETE FROM departments WHERE id = $1', [deptId]);
}

export interface OrgTreeNode {
  id: string;
  name: string;
  path: string;
  quotaBytes: number;
  children: OrgTreeNode[];
  users: Array<{ id: string; username: string; displayName: string; role: number; status: number }>;
}

export interface OrgTreeResult {
  departments: OrgTreeNode[];
  unassignedUsers: Array<{ id: string; username: string; displayName: string; role: number; status: number }>;
}

export async function getOrgTree(orgId: string): Promise<OrgTreeResult> {
  const depts = await query<{ id: string; name: string; path: string; parent_id: string | null; quota_bytes: number }>(
    `SELECT id, name, path, parent_id, quota_bytes FROM departments WHERE org_id = $1 ORDER BY sort_order, created_at`,
    [orgId]
  );
  const users = await query<{ id: string; username: string; display_name: string; role: number; status: number; dept_id: string | null }>(
    `SELECT id, username, display_name, role, status, dept_id FROM users WHERE org_id = $1 ORDER BY created_at`,
    [orgId]
  );
  const byId = new Map<string, OrgTreeNode>();
  for (const d of depts.rows) {
    byId.set(d.id, { id: d.id, name: d.name, path: d.path, quotaBytes: d.quota_bytes, children: [], users: [] });
  }
  const roots: OrgTreeNode[] = [];
  for (const d of depts.rows) {
    const node = byId.get(d.id)!;
    if (d.parent_id && byId.has(d.parent_id)) {
      byId.get(d.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const unassignedUsers: OrgTreeResult['unassignedUsers'] = [];
  for (const u of users.rows) {
    const item = { id: u.id, username: u.username, displayName: u.display_name, role: u.role, status: u.status };
    const target = u.dept_id && byId.has(u.dept_id) ? byId.get(u.dept_id)! : null;
    if (target) target.users.push(item);
    else unassignedUsers.push(item);
  }
  return { departments: roots, unassignedUsers };
}

// ---------- 侧边栏根目录 ----------

export interface RootEntry {
  id: string;
  name: string;
  scope: number;
  deptId: string | null;
  icon: string;
}

/** 权限候选对象（用户/部门），供 ACL 与内部授权选择，全员可用 */
export async function getCandidates(orgId: string): Promise<{ users: Array<{ id: string; name: string; deptName: string }>; departments: Array<{ id: string; name: string }> }> {
  const users = await query<{ id: string; display_name: string; username: string; dept_name: string | null }>(
    `SELECT u.id, u.display_name, u.username, d.name AS dept_name
     FROM users u LEFT JOIN departments d ON d.id = u.dept_id
     WHERE u.org_id = $1 AND u.status = 1 ORDER BY u.created_at`,
    [orgId]
  );
  const departments = await query<{ id: string; name: string }>(
    `SELECT id, name FROM departments WHERE org_id = $1 ORDER BY path`,
    [orgId]
  );
  return {
    users: users.rows.map((u) => ({ id: u.id, name: u.display_name || u.username, deptName: u.dept_name ?? '' })),
    departments: departments.rows,
  };
}

export async function getRoots(user: { id: string; orgId: string; deptId: string | null }): Promise<RootEntry[]> {
  const orgRoot = await queryOne<DirectoryRow>(
    `SELECT * FROM directories WHERE org_id = $1 AND scope = $2 AND parent_id IS NULL LIMIT 1`,
    [user.orgId, DIR_SCOPES.ORG]
  );
  const personal = await queryOne<DirectoryRow>(
    `SELECT * FROM directories WHERE org_id = $1 AND scope = $2 AND owner_id = $3 AND parent_id IS NULL LIMIT 1`,
    [user.orgId, DIR_SCOPES.PRIVATE, user.id]
  );
  const deptRoot = user.deptId
    ? await queryOne<DirectoryRow>(
        `SELECT * FROM directories WHERE org_id = $1 AND scope = $2 AND dept_id = $3 AND parent_id IS NULL LIMIT 1`,
        [user.orgId, DIR_SCOPES.DEPT, user.deptId]
      )
    : null;

  const entries: RootEntry[] = [];
  if (personal) entries.push({ id: personal.id, name: '我的空间', scope: personal.scope, deptId: null, icon: 'user' });
  if (deptRoot) entries.push({ id: deptRoot.id, name: deptRoot.name, scope: deptRoot.scope, deptId: user.deptId, icon: 'team' });
  if (orgRoot) entries.push({ id: orgRoot.id, name: '企业公共盘', scope: orgRoot.scope, deptId: null, icon: 'global' });
  return entries;
}

// 导出供用户服务复用（避免循环依赖）
export { getAuthProvider };
