// 安全增强：TOTP 2FA / 密码历史 / 会话设备管理 / 账号锁定 / 异常登录检测
import crypto from 'node:crypto';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { query, queryOne } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { verifyPassword, hashPassword } from '../lib/password.js';
import type { UserRow } from '../types/index.js';

// ---------- 2FA (TOTP) ----------

export interface TwoFactorSetup {
  secret: string; // base32，展示给用户备份
  otpauthUrl: string;
  qrDataUrl: string;
}

export async function generateTwoFactorSetup(user: { id: string; username?: string; email?: string }): Promise<TwoFactorSetup> {
  const secret = speakeasy.generateSecret({ name: `NetDisk:${user.username || user.email || user.id}` });
  const otpauthUrl = secret.otpauth_url ?? '';
  const qrDataUrl = otpauthUrl ? await QRCode.toDataURL(otpauthUrl) : '';
  return { secret: secret.base32, otpauthUrl, qrDataUrl };
}

/** 验证 TOTP 令牌（允许前后 1 个时间窗口，容忍轻微时钟偏差） */
export async function verifyTotp(userId: string, token: string): Promise<boolean> {
  if (!/^\d{6}$/.test(token)) return false;
  const user = await queryOne<UserRow>('SELECT twofa_secret FROM users WHERE id = $1', [userId]);
  if (!user?.twofa_secret) return false;
  return speakeasy.totp.verify({
    secret: user.twofa_secret,
    encoding: 'base32',
    token,
    window: 1,
  });
}

export async function enableTwoFactor(userId: string, token: string): Promise<void> {
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user || !user.twofa_secret) throw ApiError.badRequest('请先获取 2FA 密钥');
  if (!(await verifyTotp(userId, token))) throw ApiError.badRequest('验证码错误，2FA 未启用');
  await query(`UPDATE users SET twofa_enabled = TRUE WHERE id = $1`, [userId]);
  logger.info('2fa enabled', { userId });
}

export async function disableTwoFactor(userId: string, token: string, password: string): Promise<void> {
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) throw ApiError.notFound('用户不存在');
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) throw ApiError.forbidden('密码不正确');
  if (user.twofa_enabled && !(await verifyTotp(userId, token))) throw ApiError.badRequest('验证码错误，无法关闭 2FA');
  await query(`UPDATE users SET twofa_enabled = FALSE, twofa_secret = NULL WHERE id = $1`, [userId]);
  logger.info('2fa disabled', { userId });
}

// ---------- 密码历史（保留最近 5 条，禁重复使用） ----------

const PASSWORD_HISTORY_LIMIT = 5;

export async function recordPasswordHistory(userId: string, passwordHash: string): Promise<void> {
  await query(`INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)`, [userId, passwordHash]);
  await query(
    `DELETE FROM password_history WHERE id IN (
       SELECT id FROM password_history WHERE user_id = $1 ORDER BY id DESC OFFSET $2
     )`,
    [userId, PASSWORD_HISTORY_LIMIT]
  );
}

export async function assertPasswordNotReused(userId: string, newPassword: string): Promise<void> {
  const rows = await query<{ password_hash: string }>(
    `SELECT password_hash FROM password_history WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [userId, PASSWORD_HISTORY_LIMIT]
  );
  for (const r of rows.rows) {
    if (await verifyPassword(newPassword, r.password_hash)) {
      throw ApiError.badRequest(`不能使用最近 ${PASSWORD_HISTORY_LIMIT} 次使用过的密码`);
    }
  }
}

/** 密码强度：≥8 位，且至少包含字母与数字（大小写/数字/符号组合） */
export function validatePasswordStrength(password: string): void {
  if (password.length < 8) throw ApiError.badRequest('密码至少 8 位');
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^a-zA-Z0-9]/.test(password);
  const kinds = (hasLetter ? 1 : 0) + (hasDigit ? 1 : 0) + (hasSymbol ? 1 : 0);
  if (kinds < 2) throw ApiError.badRequest('密码需同时包含字母与数字（建议含特殊符号）');
}

// ---------- 账号锁定（登录失败次数） ----------

export const MAX_LOGIN_FAILURES = 5;
export const LOCK_DURATION_MIN = 30;

export async function checkAccountLocked(user: UserRow): Promise<void> {
  if (user.status !== 1) throw ApiError.forbidden('账号已被禁用，请联系管理员');
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60_000);
    throw ApiError.forbidden(`登录失败次数过多，账号已锁定 ${mins} 分钟后自动解锁`);
  }
  if (user.locked_until && user.locked_until <= new Date()) {
    // 锁定已过期：自动解锁并清零计数
    await query(`UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE id = $1`, [user.id]);
  }
}

export async function registerFailedAttempt(userId: string): Promise<boolean> {
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) return false;
  const next = Number(user.failed_attempts ?? 0) + 1;
  if (next >= MAX_LOGIN_FAILURES) {
    await query(
      `UPDATE users SET failed_attempts = $2, locked_until = now() + make_interval(mins => $3) WHERE id = $1`,
      [userId, next, LOCK_DURATION_MIN]
    );
    logger.warn('account locked after login failures', { userId, attempts: next });
    return true; // 本次已锁定
  }
  await query(`UPDATE users SET failed_attempts = $2 WHERE id = $1`, [userId, next]);
  return false;
}

export async function resetFailedAttempts(userId: string): Promise<void> {
  await query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`, [userId]);
}

// ---------- 会话 / 设备管理 ----------

export interface DeviceInfo {
  id: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

export async function listDevices(userId: string, currentSessionId?: string): Promise<DeviceInfo[]> {
  const rows = await query<{ id: string; ip: string; user_agent: string; created_at: Date; expires_at: Date }>(
    `SELECT id, ip, user_agent, created_at, expires_at FROM sessions
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );
  return rows.rows.map((r) => ({
    id: r.id,
    ip: r.ip || '',
    userAgent: r.user_agent || '',
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    current: r.id === currentSessionId,
  }));
}

export async function revokeDevice(userId: string, sessionId: string, currentSessionId?: string): Promise<void> {
  if (sessionId === currentSessionId) throw ApiError.badRequest('不能下线当前设备（请使用退出登录）');
  const r = await query(
    `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [sessionId, userId]
  );
  if ((r.rowCount ?? 0) === 0) throw ApiError.notFound('会话不存在或已下线');
}

// ---------- 异常登录检测（新设备 / IP 变化；无 IP 地理库，用设备特征近似） ----------

export interface AnomalyResult {
  anomalous: boolean;
  reason?: string;
}

/** 与最近一次成功登录的会话对比：IP 或 UA 变化视为异常（提醒邮件在路由层发送） */
export async function detectLoginAnomaly(userId: string, ip: string, ua: string): Promise<AnomalyResult> {
  const last = await queryOne<{ ip: string; user_agent: string }>(
    `SELECT ip, user_agent FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (!last) return { anomalous: false };
  const lastIp = last.ip || '';
  const lastUa = last.user_agent || '';
  const ipChanged = lastIp && ip && lastIp !== ip;
  const uaChanged = lastUa && ua && lastUa !== ua;
  if (ipChanged && uaChanged) {
    return { anomalous: true, reason: '新设备/IP 登录' };
  }
  if (ipChanged) {
    return { anomalous: true, reason: '登录 IP 变化' };
  }
  return { anomalous: false };
}

// 便于审计
export { crypto };
