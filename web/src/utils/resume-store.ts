// =============================================================================
// 断点续传持久化（v1.1 第三轮 3.1）：IndexedDB 存储分片进度 + File 引用
// 审查加固（v1.1.1）：
//  - Safari 私有模式/隐私模式 IndexedDB 不可用 → 自动降级 localStorage（不丢失续传能力）
//  - 高频写入合并：saveResumeRecord 多次调用合并为一次事务（大文件多分片场景）
// =============================================================================
import type { FileItem } from '../api/types';

export interface ResumeRecord {
  sessionId: string;
  /** 文件标识：dirId:name:size（唯一） */
  key: string;
  dirId: string;
  fileName: string;
  size: number;
  partSize: number;
  totalParts: number;
  /** 已上传分片 ETag（分片模式） */
  partsEtag: Record<number, string>;
  /** 小文件：存 File 引用（刷新后自动恢复） */
  file?: File;
  /** 单请求直传模式（mode=1）：已 PUT 完成待 complete */
  mode1Pending?: boolean;
  /** 客户端内容哈希：恢复/补 complete 前校验内容未变（防止同名同大小的旧内容被误提交） */
  sha256?: string;
  createdAt: number;
  updatedAt: number;
}

const DB_NAME = 'nd-resume-db';
const STORE = 'sessions';
const DB_VERSION = 1;
// localStorage 降级 key（IndexedDB 不可用时使用；File 引用无法序列化 → 只存进度）
const LS_KEY = 'nd_resume_sessions_v2';

let dbPromise: Promise<IDBDatabase> | null = null;
let idbUnavailable = false; // 标记 IndexedDB 不可用（隐私模式等），后续直接走 localStorage

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      idbUnavailable = true;
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      // 隐私模式/权限拒绝 → 降级 localStorage
      idbUnavailable = true;
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

// ---------- localStorage 降级层 ----------
function lsLoad(): Record<string, Omit<ResumeRecord, 'file'>> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  } catch {
    return {};
  }
}
function lsSave(map: Record<string, Omit<ResumeRecord, 'file'>>): void {
  try {
    // 清理 7 天前
    const cutoff = Date.now() - 7 * 86400_000;
    for (const k of Object.keys(map)) if (map[k].updatedAt < cutoff) delete map[k];
    localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch {
    /* quota exceeded → 尽力而为 */
  }
}
function lsPut(rec: Omit<ResumeRecord, 'file'>): void {
  const m = lsLoad();
  m[rec.key] = rec;
  lsSave(m);
}
function lsGet(key: string): Omit<ResumeRecord, 'file'> | null {
  return lsLoad()[key] ?? null;
}
function lsDel(key: string): void {
  const m = lsLoad();
  delete m[key];
  lsSave(m);
}

// ---------- 批量写合并（高频写入优化） ----------
let pendingWrites = new Map<string, ResumeRecord>();
let deletedKeys = new Set<string>(); // 已删除 key（防止在途 flush 写回）
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 合并写：同一 key 多次调用只保留最新状态，统一刷入存储（默认 500ms 内合并） */
export async function saveResumeRecord(rec: ResumeRecord): Promise<void> {
  pendingWrites.set(rec.key, { ...rec, updatedAt: Date.now() });
  deletedKeys.delete(rec.key); // 重新保存取消删除标记
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const batch = pendingWrites;
      pendingWrites = new Map();
      void flushBatch(batch);
    }, 500);
  }
}

async function flushBatch(batch: Map<string, ResumeRecord>): Promise<void> {
  // 跳过已删除的 key（任务完成与批量 flush 竞态防护）
  for (const key of deletedKeys) batch.delete(key);
  deletedKeys.clear();
  if (batch.size === 0) return;
  if (idbUnavailable) {
    for (const rec of batch.values()) {
      const { file: _file, ...rest } = rec;
      lsPut(rest);
    }
    return;
  }
  try {
    await tx('readwrite', (s) => {
      for (const rec of batch.values()) {
        s.put(rec); // 完整记录含 File（IndexedDB 结构化克隆支持 Blob/File；自动恢复依赖）
      }
      return s.count() as IDBRequest<number>;
    });
  } catch {
    // IndexedDB 失败 → 降级 localStorage（File 引用无法序列化，丢弃）
    idbUnavailable = true;
    for (const rec of batch.values()) {
      const { file: _file, ...rest } = rec;
      lsPut(rest);
    }
  }
}

/** 读取全部续传记录（IndexedDB 优先，失败降级 localStorage） */
export async function loadResumeRecords(): Promise<ResumeRecord[]> {
  if (!idbUnavailable) {
    try {
      const all = await tx<ResumeRecord[]>('readonly', (s) => s.getAll());
      return all.filter((r) => r.updatedAt >= Date.now() - 7 * 86400_000);
    } catch {
      idbUnavailable = true;
    }
  }
  // localStorage 降级
  const m = lsLoad();
  const cutoff = Date.now() - 7 * 86400_000;
  return Object.values(m)
    .filter((r) => r.updatedAt >= cutoff)
    .map((r) => ({ ...r, key: r.key }));
}

/** 按 key 读取单条 */
export async function loadResumeRecord(key: string): Promise<ResumeRecord | null> {
  if (!idbUnavailable) {
    try {
      const rec = await tx<ResumeRecord | undefined>('readonly', (s) => s.get(key));
      if (rec) return rec;
    } catch {
      idbUnavailable = true;
    }
  }
  const ls = lsGet(key);
  return ls ? { ...ls } : null;
}

/**
 * 立即刷入待写记录（关键节点调用：暂停/中断）
 * saveResumeRecord 默认 500ms 合并写入；「暂停后立刻继续」若不等刷盘，
 * 会因读不到断点记录而重开会话、重复上传已传分片。此处提供强制刷盘。
 */
export async function flushResumeWrites(): Promise<void> {
  if (!flushTimer) return; // 没有待写批次
  clearTimeout(flushTimer);
  flushTimer = null;
  const batch = pendingWrites;
  pendingWrites = new Map();
  await flushBatch(batch);
}

/** 删除记录（任务完成/中止） */
export async function removeResumeRecord(key: string): Promise<void> {
  // 立即从合并缓冲剔除 + 标记删除（防止在途 flush 写回）
  pendingWrites.delete(key);
  deletedKeys.add(key);
  if (!idbUnavailable) {
    try {
      await tx('readwrite', (s) => s.delete(key));
    } catch {
      idbUnavailable = true;
    }
  }
  lsDel(key);
}

/**
 * 服务端已传分片查询（第三轮 3.2）：即使本地无记录，也能从服务端恢复进度
 * 返回已传分片号数组；与本地 partsEtag 合并（本地优先，缺失的分片从服务端补）
 * 注意：服务端占位（'server'）**没有 ETag**，无法参与 complete，上传引擎会把这些分片
 * 视为「需真实重传」（v1.1.8：旧实现把它们当已完成，导致 complete 空清单 / 永久卡住）
 */
export async function mergeServerParts(
  sessionId: string,
  localEtag: Record<number, string>,
  signal?: AbortSignal
): Promise<Record<number, string>> {
  try {
    const res = await fetch(`/api/files/upload/parts?sessionId=${sessionId}`, {
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('nd_access_token') ?? '') },
      signal,
    });
    if (!res.ok) return localEtag;
    const data = (await res.json()) as { uploaded?: number[] };
    const merged = { ...localEtag };
    // 服务端有的分片本地缺失 → 标记为已传（etag 未知，用占位）
    for (const n of data.uploaded ?? []) {
      if (merged[n] === undefined) merged[n] = 'server';
    }
    return merged;
  } catch {
    return localEtag;
  }
}

/** 小文件阈值：<=8MB 存 File 引用（刷新后可自动恢复） */
export const FILE_PERSIST_LIMIT = 8 * 1024 * 1024;

/** 从记录中取 File（若有）；大文件或无引用返回 null */
export function fileFromRecord(rec: ResumeRecord): File | null {
  return rec.file ?? null;
}

/** 测试辅助：清空全部记录 */
export async function clearAllResume(): Promise<void> {
  pendingWrites.clear();
  if (!idbUnavailable) {
    try {
      await tx('readwrite', (s) => s.clear());
    } catch {
      /* ignore */
    }
  }
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

/** FileItem 类型再导出（供 uploader 使用） */
export type { FileItem };
