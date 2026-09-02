// =============================================================================
// 分片断点续传上传引擎（v1.1 第三轮：IndexedDB 持久化 + 服务端分片查询）
// 流程: init(校验配额/去重/签发) -> 单请求直传 或 分片并发上传(记录ETag) -> complete
// 断点续传三级：
//   1) IndexedDB 记录（sessionId/partsEtag/File 引用）——刷新/关闭后保留，小文件自动恢复
//   2) 服务端 /upload/parts 查询——跨设备/清本地后恢复（补齐缺失分片）
//   3) localStorage 旧机制（nd_resume_sessions）——兼容历史版本
// 上报：分片 PUT 完成后节流上报服务端 uploaded_parts；完成/失败清理记录
// =============================================================================
import { filesApi } from '../api';
import { uploadBlob } from '../api/client';
import type { FileItem, UploadInitResult } from '../api/types';
import { shouldComputeHash, fileHash } from './hash';
import {
  saveResumeRecord,
  loadResumeRecord,
  removeResumeRecord,
  mergeServerParts,
  FILE_PERSIST_LIMIT,
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
  status: 'completed' | 'dedup' | 'error';
  file?: FileItem;
  error?: string;
}

const PART_CONCURRENCY = 4;
const PRESIGN_BATCH_SIZE = 200;
// 分片上报节流：每 5 个分片或 5s 上报一次服务端
const REPORT_EVERY_PARTS = 5;

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

/** PUT 分片并返回 ETag（来自响应头，MinIO 已通过 CORS 暴露） */
function putPart(url: string, blob: Blob, onProgress?: (delta: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = (xhr.getResponseHeader('ETag') || '').replace(/^"|"$/g, '');
        resolve(etag || 'unknown');
      } else {
        reject(new Error(`分片上传失败（HTTP ${xhr.status}），请稍后重试`));
      }
    };
    xhr.onerror = () => reject(new Error('网络中断，分片上传失败，可稍后重试'));
    xhr.send(blob);
  });
}

async function uploadPartsConcurrent(
  file: File,
  partSize: number,
  totalParts: number,
  urls: Map<number, string>,
  uploaded: Record<number, string>,
  onPartDone: (partNumber: number, etag: string) => void,
  onBytes: (delta: number) => void
): Promise<void> {
  const missing = Array.from({ length: totalParts }, (_, i) => i + 1).filter((n) => !uploaded[n]);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const partNumber = missing[cursor++];
      if (partNumber === undefined) return;
      const url = urls.get(partNumber);
      if (!url) throw new Error(`分片 ${partNumber} 缺少签名 URL`);
      const start = (partNumber - 1) * partSize;
      const blob = file.slice(start, Math.min(start + partSize, file.size));
      const etag = await putPart(url, blob, (delta) => onBytes(delta));
      onPartDone(partNumber, etag);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, missing.length || 1) }, () => worker()));
}

/** 分批预签名全部分片 URL（每批 200 个，规避 1 小时内慢速场景过期风险） */
async function presignAllParts(
  sessionId: string,
  totalParts: number,
  uploaded: Record<number, string>
): Promise<Map<number, string>> {
  const urls = new Map<number, string>();
  for (let start = 1; start <= totalParts; start += PRESIGN_BATCH_SIZE) {
    const batch: number[] = [];
    for (let n = start; n <= Math.min(start + PRESIGN_BATCH_SIZE - 1, totalParts); n++) {
      if (!uploaded[n]) batch.push(n);
    }
    if (batch.length === 0) continue;
    const res = await filesApi.presignParts(sessionId, batch);
    for (const p of res.parts) urls.set(p.partNumber, p.url);
  }
  return urls;
}

/** 节流上报已传分片到服务端（跨设备恢复基础）
 *  增量上报：记录每个 session 已上报的分片号，只发新增（避免全量数组膨胀） */
const reportedParts = new Map<string, Set<number>>();
function schedulePartsReport(sessionId: string, uploaded: Record<number, string>): void {
  const done = new Set(reportedParts.get(sessionId) ?? []);
  const fresh: number[] = [];
  for (const n of Object.keys(uploaded).map(Number)) {
    if (uploaded[n] === 'server') continue; // 服务端占位无需上报
    if (!done.has(n)) { done.add(n); fresh.push(n); }
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

export async function runUploadTask(input: UploadTaskInput, onProgress: (p: TaskProgress) => void): Promise<TaskResult> {
  const { file, dirId } = input;
  const key = resumeKey(dirId, file.name, file.size);

  try {
    // 1. 尝试续传：IndexedDB 记录 → 服务端 parts → localStorage 旧记录
    let session: UploadInitResult | null = null;
    let reuse = false;
    let partsEtag: Record<number, string> = {};

    const idbRec = await loadResumeRecord(key);
    if (idbRec && idbRec.size === file.size && idbRec.sessionId) {
      try {
        // 校验旧会话仍可用：请求分片签名成功即视为可用
        const probe = await filesApi.presignParts(idbRec.sessionId, [1]);
        if (probe.parts.length > 0) {
          session = {
            dedup: false,
            session: { id: idbRec.sessionId, mode: 2, partSize: idbRec.partSize, totalParts: idbRec.totalParts },
          };
          reuse = true;
          partsEtag = { ...(idbRec.partsEtag ?? {}) };
        }
      } catch {
        /* 旧会话失效（服务端已中止），走新上传 */
      }
      // 服务端补齐缺失分片（跨设备恢复）
      if (reuse) {
        partsEtag = await mergeServerParts(idbRec.sessionId, partsEtag);
      }
    }

    // localStorage 旧记录兜底（v1.0.x 升级场景）
    if (!session) {
      const legacyKey = `${dirId}:${file.name}`; // 旧格式不含 size
      const legacy = loadLegacy()[legacyKey];
      if (legacy && legacy.size === file.size && Date.now() - legacy.ts < 86400_000) {
        try {
          const probe = await filesApi.presignParts(legacy.sessionId, [1]);
          if (probe.parts.length > 0) {
            session = {
              dedup: false,
              session: { id: legacy.sessionId, mode: 2, partSize: legacy.partSize, totalParts: legacy.totalParts },
            };
            reuse = true;
            partsEtag = { ...(legacy.partsEtag ?? {}) };
          }
        } catch {
          /* ignore */
        }
      }
    }

    if (!session) {
      // 2. 初始化（配额校验 + 去重命中检查 + 签发）
      const hash = shouldComputeHash(file.size)
        ? await fileHash(file, (done, total) => {
            onProgress({
              phase: 'hashing',
              bytesDone: Math.round((done / total) * file.size),
              bytesTotal: file.size,
            });
          })
        : '';
      onProgress({ phase: 'uploading', bytesDone: 0, bytesTotal: file.size });
      session = await filesApi.uploadInit({
        dirId,
        name: file.name,
        size: file.size,
        hash: hash || undefined,
        mimeType: file.type || 'application/octet-stream',
      });
      if (session.dedup && session.file) {
        await removeResumeRecord(key);
        clearLegacy(`${dirId}:${file.name}`);
        return { status: 'dedup', file: session.file };
      }
    }

    const sessionId = session.session!.id;
    const mode = session.session!.mode;

    // 3a. 单请求直传
    if (mode === 1 && session.presignedUrl) {
      const total = file.size;
      await uploadBlob(session.presignedUrl, file, (loaded) =>
        onProgress({ bytesDone: loaded, bytesTotal: total })
      );
      const done = await filesApi.completeUpload(sessionId);
      await removeResumeRecord(key);
      clearLegacy(`${dirId}:${file.name}`);
      return { status: 'completed', file: done };
    }

    // 3b. 分片上传（断点续传）
    const partSize = session.session!.partSize;
    const totalParts = Math.max(1, Math.ceil(file.size / partSize));
    const uploaded: Record<number, string> = reuse ? { ...partsEtag } : {};
    let bytesDone = 0;
    let reportCounter = 0;
    const onBytes = (delta: number) => {
      bytesDone += delta;
      onProgress({ bytesDone: Math.min(bytesDone, file.size), bytesTotal: file.size });
    };
    const onPartDone = (partNumber: number, etag: string) => {
      uploaded[partNumber] = etag;
      // 持久化进度（IndexedDB；小文件带 File 引用 → 刷新后自动恢复）
      void saveResumeRecord({
        sessionId,
        key,
        dirId,
        fileName: file.name,
        size: file.size,
        partSize,
        totalParts,
        partsEtag: { ...uploaded },
        ...(file.size <= FILE_PERSIST_LIMIT ? { file } : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      // 节流上报服务端（跨设备恢复）
      reportCounter += 1;
      if (reportCounter % REPORT_EVERY_PARTS === 0) schedulePartsReport(sessionId, uploaded);
    };

    // 预登记已完成分片字节数（续传时进度条连续）
    if (reuse) {
      for (const n of Object.keys(uploaded)) {
        if (uploaded[Number(n)] === 'server') continue; // 服务端占位不计字节（重传）
        const num = Number(n);
        bytesDone += Math.min(partSize, Math.max(0, file.size - (num - 1) * partSize));
      }
    }

    const urls = await presignAllParts(sessionId, totalParts, uploaded);

    await uploadPartsConcurrent(file, partSize, totalParts, urls, uploaded, onPartDone, onBytes);

    // 最终上报一次
    schedulePartsReport(sessionId, uploaded);

    const parts = Object.keys(uploaded)
      .filter((n) => uploaded[Number(n)] !== 'server') // 服务端占位分片需真实上传后才能 complete
      .map((n) => ({ partNumber: Number(n), etag: uploaded[Number(n)] }))
      .sort((a, b) => a.partNumber - b.partNumber);
    const done = await filesApi.completeUpload(sessionId, parts);
    reportedParts.delete(sessionId); // 清理上报跟踪，防内存累积
    await removeResumeRecord(key);
    clearLegacy(`${dirId}:${file.name}`);
    return { status: 'completed', file: done };
  } catch (err) {
    const message = (err as Error).message || '上传失败';
    // 失败但会话仍有效：保留 IndexedDB 记录供下次续传（不清理）
    return { status: 'error', error: message };
  }
}

/** 导出 finished 标记的清理辅助（供调用方在任务彻底结束后调用） */
export async function cleanupResume(key: string): Promise<void> {
  await removeResumeRecord(key);
}
