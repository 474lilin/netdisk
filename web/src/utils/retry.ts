// =============================================================================
// 上传重试基础设施（v1.1.5）
// 背景：上传过程中偶发「请求失败，请稍后重试」，点一次重试即可成功——
//       属于典型的瞬时故障（网络抖动 / 网关 502 / MinIO 慢响应 / 签名过期 / 限流）。
//       本模块提供：错误分类 + 指数退避（带抖动）+ 可被「暂停」立即打断的 sleep。
// 原则：可重试的错误自动重试，不可重试的错误（权限/配额/参数/用户暂停）立即失败，
//       避免无谓等待与「假成功」。
// =============================================================================

/** 用户暂停 / 组件卸载导致的中断：不是错误，不计入失败埋点，也不触发自动重试 */
export class AbortError extends Error {
  constructor(message = '任务已暂停') {
    super(message);
    this.name = 'AbortError';
  }
}

/** 带 HTTP 状态码的传输错误（分片 PUT 直连 MinIO 等） */
export class HttpStatusError extends Error {
  readonly status: number;
  /** 服务端建议的等待时间（Retry-After，毫秒） */
  readonly retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export type ErrorKind =
  | 'aborted' // 用户暂停 / 主动中断
  | 'network' // 断网 / DNS / 连接被重置
  | 'timeout' // 请求或传输超时（含长时间无进度卡死）
  | 'rate-limit' // 429 限流
  | 'server' // 5xx 服务端/网关瞬时故障
  | 'signature' // 403：签名过期/无效 —— 重新签名即可重试
  | 'session-expired' // 404：分片会话在 MinIO 侧已失效 —— 需重新 init 会话
  | 'quota' // 507 空间不足
  | 'auth' // 401 登录态失效 —— 交给全局登录态治理
  | 'client'; // 400/参数/业务拒绝，重试无意义

export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === 'string' ? err : '未知错误');
}

export function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; code?: string } | null;
  return e?.name === 'AbortError' || e?.name === 'AbortSignalAbortError' || e?.code === 'ABORT_ERR';
}

export function isHttpStatusError(err: unknown): boolean {
  return err instanceof HttpStatusError;
}

/** 错误分类：统一识别 ApiError（client.ts）/ HttpStatusError / fetch TypeError */
export function classifyError(err: unknown): ErrorKind {
  if (isAbortError(err)) return 'aborted';
  const e = err as { status?: number; code?: string; name?: string } | null;
  const status = typeof e?.status === 'number' ? e.status : 0;
  const code = typeof e?.code === 'string' ? e.code : '';

  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'NETWORK') return 'network';
  if (code === 'AUTH_FAILED') return 'auth';

  if (status === 401) return 'auth';
  if (status === 403) return 'signature';
  if (status === 404) return 'session-expired';
  if (status === 408 || status === 425) return 'timeout';
  if (status === 429) return 'rate-limit';
  if (status === 507) return 'quota';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';

  // fetch 断网 / CORS / 连接被拒：TypeError，无 status
  if (e?.name === 'TypeError') return 'network';
  // 无状态码的传输错误（HttpStatusError(0) 或 XHR onerror）
  if (/网络|network|Failed to fetch|Load failed|ERR_/i.test(toError(err).message)) return 'network';
  if (/超时|timeout|无进度/i.test(toError(err).message)) return 'timeout';
  return 'client';
}

/** 是否值得自动重试 */
export function isRetryableError(err: unknown): boolean {
  switch (classifyError(err)) {
    case 'network':
    case 'timeout':
    case 'rate-limit':
    case 'server':
    case 'signature':
    case 'session-expired':
      return true;
    default:
      return false;
  }
}

/** 会话在 MinIO 侧已失效：重新签名也无用，只能重新 init（交给任务级重试重开会话） */
export function isSessionExpiredError(err: unknown): boolean {
  return classifyError(err) === 'session-expired';
}

/**
 * 是否属于「瞬时故障」——仅这类才值得重试（v1.1.11）
 * 用于 init / complete / presign 等语义明确的接口：
 *   404「目录不存在」/「会话不存在」、403「无权限」重试多少次都不会成功；
 *   旧实现把它们一律当可重试 → 大量无效请求（实测：目录被删后 2 分钟 291 次 404 风暴）
 */
export function isTransientError(err: unknown): boolean {
  const k = classifyError(err);
  return k === 'network' || k === 'timeout' || k === 'rate-limit' || k === 'server';
}

/** 目标目录已不存在/无写入权限（重试无意义，必须由用户重新选择目录） */
export function isDirGoneError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status ?? 0;
  if (status !== 404 && status !== 403) return false;
  return /目录不存在|目录已不存在|无权限|权限/.test(toError(err).message);
}

/** 签名过期/无效：重新签发 URL 后重试同一分片 */
export function isSignatureExpiredError(err: unknown): boolean {
  return classifyError(err) === 'signature';
}

/** 指数退避 + 抖动（避免大量任务同时重试造成惊群） */
export function backoffDelay(attempt: number, baseMs = 600, maxMs = 20_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const jitter = Math.random() * Math.min(400, exp * 0.3);
  return Math.round(exp + jitter);
}

/** 可被 AbortSignal 打断的 sleep：暂停时立即返回，不阻塞 UI 与队列 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new AbortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RetryOptions {
  /** 失败后额外重试次数（总尝试 = retries + 1） */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** 每次重试前回调（用于 UI 提示 / 埋点） */
  onRetry?: (info: { attempt: number; retries: number; delayMs: number; error: Error }) => void;
  /** 自定义「是否可重试」判断（默认 isRetryableError） */
  shouldRetry?: (err: unknown) => boolean;
}

/** 按需重试执行：可重试错误自动退避重试；不可重试 / 用户暂停立即抛出 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 4, baseDelayMs = 600, maxDelayMs = 20_000, signal, onRetry, shouldRetry = isRetryableError } = opts;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new AbortError();
    try {
      return await fn(attempt);
    } catch (err) {
      if (isAbortError(err) || attempt >= retries || !shouldRetry(err)) throw err;
      const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      onRetry?.({ attempt: attempt + 1, retries, delayMs, error: toError(err) });
      await sleep(delayMs, signal); // 暂停时在此立即抛出 AbortError
    }
  }
}
