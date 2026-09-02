// CSRF 防护：双重提交 Cookie 模式
// - 登录/刷新成功后下发非 httpOnly 的 nd_csrf Cookie
// - 前端对写操作携带 X-CSRF-Token 请求头，服务端比对 Cookie 值
// - 配合 Refresh Cookie 的 SameSite=Strict，双层防护
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './errors.js';

export const CSRF_COOKIE = 'nd_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfProtect(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const cookie = (req.cookies as Record<string, string>)?.[CSRF_COOKIE];
  const header = req.headers[CSRF_HEADER];
  if (!cookie || !header || cookie !== header) {
    next(ApiError.forbidden('CSRF 校验失败，请刷新页面后重试'));
    return;
  }
  next();
}
