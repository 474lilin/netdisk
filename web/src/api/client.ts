// API 客户端：统一鉴权（Bearer + CSRF 双重提交）+ Access Token 自动刷新
// v1.0.13：刷新走 token-refresh 核心（并发锁/5s 超时/指数退避）；401 触发上传队列暂停（不静默丢任务）
const TOKEN_KEY = 'nd_access_token';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function getCsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)nd_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

// 401 后暂停上传队列（保留任务，登录后可恢复）——避免长耗时上传中 Token 过期导致任务静默丢失
async function notifyAuthPaused(): Promise<void> {
  try {
    const { useUploadStore } = await import('../store/upload');
    const s = useUploadStore.getState();
    if (Object.keys(s.tasks).length > 0 && !s.paused) {
      s.pauseForAuth();
    }
  } catch {
    /* 上传 store 未加载（非上传场景）则忽略 */
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined | null>;
  auth?: boolean;
  /** 覆盖默认超时（ms）——大批量 purge/删除等长操作使用 */
  timeout?: number;
}

// 统一请求超时：接口挂起时不再无限 loading
const REQUEST_TIMEOUT = 30_000;

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, params, auth = true, timeout = REQUEST_TIMEOUT } = opts;

  let url = path;
  if (params) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
    }
    const qs = sp.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  // 统一 fetch 封装：30s 超时（可覆盖）+ 网络错误归一化为友好中文（断网/代理错误不再抛英文 TypeError）
  const doFetch = (): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    return fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
      .catch((e: unknown) => {
        if ((e as Error)?.name === 'AbortError') throw new ApiError('TIMEOUT', '请求超时，请稍后重试', 0);
        throw new ApiError('NETWORK', '网络连接失败，请检查网络后重试', 0);
      })
      .finally(() => clearTimeout(timer));
  };

  let res = await doFetch();

  // Access Token 过期：刷新一次并重试（走 token-refresh 核心：并发锁/5s 超时/指数退避）
  if (res.status === 401 && auth && !path.startsWith('/auth/login') && !path.startsWith('/auth/refresh')) {
    const { refreshTokenWithGuard, trackToken } = await import('../utils/token-refresh');
    const ok = await refreshTokenWithGuard(true); // 401 纠错：无视 60s 间隔，必须尝试刷新
    if (ok) {
      const t = getToken();
      if (t) headers.Authorization = `Bearer ${t}`;
      trackToken();
      res = await doFetch();
    } else {
      // 刷新失败：暂停上传队列（若在传）→ 抛结构化错误；登录页场景直接提示
      await notifyAuthPaused();
      clearToken();
      if (window.location.pathname !== '/login') {
        try {
          sessionStorage.setItem('nd_login_msg', '登录已过期，请重新登录后继续上传');
        } catch {
          /* ignore */
        }
      }
      throw new ApiError('AUTH_FAILED', '登录已过期，请重新登录', 401);
    }
  }

  let data: unknown = {};
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }

  if (!res.ok) {
    const d = data as { code?: string; message?: string } | null;
    const msg = d?.message || (res.status >= 500 ? '服务暂时不可用，请稍后重试' : `请求失败（${res.status}）`);
    throw new ApiError(d?.code || 'ERROR', msg, res.status);
  }
  return data as T;
}

/** 上传二进制（XHR，带进度）到签名 URL */
export function uploadBlob(url: string, blob: Blob, onProgress?: (loaded: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`上传失败（HTTP ${xhr.status}），请稍后重试`));
    };
    xhr.onerror = () => reject(new Error('网络中断，上传失败，可稍后重试'));
    xhr.send(blob);
  });
}
