// 全局共享类型（后端领域模型 + API DTO）

// 角色：1 企业管理员 2 部门管理员 3 普通员工
export const ROLES = { ADMIN: 1, DEPT_ADMIN: 2, EMPLOYEE: 3 } as const;
export type Role = 1 | 2 | 3;

// 目录范围：1 企业公共盘 2 部门盘 3 个人空间
export const DIR_SCOPES = { ORG: 1, DEPT: 2, PRIVATE: 3 } as const;
export type DirScope = 1 | 2 | 3;

// ACL / 授权目标类型：1 用户 2 部门 3 企业
export const TARGET_TYPES = { USER: 1, DEPT: 2, ORG: 3 } as const;
export type TargetType = 1 | 2 | 3;

export interface OrgRow {
  id: string;
  name: string;
  code: string;
  status: number;
  quota_bytes: number;
  created_at: Date;
  updated_at: Date;
}

export interface DepartmentRow {
  id: string;
  org_id: string;
  parent_id: string | null;
  name: string;
  path: string;
  sort_order: number;
  quota_bytes: number;
  created_at: Date;
  updated_at: Date;
}

export interface UserRow {
  id: string;
  org_id: string;
  username: string;
  password_hash: string;
  display_name: string;
  email: string;
  phone: string;
  role: Role;
  dept_id: string | null;
  status: number;
  quota_bytes: number;
  used_bytes: number;
  auth_source: string;
  ldap_dn: string;
  last_login_at: Date | null;
  // 安全增强（登录锁定 / 2FA / 密码策略）
  failed_attempts?: number;
  locked_until?: Date | null;
  twofa_secret?: string | null;
  twofa_enabled?: boolean;
  password_updated_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface DirectoryRow {
  id: string;
  org_id: string;
  dept_id: string | null;
  parent_id: string | null;
  owner_id: string | null;
  name: string;
  path: string;
  scope: DirScope;
  is_deleted: boolean;
  deleted_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface FileRow {
  id: string;
  org_id: string;
  dir_id: string;
  owner_id: string;
  name: string;
  ext: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  object_key: string;
  version_id: string;
  is_deleted: boolean;
  deleted_at: Date | null;
  deleted_by: string | null;
  dedup_ref: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface FileVersionRow {
  id: number;
  file_id: string;
  object_key: string;
  version_id: string;
  size_bytes: number;
  sha256: string;
  uploaded_by: string | null;
  created_at: Date;
}

export interface AclRow {
  id: number;
  dir_id: string;
  target_type: TargetType;
  target_id: string;
  can_read: boolean;
  can_write: boolean;
  can_delete: boolean;
  can_share: boolean;
  created_by: string | null;
  created_at: Date;
}

export interface ShareGrantRow {
  id: string;
  org_id: string;
  file_id: string | null;
  dir_id: string | null;
  target_type: TargetType;
  target_id: string;
  can_write: boolean;
  can_delete: boolean;
  created_by: string | null;
  created_at: Date;
}

export interface ShareLinkRow {
  id: string;
  org_id: string;
  token: string;
  file_id: string | null;
  dir_id: string | null;
  password_hash: string;
  expires_at: Date | null;
  max_access_count: number;
  access_count: number;
  allow_download: boolean;
  created_by: string | null;
  created_at: Date;
  revoked_at: Date | null;
}

export interface UploadSessionRow {
  id: string;
  org_id: string;
  user_id: string;
  dir_id: string;
  file_name: string;
  file_size: number;
  sha256: string;
  object_key: string;
  upload_id: string;
  mode: number; // 1 单请求 2 分片
  status: number; // 0 进行中 1 完成 2 中止 3 失败
  uploaded_parts: number[];
  created_at: Date;
  updated_at: Date;
}

export interface AuditLogRow {
  id: number;
  org_id: string | null;
  user_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  file_id: string | null;
  detail: Record<string, unknown>;
  ip: string;
  user_agent: string;
  created_at: Date;
}

/** 去重池元数据（哈希验证结果缓存：首验后秒传免验） */
export interface DedupPoolRow {
  org_id: string;
  sha256: string;
  size_bytes: number;
  verified: boolean; // 哈希已经服务端全量校验（可信，可直接秒传）
  created_at: Date;
}

// ---------- API DTO ----------

export interface FileListItem {
  id: string;
  type: 'file' | 'dir';
  name: string;
  ext?: string;
  mime?: string;
  size?: number;
  sha256?: string;
  versionId?: string;
  scope?: number;
  ownerName?: string;
  ownerId?: string;
  dirId?: string;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  // 权限摘要（前端禁用按钮用）
  canWrite?: boolean;
  canDelete?: boolean;
  canShare?: boolean;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ShareLinkDto {
  id: string;
  token: string;
  url: string;
  targetName: string;
  isDir: boolean;
  hasPassword: boolean;
  expiresAt: string | null;
  maxAccessCount: number;
  accessCount: number;
  allowDownload: boolean;
  createdAt: string;
}

export interface JwtPayload {
  sub: string; // user id
  org: string; // org id
  role: number;
  name: string; // username
  typ: 'access' | 'refresh';
}

export interface AccessRights {
  read: boolean;
  write: boolean;
  del: boolean;
  share: boolean;
}
