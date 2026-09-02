// =============================================================================
// RBAC 权限解析（核心安全模块）
// 权限来源（按优先级叠加）：
//   1. 企业管理员 -> 全量权限
//   2. 个人空间(scope=3)：仅属主全量
//   3. 部门盘(scope=2)：本部门成员只读；本部门管理员读写删享
//   4. 企业公共盘(scope=1)：全员可读
//   5. 目录 ACL（acls 表）：对 用户/部门/企业 显式授予
//   6. 内部授权（share_grants 表）：文件级/目录级授权（可写/可删）
// =============================================================================
import { query, queryOne } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import {
  DIR_SCOPES,
  ROLES,
  TARGET_TYPES,
  type AccessRights,
  type DirectoryRow,
  type FileRow,
} from '../types/index.js';

// 供未挂载 DB 行的场景使用（避免循环依赖，直接内联）
export interface UserLike {
  id: string;
  orgId: string;
  role: number;
  deptId: string | null;
}

export type Perm = 'read' | 'write' | 'delete' | 'share';

/** 权限名到 AccessRights 键的映射（delete -> del） */
function permKey(perm: Perm): keyof AccessRights {
  return perm === 'delete' ? 'del' : perm;
}

const FULL: AccessRights = { read: true, write: true, del: true, share: true };
const NONE: AccessRights = { read: false, write: false, del: false, share: false };

export function mergeRights(a: AccessRights, b: AccessRights): AccessRights {
  return {
    read: a.read || b.read,
    write: a.write || b.write,
    del: a.del || b.del,
    share: a.share || b.share,
  };
}

/** 物化路径祖先判断：'/a/' 是 '/a/b/' 的祖先 */
export function isAncestor(ancestorPath: string, nodePath: string): boolean {
  if (ancestorPath === '' || ancestorPath === '/') return true;
  if (nodePath === ancestorPath) return true;
  return nodePath.startsWith(ancestorPath);
}

interface AclGrantRow {
  target_type: number;
  target_id: string;
  can_read: boolean;
  can_write: boolean;
  can_delete: boolean;
  can_share: boolean;
}

interface GrantRow {
  target_type: number;
  target_id: string;
  can_write: boolean;
  can_delete: boolean;
}

function aclKey(gt: AclGrantRow | GrantRow, user: UserLike): boolean {
  const isAcl = 'can_read' in gt;
  if (gt.target_type === TARGET_TYPES.USER) return gt.target_id === user.id;
  if (gt.target_type === TARGET_TYPES.DEPT) return !!user.deptId && gt.target_id === user.deptId;
  if (gt.target_type === TARGET_TYPES.ORG) return gt.target_id === user.orgId;
  return false;
}

async function loadDirRights(user: UserLike, dir: DirectoryRow): Promise<AccessRights> {
  let rights: AccessRights = { ...NONE };

  // 1. 企业管理员
  if (user.role === ROLES.ADMIN) return { ...FULL };

  // 2. 个人空间
  if (dir.scope === DIR_SCOPES.PRIVATE) {
    if (dir.owner_id === user.id) return { ...FULL };
  }

  // 3. 部门盘
  if (dir.scope === DIR_SCOPES.DEPT && dir.dept_id && user.deptId && dir.dept_id === user.deptId) {
    rights = mergeRights(rights, { read: true, write: false, del: false, share: false });
    if (user.role === ROLES.DEPT_ADMIN) {
      rights = mergeRights(rights, { read: true, write: true, del: true, share: true });
    }
  }

  // 4. 企业公共盘：全员可读
  if (dir.scope === DIR_SCOPES.ORG) {
    rights = mergeRights(rights, { read: true, write: false, del: false, share: false });
  }

  // 5. 目录 ACL
  const aclRows = await query<AclGrantRow>(
    `SELECT target_type, target_id, can_read, can_write, can_delete, can_share
     FROM acls WHERE dir_id = $1`,
    [dir.id]
  );
  for (const row of aclRows.rows) {
    if (!aclKey(row, user)) continue;
    rights = mergeRights(rights, {
      read: row.can_read,
      write: row.can_write,
      del: row.can_delete,
      share: row.can_share,
    });
  }

  // 6. 目录内部授权（share_grants.dir_id）
  const grants = await query<GrantRow>(
    `SELECT target_type, target_id, can_write, can_delete FROM share_grants WHERE dir_id = $1`,
    [dir.id]
  );
  for (const row of grants.rows) {
    if (!aclKey(row, user)) continue;
    rights = mergeRights(rights, { read: true, write: row.can_write, del: row.can_delete, share: false });
  }

  return rights;
}

/** 解析目录权限（含父链：子目录权限继承父目录最小集，父无读则子不可见） */
export async function resolveDirAccess(user: UserLike, dirId: string): Promise<{ dir: DirectoryRow; rights: AccessRights }> {
  const dir = await queryOne<DirectoryRow>('SELECT * FROM directories WHERE id = $1 AND is_deleted = FALSE', [dirId]);
  if (!dir) throw ApiError.notFound('目录不存在');
  const rights = await loadDirRights(user, dir);
  return { dir, rights };
}

/** 目录访问校验，通过则返回目录 */
export async function requireDirAccess(user: UserLike, dirId: string, perm: Perm): Promise<DirectoryRow> {
  const { dir, rights } = await resolveDirAccess(user, dirId);
  if (!rights[permKey(perm)]) throw ApiError.forbidden(`无权${perm === 'read' ? '访问' : perm === 'share' ? '分享' : perm === 'delete' ? '删除' : '写入'}该目录`);
  return dir;
}

async function loadFileRights(user: UserLike, file: FileRow): Promise<AccessRights> {
  const dir = await queryOne<DirectoryRow>('SELECT * FROM directories WHERE id = $1', [file.dir_id]);
  if (!dir) return { ...NONE };
  let rights = await loadDirRights(user, dir);
  // 文件级内部授权（share_grants.file_id）
  const grants = await query<GrantRow>(
    `SELECT target_type, target_id, can_write, can_delete FROM share_grants WHERE file_id = $1`,
    [file.id]
  );
  for (const row of grants.rows) {
    if (!aclKey(row, user)) continue;
    rights = mergeRights(rights, { read: true, write: row.can_write, del: row.can_delete, share: false });
  }
  return rights;
}

/** 文件访问校验，通过则返回文件 */
export async function requireFileAccess(user: UserLike, fileId: string, perm: Perm): Promise<FileRow> {
  const file = await queryOne<FileRow>('SELECT * FROM files WHERE id = $1 AND is_deleted = FALSE', [fileId]);
  if (!file) throw ApiError.notFound('文件不存在');
  const rights = await loadFileRights(user, file);
  if (!rights[permKey(perm)]) throw ApiError.forbidden(`无权${perm === 'read' ? '访问' : perm === 'delete' ? '删除' : '写入'}该文件`);
  return file;
}

export async function resolveFileRights(user: UserLike, file: FileRow): Promise<AccessRights> {
  return loadFileRights(user, file);
}

/**
 * 当前用户可读的目录集合（含 ACL/授权扩展的子孙目录），用于搜索/回收站过滤
 */
export async function accessibleDirIds(user: UserLike): Promise<string[]> {
  const res = await query<{ id: string }>(
    `WITH base AS (
       SELECT id, path FROM directories
       WHERE org_id = $1 AND (
         (scope = 3 AND owner_id = $2)
         OR (scope = 2 AND dept_id = $3 AND $3 IS NOT NULL)
         OR scope = 1
         OR EXISTS (SELECT 1 FROM acls a WHERE a.dir_id = directories.id AND a.can_read AND (
             (a.target_type = 1 AND a.target_id = $2)
             OR (a.target_type = 2 AND a.target_id = $3)
             OR (a.target_type = 3 AND a.target_id = $1)))
         OR EXISTS (SELECT 1 FROM share_grants sg WHERE sg.dir_id = directories.id AND (
             (sg.target_type = 1 AND sg.target_id = $2)
             OR (sg.target_type = 2 AND sg.target_id = $3)
             OR (sg.target_type = 3 AND sg.target_id = $1)))
       )
     )
     SELECT DISTINCT d.id FROM directories d JOIN base b
       ON d.path = b.path OR d.path LIKE b.path || '%'
     WHERE d.org_id = $1`,
    [user.orgId, user.id, user.deptId]
  );
  return res.rows.map((r) => r.id);
}
