// 认证路由：登录（多方式/2FA）/ 注册 / 找回密码 / 2FA 管理 / 设备管理 / CAPTCHA
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { asyncHandler, ApiError } from '../lib/errors.js';
import { rateLimit } from '../lib/rateLimit.js';
import { writeAudit } from '../lib/audit.js';
import { CSRF_COOKIE } from '../lib/csrf.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { changePassword, login, logout, refresh, register, verify2faStep } from '../services/auth.service.js';
import { ldapStatus } from '../ldap/provider.js';
import { requestReset, resetPassword, resetPasswordByLink, resetChannelsEnabled } from '../services/password-reset.service.js';
import { generateCaptcha, verifyCaptcha } from '../lib/captcha.js';
import { sendVerificationCode } from '../services/verification.service.js';
import { disableTwoFactor, enableTwoFactor, generateTwoFactorSetup, listDevices, revokeDevice } from '../services/security.service.js';
import { query, queryOne } from '../db/pool.js';
import { verifyRefreshToken } from '../lib/token.js';

export const REFRESH_COOKIE = 'nd_refresh';

const router = Router();

function setAuthCookies(res: import('express').Response, refreshToken: string, csrfToken: string, maxAgeSec: number): void {
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: config.minio.publicUseSSL,
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeSec * 1000,
    signed: true,
  });
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure: config.minio.publicUseSSL,
    sameSite: 'strict',
    path: '/',
  });
}

function clearAuthCookies(res: import('express').Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

function currentSessionId(req: import('express').Request): string | undefined {
  const token = (req.signedCookies as Record<string, string>)?.[REFRESH_COOKIE];
  if (!token) return undefined;
  try {
    return verifyRefreshToken(token).sid as string | undefined;
  } catch {
    return undefined;
  }
}

// 算术验证码（防机器人注册/发码）
router.get(
  '/captcha',
  asyncHandler(async (_req, res) => {
    res.json(await generateCaptcha());
  })
);

// 登录（多方式：账号/邮箱/手机号；限流防爆破 + 账号锁定 + 可选 2FA）
router.post(
  '/login',
  rateLimit({ windowMs: 60_000, max: 8, key: (ip, username) => `login:${ip}:${username ?? ''}` }),
  validateBody(
    z.object({
      identifier: z.string().min(1).max(128).optional(),
      username: z.string().min(1).max(128).optional(), // 兼容旧客户端
      password: z.string().min(1).max(128),
    })
  ),
  asyncHandler(async (req, res) => {
    const body = req.body as { identifier?: string; username?: string; password: string };
    const identifier = (body.identifier ?? body.username ?? '').trim();
    const result = await login(identifier, body.password, req.ip ?? '', req.headers['user-agent'] ?? '');
    if (!result.require2fa) {
      setAuthCookies(res, result.refreshToken, result.csrfToken, result.refreshExpiresIn);
    }
    (req as unknown as { user?: import('../middleware/auth.js').AuthedUser }).user = result.user;
    await writeAudit(req, { action: 'login', detail: { identifier, require2fa: !!result.require2fa, risk: result.risk } });
    res.json({
      accessToken: result.accessToken,
      user: result.user,
      require2fa: result.require2fa,
      challengeToken: result.challengeToken,
      risk: result.risk,
    });
  })
);

// 2FA 第二步：TOTP 验证后完成登录
router.post(
  '/2fa/verify',
  rateLimit({ windowMs: 60_000, max: 10, key: (ip) => `2fa:${ip ?? ''}` }),
  validateBody(z.object({ challengeToken: z.string().min(10), code: z.string().length(6) })),
  asyncHandler(async (req, res) => {
    const { challengeToken, code } = req.body as { challengeToken: string; code: string };
    const result = await verify2faStep(challengeToken, code, req.ip ?? '', req.headers['user-agent'] ?? '');
    setAuthCookies(res, result.refreshToken, result.csrfToken, result.refreshExpiresIn);
    (req as unknown as { user?: import('../middleware/auth.js').AuthedUser }).user = result.user;
    await writeAudit(req, { action: 'login_2fa', detail: { ok: true } });
    res.json({ accessToken: result.accessToken, user: result.user, risk: result.risk });
  })
);

// ---------- 自助注册 ----------

router.post(
  '/register/send-code',
  rateLimit({ windowMs: 10 * 60_000, max: 10, key: (ip) => `reg-send:${ip ?? ''}` }),
  validateBody(z.object({ target: z.string().max(255), captchaId: z.string().min(8), captchaAnswer: z.number().int() })),
  asyncHandler(async (req, res) => {
    const { target, captchaId, captchaAnswer } = req.body as { target: string; captchaId: string; captchaAnswer: number };
    if (!(await verifyCaptcha(captchaId, captchaAnswer))) throw new ApiError(400, 'BAD_REQUEST', '验证码错误，请重试');
    const t = target.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) && !/^1\d{10}$/.test(t)) {
      throw new ApiError(400, 'BAD_REQUEST', '请输入有效邮箱或手机号');
    }
    const result = await sendVerificationCode('register', t);
    res.json({ ok: true, sent: result.sent, masked: result.masked, message: result.sent ? '验证码已发送' : '验证码发送不可用，请联系管理员' });
  })
);

router.post(
  '/register',
  rateLimit({ windowMs: 10 * 60_000, max: 10, key: (ip) => `reg:${ip ?? ''}` }),
  validateBody(
    z.object({
      username: z.string().min(3).max(32),
      password: z.string().min(8).max(128),
      displayName: z.string().max(64).optional(),
      target: z.string().max(255),
      code: z.string().length(6),
      agreeTerms: z.boolean(),
      captchaId: z.string().min(8).optional(),
      captchaAnswer: z.number().int().optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const body = req.body as { username: string; password: string; displayName?: string; target: string; code: string; agreeTerms: boolean; captchaId?: string; captchaAnswer?: number };
    if (body.captchaId && !(await verifyCaptcha(body.captchaId, body.captchaAnswer ?? NaN))) {
      res.status(400).json({ code: 'BAD_REQUEST', message: '验证码错误，请重试' });
      return;
    }
    const user = await register({
      username: body.username,
      password: body.password,
      displayName: body.displayName,
      target: body.target.trim(),
      code: body.code,
      agreeTerms: body.agreeTerms,
    });
    await writeAudit(req, { action: 'register', targetId: user.id, detail: { username: user.username } });
    res.json({ ok: true, message: '注册成功，请登录' });
  })
);

// ---------- 2FA 管理（需登录） ----------

router.post(
  '/2fa/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    const setup = await generateTwoFactorSetup(req.user!);
    await query(`UPDATE users SET twofa_secret = $2 WHERE id = $1`, [req.user!.id, setup.secret]);
    await writeAudit(req, { action: '2fa_setup' });
    res.json({ qrDataUrl: setup.qrDataUrl, secret: setup.secret });
  })
);

router.post(
  '/2fa/confirm',
  requireAuth,
  validateBody(z.object({ code: z.string().length(6) })),
  asyncHandler(async (req, res) => {
    const { code } = req.body as { code: string };
    await enableTwoFactor(req.user!.id, code);
    await writeAudit(req, { action: '2fa_enable' });
    res.json({ ok: true });
  })
);

router.post(
  '/2fa/disable',
  requireAuth,
  validateBody(z.object({ code: z.string().length(6), password: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const { code, password } = req.body as { code: string; password: string };
    await disableTwoFactor(req.user!.id, code, password);
    await writeAudit(req, { action: '2fa_disable' });
    res.json({ ok: true });
  })
);

router.get(
  '/2fa/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const u = await queryOne<{ twofa_enabled: boolean; twofa_secret: string | null }>(
      `SELECT twofa_enabled, twofa_secret FROM users WHERE id = $1`,
      [req.user!.id]
    );
    res.json({ enabled: u?.twofa_enabled ?? false, hasSecret: Boolean(u?.twofa_secret) });
  })
);

// ---------- 设备管理（需登录） ----------

router.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ items: await listDevices(req.user!.id, currentSessionId(req)) });
  })
);

router.delete(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    await revokeDevice(req.user!.id, req.params.id, currentSessionId(req));
    await writeAudit(req, { action: 'session_revoke', targetId: req.params.id });
    res.json({ ok: true });
  })
);

// ---------- 忘记密码 ----------

router.get(
  '/password-reset/channels',
  asyncHandler(async (_req, res) => {
    res.json(resetChannelsEnabled());
  })
);

router.post(
  '/password-reset/request',
  rateLimit({ windowMs: 10 * 60_000, max: 10, key: (ip) => `reset:${ip ?? ''}` }),
  validateBody(
    z.object({
      username: z.string().min(1).max(64),
      channel: z.enum(['email', 'sms']),
      mode: z.enum(['code', 'link']).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { username, channel, mode } = req.body as { username: string; channel: 'email' | 'sms'; mode?: 'code' | 'link' };
    const baseUrl = `${req.protocol}://${req.get('host') ?? 'localhost'}`;
    await requestReset({ username: username.trim(), channel, mode, baseUrl });
    res.json({ ok: true, message: '若该账号存在且已绑定联系方式，重置信息将发送到对应邮箱/手机' });
  })
);

router.post(
  '/password-reset/reset',
  rateLimit({ windowMs: 10 * 60_000, max: 20, key: (ip) => `reset-attempt:${ip ?? ''}` }),
  validateBody(
    z.object({
      username: z.string().min(1).max(64),
      channel: z.enum(['email', 'sms']),
      code: z.string().length(6),
      newPassword: z.string().min(8).max(128),
    })
  ),
  asyncHandler(async (req, res) => {
    const { username, channel, code, newPassword } = req.body as { username: string; channel: 'email' | 'sms'; code: string; newPassword: string };
    await resetPassword({ username: username.trim(), channel, code, newPassword });
    await writeAudit(req, { action: 'password_reset', detail: { username, channel } });
    res.json({ ok: true, message: '密码已重置，请使用新密码登录' });
  })
);

// 重置链接方式（一次性、30 分钟）
router.post(
  '/password-reset/reset-link',
  rateLimit({ windowMs: 10 * 60_000, max: 20, key: (ip) => `reset-link:${ip ?? ''}` }),
  validateBody(z.object({ token: z.string().min(20), newPassword: z.string().min(8).max(128) })),
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body as { token: string; newPassword: string };
    await resetPasswordByLink(token, newPassword);
    await writeAudit(req, { action: 'password_reset', detail: { method: 'link' } });
    res.json({ ok: true, message: '密码已重置，请使用新密码登录' });
  })
);

// ---------- 其他 ----------

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = (req.signedCookies as Record<string, string>)?.[REFRESH_COOKIE];
    if (!token) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: '未登录' });
      return;
    }
    const result = await refresh(token, req.ip ?? '', req.headers['user-agent'] ?? '');
    setAuthCookies(res, result.refreshToken, result.csrfToken, result.refreshExpiresIn);
    (req as unknown as { user?: import('../middleware/auth.js').AuthedUser }).user = result.user;
    await writeAudit(req, { action: 'refresh', detail: { username: result.user.username } });
    res.json({ accessToken: result.accessToken, user: result.user });
  })
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const token = (req.signedCookies as Record<string, string>)?.[REFRESH_COOKIE];
    await logout(token);
    clearAuthCookies(res);
    await writeAudit(req, { action: 'logout' });
    res.json({ ok: true });
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user });
  })
);

router.post(
  '/change-password',
  requireAuth,
  validateBody(z.object({ oldPassword: z.string().min(1), newPassword: z.string().min(8).max(128) })),
  asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body as { oldPassword: string; newPassword: string };
    await changePassword(req.user!.id, oldPassword, newPassword);
    await writeAudit(req, { action: 'password_change' });
    res.json({ ok: true });
  })
);

router.get(
  '/ldap-status',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json(ldapStatus());
  })
);

export default router;
