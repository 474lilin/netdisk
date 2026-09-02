// 前端 API DTO（与后端一致）
export type Role = 1 | 2 | 3;

export interface UserInfo {
  id: string;
  orgId: string;
  username: string;
  displayName: string;
  role: Role;
  deptId: string | null;
  quotaBytes: number;
  usedBytes: number;
  status: number;
  authSource: string;
}

export interface FileItem {
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
  canWrite?: boolean;
  canDelete?: boolean;
  canShare?: boolean;
}

export interface DirRights {
  read: boolean;
  write: boolean;
  del: boolean;
  share: boolean;
}

export interface DirListResult {
  items: FileItem[];
  dir: { id: string; name: string; scope: number; path: string };
  rights: DirRights;
  total?: number;
  hasMore?: boolean;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TargetRef {
  type: 'file' | 'dir';
  id: string;
}

export interface UploadInitResult {
  dedup: boolean;
  session?: { id: string; mode: number; partSize: number; totalParts: number };
  presignedUrl?: string;
  file?: FileItem;
}

export interface ShareLink {
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

export interface OrgRoot {
  id: string;
  name: string;
  scope: number;
  deptId: string | null;
  icon: string;
}

export interface DeptNode {
  id: string;
  name: string;
  path: string;
  quotaBytes: number;
  children: DeptNode[];
  users: Array<{ id: string; username: string; displayName: string; role: number; status: number }>;
}

export interface OrgTree {
  departments: DeptNode[];
  unassignedUsers: Array<{ id: string; username: string; displayName: string; role: number; status: number }>;
}

export interface FileVersion {
  id: number;
  file_id: string;
  object_key: string;
  version_id: string;
  size_bytes: number;
  sha256: string;
  uploaded_by: string | null;
  created_at: string;
}

export interface AuditItem {
  id: number;
  orgId: string | null;
  userId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  fileId: string | null;
  detail: Record<string, unknown>;
  ip: string;
  userAgent: string;
  createdAt: string;
  user_name?: string;
}

export interface UserRow {
  id: string;
  orgId: string;
  username: string;
  displayName: string;
  email: string;
  phone: string;
  role: Role;
  deptId: string | null;
  dept_name?: string;
  status: number;
  quotaBytes: number;
  usedBytes: number;
  authSource: string;
  createdAt: string;
}

export interface GrantRow {
  id: string;
  file_id: string | null;
  dir_id: string | null;
  target_type: number;
  target_id: string;
  can_write: boolean;
  can_delete: boolean;
  created_by: string | null;
  created_at: string;
}

export interface AclRow {
  id: number;
  dir_id: string;
  target_type: number;
  target_id: string;
  can_read: boolean;
  can_write: boolean;
  can_delete: boolean;
  can_share: boolean;
  created_by: string | null;
  created_at: string;
}

export const ROLE_NAMES: Record<Role, string> = { 1: '企业管理员', 2: '部门管理员', 3: '普通员工' };
export const TARGET_NAMES: Record<number, string> = { 1: '用户', 2: '部门', 3: '企业' };
