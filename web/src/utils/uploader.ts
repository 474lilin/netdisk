// =============================================================================
// 分片断点续传上传引擎（v1.1.8：瞬时故障自动重试 + 暂停/继续 + complete 幂等自愈）
// 流程: init(校验配额/去重/签发) -> 单请求直传 或 分片并发上传(记录ETag) -> complete
// 断点续传三级：
//   1) IndexedDB 记录（sessionId/partsEtag/File 引用）——刷新/关闭后保留，小文件自动恢复
//   2) 服务端 /upload/parts 查询——跨设备/清本地后恢复（补齐缺失分片）
//   3) localStorage 旧机制（nd_resume_sessions）——兼容历史版本
// v1.1.5 关键改进（对应「请求失败，请稍后重试，点重试又能成功」）：
//   - 网络抖动/5xx/429/传输卡死 → 指数退避自动重试（无需用户手动点重试）
//   - 分片 PUT 403（签名过期）→ 重新签发该分片 URL 后重试（按需签名，不再一次性签全部）
//   - 404（会话在 MinIO 侧失效）→ 交由任务级重试重开会话（本地记录清理，避免死循环）
//   - 暂停 → 通过 AbortSignal 立即中断传输，已传分片全部保留，继续时断点续传
//   - 进度统计修正：重试同一分片不再重复累加字节（按分片取最大值累计）
// v1.1.8 关键改进（对应「暂停后继续卡在上传中」）：
//   - 暂停信号同时中断 init/presign/complete 等 JSON 接口（此前只中断分片 PUT，
//     导致服务端其实已完成合并、客户端却丢弃结果 → 再次 complete 撞 MinIO NoSuchUpload 而卡死）
//   - complete 失败自愈：用 init 校验内容是否已落库（命中去重即视为成功）
//   - 服务端占位分片（'server'）改为必须重传：无 ETag 的分片无法参与 complete
// 上报：分片 PUT 完成后节流上报服务端 uploaded_parts；完成/失败清理记录
// =============================================================================
import { filesApi } from '../api';
import { uploadBlob } from '../api/client';
import type { FileItem, UploadInitResult } from '../api/types';
import { shouldComputeHash, fileHash } from './hash';
import {
  AbortError,
  HttpStatusError,
  backoffDelay,
  isAbortError,
  isDirGoneError,
  isRetryableError,
  isSessionExpiredError,
  isSignatureExpiredError,
  isTransientError,
  sleep,
  toError,
  withRetry,
} from './retry';
import {
  saveResumeRecord,
  loadResumeRecord,
  removeResumeRecord,
  flushResumeWrites,
  mergeServerParts,
  FILE_PERSIST_LIMIT as _FILE_PERSIST_LIMIT_UNUSED,
  type ResumeRecord,
} from './resume-store';

export interface UploadTaskInput {
  id: string;
  fileName: string;
  size: number;
  dirId: string;
  file: File;
}

export interface TaskProgress {
  bytesDone: number;
  bytesTotal: number;
  /** 阶段标记：hashing=计算内容哈希（大文件耗时），uploading=网络传输 */
  phase?: 'hashing' | 'uploading';
}

export interface TaskResult {
  status: 'completed' | 'dedup' | 'error' | 'paused';
  file?: FileItem;
  error?: string;
  /** 是否属于瞬时故障（队列可自动重新排队重试） */
  retryable?: boolean;
  /** 分片会话在服务端已失效：重试时必须重开会话 */
  sessionExpired?: boolean;
  /** 目标目录已不存在/无权限（v1.1.11）：重试无意义，需用户重新选目录 */
  dirMissing?: boolean;
}

export interface RunUploadOptions {
  /** 暂停/取消信号：中断传输与接口调用并保留断点（返回 status='paused'） */
  signal?: AbortSignal;
}

const PART_CONCURRENCY = 4;
// 单次预签窗口：按需签发（贴近实际上传时刻，规避长耗时上传中签名过期）
const PRESIGN_WINDOW = 32;
// 分片上报节流：每 5 个分片或 5s 上报一次服务端
const REPORT_EVERY_PARTS = 5;
// 单分片自动重试次数
const PART_RETRIES = 4;
// 单分片长时间无进度视为卡死（90s）→ 中断并按瞬时故障重试
const PART_STALL_TIMEOUT = 90_000;
// 进度上报节流：最多 5 次/秒（避免高频 setState 拖慢主线程）
const PROGRESS_THROTTLE_MS = 200;

/** 续传记录 key：dirId:name:size */
export function resumeKey(dirId: string, name: string, size: number): string {
  return `${dirId}:${name}:${size}`;
}

// ---------- localStorage 旧机制兼容（v1.0.x） ----------
interface LegacyEntry {
  sessionId: string;
  size: number;
  partSize: number;
  totalParts: number;
  partsEtag: Record<number, string>;
  ts: number;
}
const LEGACY_KEY = 'nd_resume_sessions';
function loadLegacy(): Record<string, LegacyEntry> {
  try {
    return JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}');
  } catch {
    return {};
  }
}
function clearLegacy(key: string): void {
  try {
    const m = loadLegacy();
    delete m[key];
    localStorage.setItem(LEGACY_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

/** 进度上报节流包装（进度条流畅但不拖慢主线程；完成时刻强制上报） */
function createProgressEmitter(
  onProgress: (p: TaskProgress) => void
): (bytesDone: number, bytesTotal: number, phase?: 'hashing' | 'uploading') => void {
  let lastTs = 0;
  return (bytesDone, bytesTotal, phase) => {
    const now = Date.now();
    const final = bytesTotal > 0 && bytesDone >= bytesTotal;
    if (!final && now - lastTs < PROGRESS_THROTTLE_MS) return;
    lastTs = now;
    onProgress({ bytesDone: Math.min(bytesDone, bytesTotal), bytesTotal, phase });
  };
}

/**
 * PUT 分片并返回 ETag（来自响应头，MinIO 已通过 CORS 暴露）
 * - 支持 AbortSignal（暂停立即中断）
 * - 无进度超时自动中断（长连接假死场景，避免任务永久卡住）
 */
function putPart(
  url: string,
  blob: Blob,
  signal: AbortSignal | undefined,
  onProgress?: (loaded: number) => void
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (err: Error | null, etag?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(etag ?? 'unknown');
    };
    function onAbort(): void {
      try {
        xhr.abort();
      } catch {
        /* ignore */
      }
      finish(new AbortError());
    }
    const armStall = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        try {
          xhr.abort();
        } catch {
          /* ignore */
        }
        finish(new HttpStatusError(0, `分片传输 ${Math.round(PART_STALL_TIMEOUT / 1000)}s 无进度，已中断重试`));
      }, PART_STALL_TIMEOUT);
    };

    if (signal?.aborted) {
      finish(new AbortError());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        armStall();
        onProgress?.(e.loaded);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = (xhr.getResponseHeader('ETag') || '').replace(/^"|"$/g, '');
        finish(null, etag || 'unknown');
      } else {
        finish(new HttpStatusError(xhr.status, `分片上传失败（HTTP ${xhr.status}）`));
      }
    };
    xhr.onerror = () => finish(new HttpStatusError(0, '网络中断，分片上传失败'));
    xhr.ontimeout = () => finish(new HttpStatusError(0, '分片上传超时'));
    xhr.onabort = () => {
      if (!signal?.aborted) finish(new HttpStatusError(0, '分片上传被中断'));
    };
    armStall();
    xhr.send(blob);
  });
}

/**
 * 按需签名池：worker 取到某个分片时才签发（窗口 PRESIGN_WINDOW 个），
 * 避免「一次性签全部 URL → 长耗时上传后段 URL 已过期 → 403 请求失败」。
 * 403（签名过期）时可 drop 掉该分片重新签发后重试。
 */
function createPresignPool(sessionId: string, missing: number[], signal?: AbortSignal) {
  const urls = new Map<number, string>();
  let inflight: Promise<void> | null = null;

  const fetchWindow = async (partNumber: number): Promise<void> => {
    const start = missing.indexOf(partNumber);
    const window = missing.slice(Math.max(0, start), Math.max(0, start) + PRESIGN_WINDOW);
    if (window.length === 0) return;
    const res = await withRetry(() => filesApi.presignParts(sessionId, window, signal), {
      retries: 3,
      signal,
      shouldRetry: isTransientError,
    });
    for (const p of res.parts) urls.set(p.partNumber, p.url);
  };

  return {
    async url(partNumber: number): Promise<string> {
      const cached = urls.get(partNumber);
      if (cached) return cached;
      if (inflight) {
        // 并发 worker 只发一次签名请求，其余等待复用
        await inflight.catch(() => undefined);
        const shared = urls.get(partNumber);
        if (shared) return shared;
      }
      inflight = fetchWindow(partNumber).finally(() => {
        inflight = null;
      });
      await inflight;
      const url = urls.get(partNumber);
      if (!url) throw new HttpStatusError(500, `分片 ${partNumber} 缺少签名 URL`);
      return url;
    },
    /** 签名过期：丢弃缓存，下次 url() 重新签发 */
    drop(partNumber: number): void {
      urls.delete(partNumber);
    },
  };
}

/** 需要真实上传的分片：未完成 + 仅服务端占位（占位无 ETag，无法参与 complete，必须重传） */
function missingPartsOf(totalParts: number, uploaded: Record<number, string>): number[] {
  const list: number[] = [];
  for (let n = 1; n <= totalParts; n++) {
    if (!uploaded[n] || uploaded[n] === 'server') list.push(n);
  }
  return list;
}

/** 单分片上传：瞬时故障自动退避重试；签名过期重新签发；会话失效直接抛出交任务级重开会话 */
async function uploadOnePart(
  ctx: {
    file: File;
    partSize: number;
    pool: ReturnType<typeof createPresignPool>;
    signal?: AbortSignal;
    onPartDone: (partNumber: number, etag: string) => void;
    onBytes: (partNumber: number, loaded: number) => void;
    onRetry: (partNumber: number, delayMs: number, error: Error) => void;
  },
  partNumber: number
): Promise<void> {
  const { file, partSize, pool, signal } = ctx;
  const start = (partNumber - 1) * partSize;
  const blob = file.slice(start, Math.min(start + partSize, file.size));

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new AbortError();
    try {
      const url = await pool.url(partNumber);
      const etag = await putPart(url, blob, signal, (loaded) => ctx.onBytes(partNumber, loaded));
      ctx.onPartDone(partNumber, etag);
      return;
    } catch (err) {
      if (isAbortError(err)) throw err;
      // 会话已失效（MinIO 侧分片丢失）：本地重签无用，交由任务级重试重开会话
      if (isSessionExpiredError(err)) throw err;
      if (attempt >= PART_RETRIES || !isRetryableError(err)) throw err;
      if (isSignatureExpiredError(err)) pool.drop(partNumber); // 403：重新签发该分片
      const delayMs = backoffDelay(attempt, 500, 8_000);
      ctx.onRetry(partNumber, delayMs, toError(err));
      await sleep(delayMs, signal);
    }
  }
}

async function uploadPartsConcurrent(
  file: File,
  partSize: number,
  totalParts: number,
  pool: ReturnType<typeof createPresignPool>,
  uploaded: Record<number, string>,
  signal: AbortSignal | undefined,
  onPartDone: (partNumber: number, etag: string) => void,
  onBytes: (partNumber: number, loaded: number) => void,
  onRetry: (partNumber: number, delayMs: number, error: Error) => void
): Promise<void> {
  const missing = missingPartsOf(totalParts, uploaded);
  let cursor = 0;

  const ctx = { file, partSize, pool, signal, onPartDone, onBytes, onRetry };
  async function worker(): Promise<void> {
    while (true) {
      const partNumber = missing[cursor++];
      if (partNumber === undefined) return;
      await uploadOnePart(ctx, partNumber);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, missing.length || 1) }, () => worker()));
}

/** 节流上报已传分片到服务端（跨设备恢复基础）
 *  增量上报：记录每个 session 已上报的分片号，只发新增（避免全量数组膨胀） */
const reportedParts = new Map<string, Set<number>>();
function schedulePartsReport(sessionId: string, uploaded: Record<number, string>): void {
  const done = new Set(reportedParts.get(sessionId) ?? []);
  const fresh: number[] = [];
  for (const n of Object.keys(uploaded).map(Number)) {
    if (uploaded[n] === 'server') continue; // 服务端占位无需上报
    if (!done.has(n)) {
      done.add(n);
      fresh.push(n);
    }
  }
  if (fresh.length === 0) return;
  reportedParts.set(sessionId, done);
  void fetch('/api/files/upload/parts-report', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (localStorage.getItem('nd_access_token') ?? ''),
      'X-CSRF-Token': (document.cookie.match(/(?:^|;\s*)nd_csrf=([^;]+)/) || [])[1] ?? '',
    },
    body: JSON.stringify({ sessionId, partNumbers: fresh }),
  }).catch(() => {
    /* 上报失败不影响主流程；reportedParts 已记录，失败分片不再重发（服务端合并幂等） */
  });
}

export async function runUploadTask(
  input: UploadTaskInput,
  onProgress: (p: TaskProgress) => void,
  opts: RunUploadOptions = {}
): Promise<TaskResult> {
  const { file, dirId } = input;
  const signal = opts.signal;
  const key = resumeKey(dirId, file.name, file.size);
  const emit = createProgressEmitter(onProgress);

  // 暂停标记：所有中断出口统一返回 paused（保留断点，不清理 IndexedDB 记录）
  const pausedResult = (): TaskResult => ({ status: 'paused' });
  let sessionIdForReport = '';
  let uploadedForReport: Record<number, string> = {};
  // 客户端内容哈希（只计算一次，供 init / 续传校验复用）
  let clientHash = '';
  // 是否允许写断点记录（本轮判定终止后置 false，防迟到回调复活已作废会话）
  let recordWrites = true;
  const computeHashOnce = async (): Promise<string> => {
    if (clientHash) return clientHash;
    clientHash = shouldComputeHash(file.size)
      ? await fileHash(file, (done, total) => {
          emit(Math.round((done / total) * file.size), file.size, 'hashing');
        })
      : '';
    return clientHash;
  };
  /** complete 失败时的自愈：用 init 校验内容是否已在服务端（命中去重即视为成功） */
  const verifyAlreadyStored = async (): Promise<TaskResult | null> => {
    try {
      const again = await filesApi.uploadInit(
        {
          dirId,
          name: file.name,
          size: file.size,
          hash: clientHash || undefined,
          mimeType: file.type || 'application/octet-stream',
        },
        signal
      );
      if (again.dedup && again.file) {
        await removeResumeRecord(key);
        clearLegacy(`${dirId}:${file.name}`);
        return { status: 'dedup', file: again.file };
      }
    } catch (e) {
      if (isAbortError(e)) throw e;
      /* 校验失败：保持原错误 */
    }
    return null;
  };

  try {
    if (signal?.aborted) return pausedResult();

    // 1. 尝试续传：IndexedDB 记录 → 服务端 parts → localStorage 旧记录
    let session: UploadInitResult | null = null;
    let reuse = false;
    let partsEtag: Record<number, string> = {};

    let idbRec = await loadResumeRecord(key);
    if (idbRec && idbRec.size === file.size && idbRec.sessionId) {
      // 单请求直传已 PUT 完成但 complete 未成功：直接补 complete（无需重传整个文件）
      // 安全前提：内容哈希与记录一致（否则同名同大小的旧内容会被误提交）
      if (idbRec.mode1Pending) {
        let sameContent = false;
        if (idbRec.sha256) {
          try {
            sameContent = (await computeHashOnce()) === idbRec.sha256;
          } catch {
            sameContent = false;
          }
        }
        if (signal?.aborted) return pausedResult();
        if (sameContent) {
          try {
            const done = await filesApi.completeUpload(idbRec.sessionId, undefined, signal);
            await removeResumeRecord(key);
            clearLegacy(`${dirId}:${file.name}`);
            emit(file.size, file.size, 'uploading');
            return { status: 'completed', file: done };
          } catch (e) {
            if (isAbortError(e)) return pausedResult();
            /* complete 失败（会话已结束/失效）→ 不能判定成功：用 init 校验内容是否已落库 */
            const verified = await verifyAlreadyStored();
            if (verified) return verified;
          }
        }
        await removeResumeRecord(key);
        idbRec = null; // 作废：不再尝试复用该会话
      }
    }
    if (idbRec && idbRec.size === file.size && idbRec.sessionId) {
      if (signal?.aborted) return pausedResult();
      try {
        // 校验旧会话仍可用：请求分片签名成功即视为可用
        const probe = await filesApi.presignParts(idbRec.sessionId, [1], signal);
        if (probe.parts.length > 0) {
          session = {
            dedup: false,
            session: { id: idbRec.sessionId, mode: 2, partSize: idbRec.partSize, totalParts: idbRec.totalParts },
          };
          reuse = true;
          partsEtag = { ...(idbRec.partsEtag ?? {}) };
        }
      } catch (e) {
        if (isAbortError(e)) return pausedResult();
        /* 旧会话失效（服务端已中止/已结束），走新上传 */
      }
      // 服务端补齐缺失分片（跨设备恢复）
      if (reuse) {
        partsEtag = await mergeServerParts(idbRec.sessionId, partsEtag, signal);
      }
    }

    // localStorage 旧记录兜底（v1.0.x 升级场景）
    if (!session) {
      const legacyKey = `${dirId}:${file.name}`; // 旧格式不含 size
      const legacy = loadLegacy()[legacyKey];
      if (legacy && legacy.size === file.size && Date.now() - legacy.ts < 86400_000) {
        try {
          const probe = await filesApi.presignParts(legacy.sessionId, [1], signal);
          if (probe.parts.length > 0) {
            session = {
              dedup: false,
              session: { id: legacy.sessionId, mode: 2, partSize: legacy.partSize, totalParts: legacy.totalParts },
            };
            reuse = true;
            partsEtag = { ...(legacy.partsEtag ?? {}) };
          }
        } catch (e) {
          if (isAbortError(e)) return pausedResult();
          /* ignore */
        }
      }
    }

    if (signal?.aborted) return pausedResult();

    if (!session) {
      // 2. 初始化（配额校验 + 去重命中检查 + 签发）——瞬时故障自动重试（幂等）
      const hash = await computeHashOnce();
      if (signal?.aborted) return pausedResult();
      emit(0, file.size, 'uploading');
      session = await withRetry(
        () =>
          filesApi.uploadInit(
            {
              dirId,
              name: file.name,
              size: file.size,
              hash: hash || undefined,
              mimeType: file.type || 'application/octet-stream',
            },
            signal
          ),
        // 仅瞬时故障才重试：目录不存在/无权限（404/403）重试没有意义（v1.1.11）
        { retries: 3, signal, shouldRetry: isTransientError }
      );
      if (session.dedup && session.file) {
        await removeResumeRecord(key);
        clearLegacy(`${dirId}:${file.name}`);
        return { status: 'dedup', file: session.file };
      }
    }

    const sessionId = session.session!.id;
    const mode = session.session!.mode;
    sessionIdForReport = sessionId;

    // 3a. 单请求直传（瞬时故障自动重试；签名过期由任务级重试重开会话）
    if (mode === 1 && session.presignedUrl) {
      const total = file.size;
      await withRetry(
        () => uploadBlob(session!.presignedUrl!, file, (loaded) => emit(loaded, total, 'uploading'), signal),
        { retries: 4, signal, shouldRetry: isTransientError }
      );
      if (signal?.aborted) return pausedResult();
      {
        // PUT 已完成、仅待 complete：登记记录（**带上 File**，v1.1.16：刷新后可自动补 complete）
        // 是否真的把内容写进 IndexedDB 由 resume-store 的预算策略决定（超上限则只存进度）
        void saveResumeRecord({
          sessionId,
          key,
          dirId,
          fileName: file.name,
          size: file.size,
          partSize: 0,
          totalParts: 1,
          partsEtag: {},
          mode1Pending: true,
          sha256: clientHash || undefined,
          file,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      try {
        const done = await withRetry(() => filesApi.completeUpload(sessionId, undefined, signal), { retries: 4, signal, shouldRetry: isTransientError });
        await removeResumeRecord(key);
        clearLegacy(`${dirId}:${file.name}`);
        return { status: 'completed', file: done };
      } catch (e) {
        if (isAbortError(e)) return pausedResult();
        // 自愈：complete 失败可能是「其实已完成」（重试/并发导致会话已结束）
        const verified = await verifyAlreadyStored();
        if (verified) return verified;
        throw e;
      }
    }

    // 3b. 分片上传（断点续传 + 按需签名 + 分片级自动重试）
    const partSize = session.session!.partSize;
    const totalParts = Math.max(1, Math.ceil(file.size / partSize));
    const uploaded: Record<number, string> = reuse ? { ...partsEtag } : {};
    uploadedForReport = uploaded;

    // 字节统计：每个分片取「本次已达最大字节」，重试同一分片不重复累加
    const partBytes = new Map<number, number>();
    let resumedBytes = 0;
    if (reuse) {
      for (const n of Object.keys(uploaded)) {
        if (uploaded[Number(n)] === 'server') continue; // 服务端占位不计字节（需重传）
        const num = Number(n);
        resumedBytes += Math.min(partSize, Math.max(0, file.size - (num - 1) * partSize));
      }
    }
    const emitBytes = (): void => {
      let done = resumedBytes;
      for (const v of partBytes.values()) done += v;
      emit(done, file.size, 'uploading');
    };
    const onBytes = (partNumber: number, loaded: number): void => {
      partBytes.set(partNumber, Math.max(partBytes.get(partNumber) ?? 0, Math.min(loaded, partSize)));
      emitBytes();
    };
    let reportCounter = 0;
    const onPartDone = (partNumber: number, etag: string): void => {
      uploaded[partNumber] = etag;
      // 该分片按整片计字节（进度条在分片完成时补齐）
      partBytes.set(partNumber, Math.min(partSize, Math.max(0, file.size - (partNumber - 1) * partSize)));
      emitBytes();
      // 持久化进度 + 文件内容（v1.1.16：带 File，刷新后可自动续传，无需用户重选）
      // recordWrites: 本轮已判定终止（暂停/会话失效）后，兄弟分片迟到的完成回调不得再写记录
      // ——否则会「复活」已作废的会话，重试时按失败会话续传，导致卡死或无限重试
      if (recordWrites) {
        void saveResumeRecord({
          sessionId,
          key,
          dirId,
          fileName: file.name,
          size: file.size,
          partSize,
          totalParts,
          partsEtag: { ...uploaded },
          file,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      // 节流上报服务端（跨设备恢复）
      reportCounter += 1;
      if (reportCounter % REPORT_EVERY_PARTS === 0) schedulePartsReport(sessionId, uploaded);
    };
    const onPartRetry = (partNumber: number, delayMs: number, error: Error): void => {
      console.warn(`[upload] 分片 ${partNumber} 失败将自动重试（${Math.round(delayMs / 1000)}s 后）：${error.message}`);
    };

    const pool = createPresignPool(sessionId, missingPartsOf(totalParts, uploaded), signal);

    emitBytes(); // 续传时立即回显已有进度

    await uploadPartsConcurrent(file, partSize, totalParts, pool, uploaded, signal, onPartDone, onBytes, onPartRetry);

    // 最终上报一次
    schedulePartsReport(sessionId, uploaded);

    const parts = Object.keys(uploaded)
      .filter((n) => uploaded[Number(n)] !== 'server') // 占位分片必须真实重传（无 ETag 无法 complete）
      .map((n) => ({ partNumber: Number(n), etag: uploaded[Number(n)] }))
      .sort((a, b) => a.partNumber - b.partNumber);
    if (signal?.aborted) return pausedResult();
    try {
      const done = await withRetry(() => filesApi.completeUpload(sessionId, parts, signal), { retries: 4, signal, shouldRetry: isTransientError });
      reportedParts.delete(sessionId); // 清理上报跟踪，防内存累积
      await removeResumeRecord(key);
      clearLegacy(`${dirId}:${file.name}`);
      return { status: 'completed', file: done };
    } catch (e) {
      if (isAbortError(e)) return pausedResult();
      // 自愈：NoSuchUpload / 会话已结束 常见于「重复 complete」——若内容已落库则视为成功
      const verified = await verifyAlreadyStored();
      if (verified) {
        reportedParts.delete(sessionId);
        return verified;
      }
      throw e;
    }
  } catch (err) {
    // 暂停：保留 IndexedDB 记录与已传分片（继续时断点续传），并立即上报已传分片
    if (isAbortError(err)) {
      recordWrites = false; // 迟到回调不再写记录（断点以当前批次为准）
      if (sessionIdForReport) schedulePartsReport(sessionIdForReport, uploadedForReport);
      await flushResumeWrites(); // 立即落盘：保证「暂停后马上继续」能读到断点，不重复上传
      return pausedResult();
    }
    const e = toError(err);
    // 目标目录已不存在/无写入权限（v1.1.11）：重试多少次都不会成功——
    // 立即失败 + 清理断点记录（否则下次页面加载的自动恢复又会拿旧 dirId 白试一遍）。
    // 背景：实测一次「目录被删」造成 2 分钟 291 次 404 风暴（每任务还被重试了多次）
    if (isDirGoneError(e)) {
      recordWrites = false;
      await removeResumeRecord(key);
      clearLegacy(`${dirId}:${file.name}`);
      const noPerm = (e as { status?: number }).status === 403;
      return {
        status: 'error',
        error: noPerm
          ? '目标目录没有写入权限（可能已被移动或权限变更）：请重新选择目录后再上传'
          : '目标目录已不存在（可能已被删除或移动）：请重新选择目录后再上传',
        retryable: false,
        dirMissing: true,
      };
    }
    const sessionExpired = isSessionExpiredError(e);
    if (sessionExpired) {
      // 会话在服务端已失效：先停写记录再清记录（防兄弟分片迟到回调复活死会话），
      // 任务级重试将重新 init（同名同哈希仍可秒传）
      recordWrites = false;
      await removeResumeRecord(key);
      clearLegacy(`${dirId}:${file.name}`);
    } else if (sessionIdForReport) {
      // 失败但会话可能仍有效：保留 IndexedDB 记录供续传，并上报已传分片
      schedulePartsReport(sessionIdForReport, uploadedForReport);
      await flushResumeWrites();
    }
    const message = e.message || '上传失败';
    // 哈希校验失败（服务端重算不一致）也算「可重试」：重试会重新计算哈希并重开会话上传，
    // 避免因客户端哈希串号/传输损坏造成的永久失败（v1.1.8）
    const hashMismatch = /哈希校验|hash\s*mismatch/i.test(message);
    return { status: 'error', error: message, retryable: isRetryableError(e) || hashMismatch, sessionExpired };
  }
}

/** 导出 finished 标记的清理辅助（供调用方在任务彻底结束后调用） */
export async function cleanupResume(key: string): Promise<void> {
  await removeResumeRecord(key);
}

/** 供 UI 判定：某条续传记录是否可直接补 complete（v1.1.5） */
export type { ResumeRecord };
