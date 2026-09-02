// =============================================================================
// Token 主动续期（v1.0.13）：长耗时上传场景的 Token 过期治理第一轮
// - 解码 access_token 的 exp（JWT payload），记录 tokenExpireAt
// - 60s 定时器检查：距过期 ≤10min 触发主动刷新（源头减少 401 命中）
// - 并发刷新锁：多任务并行时仅 1 个刷新请求在途，其余等待共享 Promise
// - 刷新 5s 超时：超时降级为「暂停-需重新登录」（不静默丢弃上传）
// =============================================================================
import { getToken, setToken } from '../api/client';
import { useAuthStore } from '../store/auth';

// 刷新接口超时（独立于业务请求 30s：刷新应快速失败以便降级，不阻塞上传分片）
export const REFRESH_TIMEOUT = 5_000;
// 主动续期阈值：距过期 ≤10min 触发刷新
export const REFRESH_AHEAD_MS = 10 * 60 * 1000;
// 定时器周期
export const CHECK_INTERVAL_MS = 60 * 1000;
// 刷新失败重试间隔（指数退避 1s/2s/4s/8s，最多 4 次；R2 缓解）
const RETRY_BASE_MS = 1000;
const MAX_RETRIES = 4;
// 刷新最短间隔（防 429 限流）
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;

let tokenExpireAt: number | null = null;
let refreshPromise: Promise<boolean> | null = null;
let lastRefreshAt = 0;
let refreshFailStreak = 0;

/** 解码 JWT payload（不校验签名，仅取 exp 用于过期预测） */
export function decodeTokenExp(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    // base64url → JSON
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const data = JSON.parse(json) as { exp?: number };
    return typeof data.exp === 'number' ? data.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** 登录/刷新后记录 token 过期时刻 */
export function trackToken(): void {
  const token = getToken();
  tokenExpireAt = token ? decodeTokenExp(token) : null;
}

/** 距过期剩余毫秒；未知返回 Infinity（视为无需主动刷新） */
export function timeToExpiry(): number {
  if (tokenExpireAt == null) {
    trackToken();
    if (tokenExpireAt == null) return Infinity;
  }
  return tokenExpireAt - Date.now();
}

/** 刷新 access_token（并发锁 + 5s 超时 + 指数退避）。返回是否成功
 *  force=true（401 纠错场景）：无视 60s 间隔，必须尝试刷新 */
export async function refreshTokenWithGuard(force = false): Promise<boolean> {
  // 并发锁：已在途则共享同一 Promise
  if (refreshPromise) return refreshPromise;

  // 防 429：距上次刷新 <60s 且非必要（尚未接近过期）时直接沿用；首次刷新（lastRefreshAt=0）不受限
  if (!force && lastRefreshAt > 0 && Date.now() - lastRefreshAt < MIN_REFRESH_INTERVAL_MS && timeToExpiry() > REFRESH_AHEAD_MS * 2) {
    return true;
  }

  refreshPromise = doRefreshWithRetry().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function doRefreshWithRetry(): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // 指数退避：1s/2s/4s/8s
      const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
    const ok = await doRefreshOnce();
    if (ok) {
      refreshFailStreak = 0;
      lastRefreshAt = Date.now();
      return true;
    }
    refreshFailStreak += 1;
  }
  return false;
}

async function doRefreshOnce(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REFRESH_TIMEOUT);
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { accessToken: string; user: unknown };
    setToken(data.accessToken);
    trackToken();
    useAuthStore.getState().setUser(data.user as never);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 定时器：检查并主动续期（挂在页面生命周期内） */
export function startTokenRefreshTimer(): () => void {
  const timer = setInterval(() => {
    // 非登录态跳过
    if (!getToken()) return;
    const remain = timeToExpiry();
    if (remain <= REFRESH_AHEAD_MS) {
      void refreshTokenWithGuard();
    }
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

/** 切回前台时立即检查（R4：后台定时器被浏览器节流，不依赖其精度） */
export function checkTokenOnVisible(): void {
  if (document.visibilityState !== 'visible') return;
  if (!getToken()) return;
  const remain = timeToExpiry();
  if (remain <= REFRESH_AHEAD_MS) {
    void refreshTokenWithGuard();
  }
}

/** 刷新失败连续次数（埋点/降级判断用） */
export function getRefreshFailStreak(): number {
  return refreshFailStreak;
}
