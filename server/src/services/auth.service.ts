// 认证服务：多方式登录 / 账号锁定 / 2FA / 自助注册 / 双令牌会话 / 吊销
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { query, queryOne } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { generateCsrfToken, hashRefreshToken, issueTokenPair, verifyRefreshToken } from '../lib/token.js';
import { ROLES, type UserRow } from '../types/index.js';import { getAuthProvider } from '../ldap/provider.js';
import { config } from '../config/index.js';
import type { AuthedUser } from '../middleware/auth.js';
import {
  assertPasswordNotReused,
  checkAccountLocked,
  detectLoginAnomaly,
  recordPasswordHistory,
  registerFailedAttempt,
  resetFailedAttempts,
  validatePasswordStrength,
  verifyTotp,
  type AnomalyResult,
} from './security.service.js';
import { verifyCode } from './verification.service.js';

export interface SessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface LoginResult {
  user: AuthedUser;
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  refreshExpiresIn: number;
  /** 2FA 未完成时返回：需调用 verify2fa 步骤 */
  require2fa?: boolean;
  challengeToken?: string;
  /** 异常登录检测结果（风控提示） */
  risk?: AnomalyResult;
}

async function buildSession(user: UserRow, ip: string, ua: string): Promise<{ sessionId: string; refreshToken: string; accessToken: string; expiresIn: number }> {
  const sessionId = crypto.randomUUID();
  const pair = issueTokenPair(
    { id: user.id, orgId: user.org_id, role: user.role, username: user.username },
    sessionId
  );
  const expiresAt = new Date(Date.now() + pair.refreshExpiresIn * 1000);
  await query(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sessionId, user.id, pair.refreshTokenHash, ip, ua.slice(0, 512), expiresAt]
  );
  return { sessionId, refreshToken: pair.refreshToken, accessToken: pair.accessToken, expiresIn: pair.refreshExpiresIn };
}

function toAuthedUser(user: UserRow): AuthedUser {
  return {
    id: user.id,
    orgId: user.org_id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    deptId: user.dept_id,
    quotaBytes: user.quota_bytes,
    usedBytes: user.used_bytes,
    status: user.status,
    authSource: user.auth_source,
  };
}

/** 2FA 挑战令牌：短效（5 分钟），仅携带 userId，用于 TOTP 验证步骤 */
function signChallengeToken(userId: string): string {
  return jwt.sign({ sub: userId, typ: '2fa' }, config.jwtAccessSecret, {
    expiresIn: '5m',
    issuer: 'minio-netdisk',
  });
}

export function verifyChallengeToken(token: string): string {
  const payload = jwt.verify(token, config.jwtAccessSecret, { issuer: 'minio-netdisk' }) as { sub: string; typ?: string };
  if (payload.typ !== '2fa') throw ApiError.unauthorized('挑战令牌无效');
  return payload.sub;
}

/** 登录完成公共路径：2FA 检查 -> 异常检测 -> 建会话（skipTwoFactor：2FA 步骤已完成后跳过） */
async function finishAuth(user: UserRow, ip: string, ua: string, skipTwoFactor = false): Promise<LoginResult> {
  if (!skipTwoFactor && user.twofa_enabled) {
    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    return {
      user: toAuthedUser(user),
      accessToken: '',
      refreshToken: '',
      csrfToken: '',
      refreshExpiresIn: 0,
      require2fa: true,
      challengeToken: signChallengeToken(user.id),
    };
  }
  const risk = await detectLoginAnomaly(user.id, ip, ua);
  const { refreshToken, accessToken, expiresIn } = await buildSession(user, ip, ua);
  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  return {
    user: toAuthedUser(user),
    accessToken,
    refreshToken,
    csrfToken: generateCsrfToken(),
    refreshExpiresIn: expiresIn,
    risk,
  };
}

/** 多方式登录：账号 / 邮箱 / 手机号（本地账号），LDAP 账号走域认证 */
export async function login(identifier: string, password: string, ip: string, ua: string): Promise<LoginResult> {
  const id = identifier.trim();
  const local = await queryOne<UserRow>(
    `SELECT * FROM users WHERE (username = $1 OR email = $1 OR phone = $1) AND status <> 0 LIMIT 1`,
    [id]
  );

  if (local && local.auth_source === 'local') {
    if (local.status !== 1) throw ApiError.forbidden('账号已被禁用');
    await checkAccountLocked(local);
    const ok = await verifyPassword(password, local.password_hash);
    if (!ok) {
      const locked = await registerFailedAttempt(local.id);
      throw ApiError.unauthorized(locked ? '登录失败次数过多，账号已锁定 30 分钟' : '用户名或密码错误');
    }
    await resetFailedAttempts(local.id);
    return finishAuth(local, ip, ua);
  }

  // 非本地账号（LDAP）或账号不存在：走域认证
  const provider = getAuthProvider();
  let user: UserRow | null = null;
  try {
    user = await provider.authenticate(identifier, password);
  } catch (err) {
    throw ApiError.badRequest((err as Error).message || '认证失败');
  }
  if (!user) throw ApiError.unauthorized('用户名或密码错误');
  if (user.status !== 1) throw ApiError.forbidden('账号已被禁用');
  return finishAuth(user, ip, ua);
}

/** 2FA 步骤：验证 TOTP 后完成登录（首次密码通过后） */
export async function verify2faStep(challengeToken: string, code: string, ip: string, ua: string): Promise<LoginResult> {
  const userId = verifyChallengeToken(challengeToken);
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1 AND status = 1', [userId]);
  if (!user) throw ApiError.unauthorized('账号不存在或已禁用');
  if (!user.twofa_enabled) throw ApiError.badRequest('该账号未启用 2FA');
  if (!(await verifyTotp(user.id, code))) throw ApiError.badRequest('2FA 验证码错误');
  return finishAuth(user, ip, ua, true);
}

// ---------- 自助注册（验证码 + 密码强度 + 协议 + CAPTCHA 已在路由层校验） ----------

export async function register(input: {
  username: string;
  password: string;
  displayName?: string;
  target: string; // 邮箱或手机
  code: string; // 注册验证码
  agreeTerms: boolean;
}): Promise<AuthedUser> {
  const username = input.username.trim();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw ApiError.badRequest('登录名需为 3-32 位字母/数字/._-');
  if (input.agreeTerms !== true) throw ApiError.badRequest('请先阅读并同意用户协议');
  validatePasswordStrength(input.password);

  const target = input.target.trim();
  const dup = await queryOne<UserRow>(
    `SELECT * FROM users WHERE username = $1 OR email = $1 OR phone = $1 LIMIT 1`,
    [username]
  );
  if (dup) throw ApiError.conflict('登录名、邮箱或手机号已被注册');
  if (!(await verifyCode('register', target, input.code))) throw ApiError.badRequest('验证码错误或已过期');

  const passwordHash = await hashPassword(input.password);
  const r = await query<UserRow>(
    `INSERT INTO users (org_id, username, password_hash, display_name, email, phone, role, status, quota_bytes, used_bytes, auth_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 0, 0, 'local') RETURNING *`,
    [await getDefaultOrg(), username, passwordHash, input.displayName?.trim() || username, target.includes('@') ? target : '', target.includes('@') ? '' : target, ROLES.EMPLOYEE]
  );
  const user = r.rows[0];
  await recordPasswordHistory(user.id, passwordHash);
  return toAuthedUser(user);
}

async function getDefaultOrg(): Promise<string> {
  const org = await queryOne<{ id: string }>(`SELECT id FROM orgs ORDER BY created_at LIMIT 1`);
  if (!org) throw new ApiError(500, 'INTERNAL_ERROR', '组织未初始化');
  return org.id;
}

export async function refresh(refreshToken: string, ip: string, ua: string): Promise<LoginResult> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw ApiError.unauthorized('登录状态已失效，请重新登录');
  }
  const sid = payload.sid as string | undefined;
  if (!sid) throw ApiError.unauthorized();

  const session = await queryOne<SessionRow>('SELECT * FROM sessions WHERE id = $1', [sid]);
  if (!session || session.revoked_at || session.expires_at < new Date()) {
    throw ApiError.unauthorized('登录状态已过期，请重新登录');
  }
  if (session.refresh_token_hash !== hashRefreshToken(refreshToken)) {
    // 令牌不匹配，视为会话被篡改，吊销
    await query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [sid]);
    throw ApiError.unauthorized('会话异常，请重新登录');
  }
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1 AND status = 1', [session.user_id]);
  if (!user) throw ApiError.unauthorized('账号不存在或已禁用');

  // 旋转：旧会话吊销，签发新会话
  await query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [sid]);
  const { refreshToken: newRefresh, accessToken, expiresIn } = await buildSession(user, ip, ua);
  return {
    user: toAuthedUser(user),
    accessToken,
    refreshToken: newRefresh,
    csrfToken: generateCsrfToken(),
    refreshExpiresIn: expiresIn,
  };
}

export async function logout(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  try {
    const payload = verifyRefreshToken(refreshToken);
    const sid = payload.sid as string | undefined;
    if (sid) {
      await query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sid]);
    }
  } catch {
    /* token 已失效则忽略 */
  }
}

export async function changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) throw ApiError.notFound('用户不存在');
  if (user.auth_source !== 'local') throw ApiError.forbidden('域账号请在内部系统修改密码');
  const ok = await verifyPassword(oldPassword, user.password_hash);
  if (!ok) throw ApiError.forbidden('原密码不正确');
  validatePasswordStrength(newPassword);
  await assertPasswordNotReused(userId, newPassword);
  const passwordHash = await hashPassword(newPassword);
  await query(`UPDATE users SET password_hash = $2, password_updated_at = now(), updated_at = now() WHERE id = $1`, [userId, passwordHash]);
  await recordPasswordHistory(userId, passwordHash);
  // 修改密码后吊销全部会话，需重新登录
  await query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}

export function roleName(role: number): string {
  if (role === ROLES.ADMIN) return '企业管理员';
  if (role === ROLES.DEPT_ADMIN) return '部门管理员';
  return '普通员工';
}
