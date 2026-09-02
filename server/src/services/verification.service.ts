// 通用验证码服务：注册等场景的邮箱/手机验证码（发送限流、一次性、尝试上限）
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { query, queryOne } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { config } from '../config/index.js';

const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_HOUR = 5;
const SEND_COOLDOWN_SEC = 60;

interface CodeRow {
  id: number;
  code: string;
  expires_at: Date;
  used_at: Date | null;
  attempts: number;
  created_at: Date;
}

function randomCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 发送验证码（邮件或短信）；返回是否真实发出（目标为空/通道未配返回 false） */
export async function sendVerificationCode(scene: string, target: string): Promise<{ sent: boolean; masked: string }> {
  const masked = target.length > 4 ? target.slice(0, 3) + '***' + target.slice(-4) : '***';

  // 限流：1 小时最多 5 次 + 60s 冷却
  const recent = await queryOne<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM verification_codes WHERE scene = $1 AND target = $2 AND created_at > now() - interval '1 hour'`,
    [scene, target]
  );
  if (Number(recent?.c ?? 0) >= MAX_SENDS_PER_HOUR) {
    throw ApiError.tooManyRequests('发送过于频繁，请 1 小时后再试');
  }
  const last = await queryOne<CodeRow>(
    `SELECT * FROM verification_codes WHERE scene = $1 AND target = $2 ORDER BY id DESC LIMIT 1`,
    [scene, target]
  );
  if (last && Date.now() - new Date(last.created_at).getTime() < SEND_COOLDOWN_SEC * 1000) {
    throw ApiError.tooManyRequests('发送过于频繁，请稍后再试');
  }

  const isEmail = target.includes('@');
  const smsWebhook = config.resetSmsWebhook; // 复用找回短信网关
  if (isEmail && !config.resetMailHost) return { sent: false, masked };
  if (!isEmail && !smsWebhook) return { sent: false, masked };

  const code = randomCode();
  try {
    if (isEmail) {
      const transport = nodemailer.createTransport({
        host: config.resetMailHost,
        port: config.resetMailPort,
        secure: config.resetMailSecure,
        auth: config.resetMailUser ? { user: config.resetMailUser, pass: config.resetMailPass } : undefined,
      });
      await transport.sendMail({
        from: config.resetMailFrom || config.resetMailUser,
        to: target,
        subject: '【企业网盘】注册验证码',
        text: `您的注册验证码是：${code}\n验证码 ${CODE_TTL_MIN} 分钟内有效。`,
      });
    } else {
      const res = await fetch(smsWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: target, code, ttlMinutes: CODE_TTL_MIN, scene }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`短信网关 HTTP ${res.status}`);
    }
  } catch (err) {
    logger.warn('verification code send failed', { scene, message: (err as Error).message });
    throw new ApiError(500, 'INTERNAL_ERROR', '验证码发送失败，请稍后重试');
  }
  await query(
    `INSERT INTO verification_codes (scene, target, code, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [scene, target, code, CODE_TTL_MIN]
  );
  return { sent: true, masked };
}

export async function verifyCode(scene: string, target: string, codeInput: string): Promise<boolean> {
  const row = await queryOne<CodeRow>(
    `SELECT * FROM verification_codes WHERE scene = $1 AND target = $2 AND used_at IS NULL ORDER BY id DESC LIMIT 1`,
    [scene, target]
  );
  if (!row) return false;
  if (row.expires_at < new Date()) return false;
  if (row.attempts >= MAX_ATTEMPTS) return false;
  if (row.code !== codeInput) {
    await query(`UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    return false;
  }
  await query(`UPDATE verification_codes SET used_at = now() WHERE id = $1`, [row.id]);
  return true;
}

/** 定时清理过期验证码 */
export async function cleanupVerificationCodes(): Promise<number> {
  const r = await query(`DELETE FROM verification_codes WHERE expires_at < now() - interval '7 days'`);
  return r.rowCount ?? 0;
}
