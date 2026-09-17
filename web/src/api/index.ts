// 类型化 API 封装（与后端路由一一对应）
import { api } from './client';
import type {
  AclRow, AuditItem, DeptNode, DirListResult, FileItem, FileVersion, GrantRow,
  OrgRoot, OrgTree, Paginated, QuotaInfo, ShareLink, ShareMeta, TargetRef, UploadInitResult, UserInfo, UserRow,
} from './types';

// ---------- Auth ----------
export const authApi = {
  login: (identifier: string, password: string) =>
    api<{ accessToken: string; user: UserInfo; require2fa?: boolean; challengeToken?: string; risk?: { anomalous: boolean; reason?: string } }>(
      '/api/auth/login',
      { method: 'POST', body: { identifier, password }, auth: false }
    ),
  verify2fa: (challengeToken: string, code: string) =>
    api<{ accessToken: string; user: UserInfo; risk?: { anomalous: boolean; reason?: string } }>('/api/auth/2fa/verify', {
      method: 'POST',
      body: { challengeToken, code },
      auth: false,
    }),
  captcha: () => api<{ id: string; question: string }>('/api/auth/captcha', { auth: false }),
  registerSendCode: (target: string, captchaId: string, captchaAnswer: number) =>
    api<{ ok: boolean; sent: boolean; masked: string; message: string }>('/api/auth/register/send-code', {
      method: 'POST',
      body: { target, captchaId, captchaAnswer },
      auth: false,
    }),
  register: (data: { username: string; password: string; displayName?: string; target: string; code: string; agreeTerms: boolean; captchaId?: string; captchaAnswer?: number }) =>
    api<{ ok: boolean; message: string }>('/api/auth/register', { method: 'POST', body: data, auth: false }),
  twofaStatus: () => api<{ enabled: boolean; hasSecret: boolean }>('/api/auth/2fa/status'),
  twofaSetup: () => api<{ qrDataUrl: string; secret: string }>('/api/auth/2fa/setup', { method: 'POST' }),
  twofaConfirm: (code: string) => api<{ ok: boolean }>('/api/auth/2fa/confirm', { method: 'POST', body: { code } }),
  twofaDisable: (code: string, password: string) => api<{ ok: boolean }>('/api/auth/2fa/disable', { method: 'POST', body: { code, password } }),
  sessions: () => api<{ items: Array<{ id: string; ip: string; userAgent: string; createdAt: string; expiresAt: string; current: boolean }> }>('/api/auth/sessions'),
  revokeSession: (id: string) => api<{ ok: boolean }>(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
  logout: () => api<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => api<{ user: UserInfo }>('/api/auth/me'),
  changePassword: (oldPassword: string, newPassword: string) =>
    api<{ ok: boolean }>('/api/auth/change-password', { method: 'POST', body: { oldPassword, newPassword } }),
  ldapStatus: () => api<{ enabled: boolean; configured: boolean; url: string }>('/api/auth/ldap-status'),
  // 忘记密码（无登录态）
  resetChannels: () => api<{ email: boolean; sms: boolean }>('/api/auth/password-reset/channels', { auth: false }),
  resetRequest: (username: string, channel: 'email' | 'sms', mode: 'code' | 'link' = 'code') =>
    api<{ ok: boolean; message: string }>('/api/auth/password-reset/request', { method: 'POST', body: { username, channel, mode }, auth: false }),
  resetConfirm: (username: string, channel: 'email' | 'sms', code: string, newPassword: string) =>
    api<{ ok: boolean; message: string }>('/api/auth/password-reset/reset', { method: 'POST', body: { username, channel, code, newPassword }, auth: false }),
  resetByLink: (token: string, newPassword: string) =>
    api<{ ok: boolean; message: string }>('/api/auth/password-reset/reset-link', { method: 'POST', body: { token, newPassword }, auth: false }),
};

// ---------- Org ----------
export const orgApi = {
  roots: () => api<{ roots: OrgRoot[] }>('/api/org/roots'),
  tree: () => api<OrgTree>('/api/org/tree'),
  candidates: () =>
    api<{ users: Array<{ id: string; name: string; deptName: string }>; departments: Array<{ id: string; name: string }> }>(
      '/api/org/candidates'
    ),
  createDept: (data: { name: string; parentId?: string | null; quotaBytes?: number }) =>
    api<{ id: string }>('/api/org/departments', { method: 'POST', body: data }),
  updateDept: (id: string, data: { name?: string; quotaBytes?: number }) =>
    api<{ ok: boolean }>(`/api/org/departments/${id}`, { method: 'PUT', body: data }),
  deleteDept: (id: string) => api<{ ok: boolean }>(`/api/org/departments/${id}`, { method: 'DELETE' }),
};

// ---------- Users ----------
export const usersApi = {
  list: (params: { page: number; pageSize: number; q?: string }) =>
    api<Paginated<UserRow>>('/api/users', { params }),
  create: (data: Record<string, unknown>) => api<{ id: string }>('/api/users', { method: 'POST', body: data }),
  update: (id: string, data: Record<string, unknown>) =>
    api<{ ok: boolean }>(`/api/users/${id}`, { method: 'PUT', body: data }),
  resetPassword: (id: string, newPassword: string) =>
    api<{ ok: boolean }>(`/api/users/${id}/reset-password`, { method: 'POST', body: { newPassword } }),
  remove: (id: string) => api<{ ok: boolean }>(`/api/users/${id}`, { method: 'DELETE' }),
};

// ---------- Files ----------
export const filesApi = {
  list: (dirId: string, params?: { offset?: number; limit?: number }) =>
    api<DirListResult>('/api/files', { params: { dirId, offset: params?.offset, limit: params?.limit } }),
  breadcrumb: (dirId: string) => api<{ items: FileItem[] }>('/api/files/breadcrumb', { params: { dirId } }),
  trash: (params?: { offset?: number; limit?: number }) =>
    api<{ items: FileItem[]; total?: number; retentionDays?: number }>('/api/files/trash', { params }),
  emptyTrash: () =>
    api<{ ok: boolean; count: number }>('/api/files/trash/empty', { method: 'POST', timeout: 30 * 60 * 1000 }), // 大回收站清空可能较久（30 分钟）
  mkdir: (parentId: string, name: string) =>
    api<FileItem>('/api/files/mkdir', { method: 'POST', body: { parentId, name } }),
  rename: (id: string, type: 'file' | 'dir', name: string) =>
    api<{ ok: boolean }>('/api/files/rename', { method: 'POST', body: { id, type, name } }),
  move: (targets: TargetRef[], targetDirId: string) =>
    api<{ ok: boolean }>('/api/files/move', { method: 'POST', body: { targets, targetDirId } }),
  copy: (targets: TargetRef[], targetDirId: string) =>
    api<{ ok: boolean }>('/api/files/copy', { method: 'POST', body: { targets, targetDirId } }),
  remove: (targets: TargetRef[]) => api<{ ok: boolean; count: number }>('/api/files/delete', { method: 'POST', body: { targets } }),
  restore: (targets: TargetRef[]) => api<{ ok: boolean; count: number }>('/api/files/restore', { method: 'POST', body: { targets } }),
  purge: (targets: TargetRef[]) => api<{ ok: boolean; count: number }>('/api/files/purge', { method: 'POST', body: { targets }, timeout: 10 * 60 * 1000 }), // 大目录硬删可能较久（10 分钟）
  // v1.1.8：上传相关接口支持传入任务中断信号（暂停时同步中断请求，避免“暂停了但服务端仍在完成”）
  uploadInit: (data: { dirId: string; name: string; size: number; hash?: string; sha256?: string; mimeType?: string }, signal?: AbortSignal) =>
    api<UploadInitResult>('/api/files/upload/init', { method: 'POST', body: data, signal }),
  presignParts: (sessionId: string, partNumbers: number[], signal?: AbortSignal) =>
    api<{ parts: Array<{ partNumber: number; url: string; expires: number }> }>('/api/files/upload/presign-parts', {
      method: 'POST',
      body: { sessionId, partNumbers },
      signal,
    }),
  completeUpload: (sessionId: string, parts?: Array<{ partNumber: number; etag: string }>, signal?: AbortSignal) =>
    api<FileItem>('/api/files/upload/complete', { method: 'POST', body: { sessionId, parts }, signal }),
  abortUpload: (sessionId: string) => api<{ ok: boolean }>('/api/files/upload/abort', { method: 'POST', body: { sessionId } }),
  uploadedParts: (sessionId: string) => api<{ parts: number[] }>(`/api/files/upload/session/${sessionId}/parts`),
  download: (id: string) => api<{ url: string }>(`/api/files/${id}/download`),
  preview: (id: string) => api<{ url: string; file: FileItem }>(`/api/files/${id}/preview`),
  versions: (id: string) => api<{ current: FileItem; versions: FileVersion[] }>(`/api/files/${id}/versions`),
  rollback: (id: string, versionId: string) =>
    api<FileItem>(`/api/files/${id}/versions/${versionId}/rollback`, { method: 'POST' }),
  grants: (id: string, type: 'file' | 'dir') => api<{ items: GrantRow[] }>(`/api/files/${id}/grants`, { params: { type } }),
  addGrant: (id: string, data: { type: 'file' | 'dir'; targetType: number; targetId: string; canWrite?: boolean; canDelete?: boolean }) =>
    api<{ ok: boolean }>(`/api/files/${id}/grants`, { method: 'POST', body: data }),
  removeGrant: (grantId: string) => api<{ ok: boolean }>(`/api/files/grants/${grantId}`, { method: 'DELETE' }),
  acls: (id: string) => api<{ items: AclRow[] }>(`/api/files/${id}/acl`),
  upsertAcl: (id: string, data: { targetType: number; targetId: string; canRead?: boolean; canWrite?: boolean; canDelete?: boolean; canShare?: boolean }) =>
    api<{ ok: boolean }>(`/api/files/${id}/acl`, { method: 'POST', body: data }),
  removeAcl: (aclId: number) => api<{ ok: boolean }>(`/api/files/acl/${aclId}`, { method: 'DELETE' }),
};

// ---------- Shares ----------
export const sharesApi = {
  list: () => api<{ items: ShareLink[] }>('/api/shares/links'),
  create: (data: { fileId?: string; dirId?: string; password?: string; expiresAt?: string | null; maxAccessCount?: number; allowDownload?: boolean }) =>
    api<ShareLink>('/api/shares/links', { method: 'POST', body: data }),
  revoke: (id: string) => api<{ ok: boolean }>(`/api/shares/links/${id}`, { method: 'DELETE' }),
  meta: (token: string) => api<ShareMeta>(`/api/shares/${token}/meta`),
  download: (token: string, password?: string, fileId?: string) =>
    api<{ url: string; name: string }>(`/api/shares/${token}/download`, { method: 'POST', body: { password, fileId } }),
  listDir: (token: string, params: { dirId?: string; password?: string }) =>
    api<{ items: FileItem[]; current: FileItem | null; ancestors?: FileItem[] }>(`/api/shares/${token}/list`, { params }),
};

// ---------- Search ----------
export const searchApi = {
  search: (params: { q: string; from?: string; to?: string; page?: number; pageSize?: number }) =>
    api<Paginated<FileItem>>('/api/search', { params }),
};

// ---------- Audit ----------
export const auditApi = {
  list: (params: { page: number; pageSize: number; userId?: string; action?: string; from?: string; to?: string }) =>
    api<Paginated<AuditItem>>('/api/audit', { params }),
};

// ---------- Quota ----------
export const quotaApi = {
  usage: () => api<QuotaInfo>('/api/quota/usage'),
  deptSummary: () => api<{ items: Array<{ id: string; name: string; quota: number; used: number }> }>('/api/quota/departments'),
  setUser: (id: string, quotaBytes: number) => api<{ ok: boolean }>(`/api/quota/user/${id}`, { method: 'PUT', body: { quotaBytes } }),
  setDept: (id: string, quotaBytes: number) => api<{ ok: boolean }>(`/api/quota/dept/${id}`, { method: 'PUT', body: { quotaBytes } }),
  setOrg: (quotaBytes: number) => api<{ ok: boolean }>('/api/quota/org', { method: 'PUT', body: { quotaBytes } }),
};

export type { DeptNode };
