// 密码找回：邮箱 / 短信（自建网关 webhook）双通道 + 重置链接
// - 仅支持本地账号（auth_source=local），LDAP 账号由域内管理
// - 验证码 6 位、10 分钟有效、最多 5 次校验尝试、每账号 1 小时最多 5 次发送
// - 重置链接：一次性、30 分钟有效、重置后吊销全部会话强制重新登录
// - 通道未配置时返回统一提示（不泄露账号是否存在）
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { query, queryOne } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { hashPassword } from '../lib/password.js';
import { config } from '../config/index.js';
import type { UserRow } from '../types/index.js';
import { assertPasswordNotReused, recordPasswordHistory, validatePasswordStrength } from './security.service.js';

const CODE_TTL_MIN = 10;
const LINK_TTL_MIN = 30;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_HOUR = 5;
const SEND_COOLDOWN_SEC = 60;

interface ResetCodeRow {
  id: number;
  user_id: string;
  channel: string;
  code: string;
  link_token: string | null;
  expires_at: Date;
  used_at: Date | null;
  attempts: number;
  created_at: Date;
}

export function resetChannelsEnabled(): { email: boolean; sms: boolean } {
  return { email: Boolean(config.resetMailHost), sms: Boolean(config.resetSmsWebhook) };
}

function randomCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function randomLinkToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

async function sendMail(to: string, codeOrLink: string, isLink: boolean): Promise<void> {
  const transport = nodemailer.createTransport({
    host: config.resetMailHost,
    port: config.resetMailPort,
    secure: config.resetMailSecure,
    auth: config.resetMailUser ? { user: config.resetMailUser, pass: config.resetMailPass } : undefined,
  });
  const body = isLink
    ? `您请求了密码重置，请在 ${LINK_TTL_MIN} 分钟内点击以下链接设置新密码：\n\n${codeOrLink}\n\n（链接一次性有效；如非本人操作请忽略本邮件）`
    : `您的密码重置验证码是：${codeOrLink}\n验证码 ${CODE_TTL_MIN} 分钟内有效，请勿泄露给他人。\n\n（系统自动发送，请勿回复）`;
  await transport.sendMail({
    from: config.resetMailFrom || config.resetMailUser,
    to,
    subject: isLink ? '【企业网盘】密码重置链接' : '【企业网盘】密码重置验证码',
    text: body,
  });
}

async function sendSms(phone: string, code: string): Promise<void> {
  const res = await fetch(config.resetSmsWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code, ttlMinutes: CODE_TTL_MIN, scene: 'password_reset' }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`短信网关 HTTP ${res.status}`);
}

export async function requestReset(input: {
  username: string;
  channel: 'email' | 'sms';
  mode?: 'code' | 'link';
  baseUrl?: string;
}): Promise<void> {
  const channels = resetChannelsEnabled();
  if (input.channel === 'email' && !channels.email) throw ApiError.badRequest('未配置邮箱通道，请联系管理员');
  if (input.channel === 'sms' && !channels.sms) throw ApiError.badRequest('未配置短信通道，请联系管理员');
  const mode = input.mode ?? 'code';
  // 链接模式仅支持邮箱（短信只能发验证码）
  if (mode === 'link' && input.channel !== 'email') throw ApiError.badRequest('短信通道仅支持验证码方式');

  // 统一模糊响应：无论账号是否存在/可重置，返回相同结果
  const respond = (): void => {
    /* 无返回体，调用方统一提示 */
  };

  const user = await queryOne<UserRow>('SELECT * FROM users WHERE username = $1 AND status = 1 LIMIT 1', [input.username]);
  if (!user || user.auth_source !== 'local') {
    respond();
    return; // 账号不存在或非本地账号：不泄露信息，直接返回
  }

  const target = input.channel === 'email' ? user.email : user.phone;
  if (!target) {
    respond();
    return; // 用户未绑定该通道联系方式
  }

  // 限流：1 小时最多 5 次；距上次发送不足 60s 拒绝
  const recent = await queryOne<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM password_reset_codes WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
    [user.id]
  );
  if (Number(recent?.c ?? 0) >= MAX_SENDS_PER_HOUR) {
    throw ApiError.tooManyRequests('发送过于频繁，请 1 小时后再试');
  }
  const last = await queryOne<ResetCodeRow>(
    `SELECT * FROM password_reset_codes WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [user.id]
  );
  if (last && Date.now() - new Date(last.created_at).getTime() < SEND_COOLDOWN_SEC * 1000) {
    throw ApiError.tooManyRequests('发送过于频繁，请稍后再试');
  }

  const isLink = mode === 'link';
  const codeOrToken = isLink ? randomLinkToken() : randomCode();
  // 发送失败不落库（避免占用限流额度）
  try {
    if (input.channel === 'email') {
      const payload = isLink ? `${input.baseUrl ?? ''}/reset-password?token=${codeOrToken}` : codeOrToken;
      await sendMail(target, payload, isLink);
    } else {
      await sendSms(target, codeOrToken);
    }
  } catch (err) {
    logger.warn('password reset send failed', { channel: input.channel, message: (err as Error).message });
    throw new ApiError(500, 'INTERNAL_ERROR', '验证码发送失败，请稍后重试或联系管理员');
  }
  await query(
    `INSERT INTO password_reset_codes (user_id, channel, target, code, link_token, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
    [user.id, input.channel, target, isLink ? '' : codeOrToken, isLink ? codeOrToken : null, isLink ? LINK_TTL_MIN : CODE_TTL_MIN]
  );
  logger.info('password reset sent', { userId: user.id, channel: input.channel, mode, target: target.slice(0, 3) + '***' });
  respond();
}

export async function resetPassword(input: { username: string; channel: 'email' | 'sms'; code: string; newPassword: string }): Promise<void> {
  if (!input.code || input.code.length !== 6) throw ApiError.badRequest('请输入 6 位验证码');
  validatePasswordStrength(input.newPassword);

  const user = await queryOne<UserRow>('SELECT * FROM users WHERE username = $1 AND status = 1 LIMIT 1', [input.username]);
  if (!user || user.auth_source !== 'local') throw ApiError.badRequest('账号不存在或不可重置');

  const row = await queryOne<ResetCodeRow>(
    `SELECT * FROM password_reset_codes
     WHERE user_id = $1 AND channel = $2 AND used_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [user.id, input.channel]
  );
  if (!row) throw ApiError.badRequest('验证码不存在，请重新获取');
  if (row.expires_at < new Date()) throw ApiError.badRequest('验证码已过期，请重新获取');
  if (row.attempts >= MAX_ATTEMPTS) throw ApiError.badRequest('尝试次数过多，请重新获取验证码');

  if (row.code !== input.code) {
    await query(`UPDATE password_reset_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    throw ApiError.badRequest('验证码错误');
  }

  await applyNewPassword(user, input.newPassword, row.id);
  logger.info('password reset done', { userId: user.id, channel: input.channel, method: 'code' });
}

/** 通过重置链接重置密码（链接一次性、30 分钟有效） */
export async function resetPasswordByLink(linkToken: string, newPassword: string): Promise<void> {
  if (!linkToken || linkToken.length < 20) throw ApiError.badRequest('重置链接无效');
  validatePasswordStrength(newPassword);

  const row = await queryOne<ResetCodeRow>(
    `SELECT * FROM password_reset_codes WHERE link_token = $1 AND used_at IS NULL LIMIT 1`,
    [linkToken]
  );
  if (!row) throw ApiError.badRequest('重置链接无效或已被使用');
  if (row.expires_at < new Date()) throw ApiError.badRequest('重置链接已过期，请重新申请');
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1 AND status = 1', [row.user_id]);
  if (!user || user.auth_source !== 'local') throw ApiError.badRequest('账号不存在或不可重置');

  await applyNewPassword(user, newPassword, row.id);
  logger.info('password reset done (link)', { userId: user.id });
}

async function applyNewPassword(user: UserRow, newPassword: string, resetRowId: number): Promise<void> {
  await assertPasswordNotReused(user.id, newPassword);
  const passwordHash = await hashPassword(newPassword);
  await query(`UPDATE users SET password_hash = $2, password_updated_at = now(), updated_at = now() WHERE id = $1`, [user.id, passwordHash]);
  await recordPasswordHistory(user.id, passwordHash);
  // 作废验证码/链接 + 吊销全部会话（强制重新登录）
  await query(`UPDATE password_reset_codes SET used_at = now() WHERE id = $1`, [resetRowId]);
  await query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
}

/** 定时清理过期/已用验证码（保留期 7 天审计） */
export async function cleanupExpiredResetCodes(): Promise<number> {
  const r = await query(
    `DELETE FROM password_reset_codes WHERE used_at IS NOT NULL AND used_at < now() - interval '7 days'
      OR (used_at IS NULL AND expires_at < now() - interval '7 days')`
  );
  return r.rowCount ?? 0;
}
