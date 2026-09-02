// 统一业务错误：携带 HTTP 状态码与错误码，由全局错误中间件转换为响应
import type { NextFunction, Request, Response } from 'express';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = '未登录或登录已过期'): ApiError {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = '没有权限执行该操作'): ApiError {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  static notFound(message = '资源不存在'): ApiError {
    return new ApiError(404, 'NOT_FOUND', message);
  }
  static conflict(message: string): ApiError {
    return new ApiError(409, 'CONFLICT', message);
  }
  static tooManyRequests(message = '请求过于频繁，请稍后再试'): ApiError {
    return new ApiError(429, 'RATE_LIMITED', message);
  }
  static quotaExceeded(message = '存储空间不足'): ApiError {
    return new ApiError(507, 'QUOTA_EXCEEDED', message);
  }
}

// 包装 async 路由，统一捕获异常
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

// 全局错误中间件
export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
    return;
  }
  // express 校验类错误
  const anyErr = err as { status?: number; type?: string };
  if (anyErr?.type === 'entity.too.large') {
    res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' });
    return;
  }
  const status = anyErr?.status && anyErr.status >= 400 && anyErr.status < 600 ? anyErr.status : 500;
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error('[unhandled]', err);
  }
  res.status(status).json({
    code: status >= 500 ? 'INTERNAL_ERROR' : 'ERROR',
    message: status >= 500 ? '服务内部错误' : (err as Error)?.message || '请求失败',
  });
}
