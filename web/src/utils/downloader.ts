// =============================================================================
// 下载引擎（v1.1.10）：带进度的流式下载，供「上传/下载任务列表」统一展示
// - 单文件：MinIO 预签名 URL（直连，不占业务带宽）
// - 文件夹：/api/files/:id/download-dir（后端 zip 流式打包，需鉴权头）
// - 超大文件：交还浏览器原生下载（避免把 GB 级内容读进内存），任务记为「已交给浏览器」
// - 支持 AbortSignal 取消；进度按 content-length 计算（未知时显示已下载字节）
// =============================================================================

export interface DownloadCtx {
  signal: AbortSignal;
  /** bytesDone=已下载字节；totalBytes=0 表示未知（UI 显示不确定进度） */
  onProgress: (bytesDone: number, totalBytes: number) => void;
}

/** 超过该大小不再读进内存，改为交给浏览器原生下载 */
const DIRECT_OPEN_LIMIT = 1.5 * 1024 * 1024 * 1024; // 1.5GB

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface DownloadOptions {
  /** 目标文件名（含扩展名） */
  fileName: string;
  /** 额外请求头（鉴权接口用） */
  headers?: Record<string, string>;
  /** 已知文件大小（用于预判超大文件与进度总量） */
  knownSize?: number;
  /** 服务端返回的是 JSON 错误体（API 接口）而不是文件内容 */
  jsonError?: boolean;
}

/**
 * 下载一个 URL 到本地文件（带进度）。
 * 抛出错误时 message 为可直接展示的中文（含 HTTP 状态/服务端 message）。
 */
export async function downloadToFile(url: string, ctx: DownloadCtx, opts: DownloadOptions): Promise<void> {
  const { fileName, headers, knownSize = 0, jsonError = false } = opts;

  const res = await fetch(url, { headers, signal: ctx.signal, credentials: 'same-origin' });
  if (!res.ok) {
    let msg = `下载失败（HTTP ${res.status}）`;
    if (jsonError || (res.headers.get('content-type') || '').includes('application/json')) {
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      if (data?.message) msg = data.message;
    }
    throw new Error(msg);
  }

  const totalBytes = Number(res.headers.get('content-length')) || knownSize || 0;

  // 超大文件（拿到真实大小后判断）或流不可用：交给浏览器原生下载
  if (totalBytes > DIRECT_OPEN_LIMIT) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    ctx.onProgress(totalBytes, totalBytes);
    return;
  }

  if (!res.body) {
    const blob = await res.blob();
    if (ctx.signal.aborted) return;
    ctx.onProgress(blob.size, blob.size || totalBytes);
    saveBlob(blob, fileName);
    return;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    if (value) {
      chunks.push(value);
      done += value.byteLength;
      ctx.onProgress(done, totalBytes);
    }
  }
  if (ctx.signal.aborted) return;
  ctx.onProgress(done, totalBytes || done);
  saveBlob(new Blob(chunks as BlobPart[]), fileName);
}

/** 已知是超大文件：直接交给浏览器下载（同步返回，不占内存） */
export function downloadDirect(url: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export { DIRECT_OPEN_LIMIT };
