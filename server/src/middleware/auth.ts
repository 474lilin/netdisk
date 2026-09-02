// 认证中间件：Bearer Access Token -> 实时加载用户 -> 挂载 req.user
import type { NextFunction, Request, Response } from 'express';
import { queryOne } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/token.js';
import type { Role, UserRow } from '../types/index.js';

export interface AuthedUser {
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

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

function parseBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = parseBearer(req);
    if (!token) throw ApiError.unauthorized();
    const payload = verifyAccessToken(token);
    if (payload.typ !== 'access') throw ApiError.unauthorized();

    const user = await queryOne<UserRow>(
      `SELECT id, org_id, username, display_name, role, dept_id, quota_bytes, used_bytes, status, auth_source
       FROM users WHERE id = $1`,
      [payload.sub]
    );
    if (!user) throw ApiError.unauthorized('账号不存在');
    if (user.status !== 1) throw ApiError.forbidden('账号已被禁用');

    req.user = {
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
    next();
  } catch (err) {
    next(err instanceof ApiError ? err : ApiError.unauthorized());
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(ApiError.unauthorized());
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(ApiError.forbidden('需要更高权限'));
      return;
    }
    next();
  };
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(ApiError.unauthorized());
    return;
  }
  if (req.user.role !== 1) {
    next(ApiError.forbidden('仅企业管理员可操作'));
    return;
  }
  next();
}
