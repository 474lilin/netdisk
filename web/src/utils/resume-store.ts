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
// 初始建库版本：仅"库不存在、由浏览器首次创建"时生效（不带版本号 open 时浏览器建 v1）。
// 之后一律**不带版本号**打开，避免库里版本被升过（自愈/其它工具）后固定版本号导致 VersionError。
const DB_VERSION = 1;
// localStorage 降级 key（IndexedDB 不可用时使用；File 引用无法序列化 → 只存进度）
const LS_KEY = 'nd_resume_sessions_v2';

let dbPromise: Promise<IDBDatabase> | null = null;
let idbUnavailable = false; // 标记 IndexedDB 不可用（隐私模式等），后续直接走 localStorage
let currentDbVersion = 0; // 当前打开的库版本（供调试钩子）
let unavailableReason: unknown = null;

/** 标记 IndexedDB 不可用（只告警一次，便于现场排查"刷新后为什么不续传"） */
function markUnavailable(reason: unknown): void {
  if (idbUnavailable) return;
  idbUnavailable = true;
  unavailableReason = reason;
  console.warn('[resume] IndexedDB 不可用，续传记录降级 localStorage（File 引用会丢失，刷新后需重选文件）', reason);
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = openCurrent(0);
  dbPromise = p;
  void p.catch(() => {
    if (dbPromise === p) dbPromise = null; // 失败允许下次重试（降级 localStorage 由调用方处理）
  });
  return p;
}

/**
 * 打开数据库，并确保对象存储存在。
 *
 * v1.1.13 加固（两处真实缺陷）：
 *  1) **不要固定版本号打开**。历史实现一律 `indexedDB.open(DB_NAME, 1)`，一旦库被升到 v2
 *     （例如下面的自愈、或其它代码/工具升级过），后续每次打开都会 `VersionError`
 *     → 整个续传能力静默降级到 localStorage（File 引用丢失，刷新后无法自动续传）。
 *     现在改为不带版本号打开（沿用现有版本；库不存在时由浏览器建 v1 并触发 upgrade）。
 *  2) 若同名库存在但**缺少对象存储**（被其它工具用同名库创建过），光靠 `onupgradeneeded`
 *     永远补不上——事务一直 NotFoundError。此时升一个版本号重开，强制触发 upgrade 重建存储。
 */
function openCurrent(attempt: number): Promise<IDBDatabase> {
  return openRequest(undefined, attempt);
}

function openWithVersion(version: number, attempt: number): Promise<IDBDatabase> {
  return openRequest(version, attempt);
}

function openRequest(version: number | undefined, attempt: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    } catch (e) {
      markUnavailable('indexedDB.open 抛异常（隐私模式/权限拒绝）');
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
    req.onsuccess = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE)) {
        currentDbVersion = db.version;
        resolve(db);
        return;
      }
      // 库存在但存储缺失：自愈（升版本重建）
      const nextVersion = db.version + 1;
      db.close();
      if (attempt >= 3) {
        markUnavailable('续传库缺少 sessions 存储且升版本重建失败');
        reject(new Error('IndexedDB 续传库初始化失败：对象存储缺失'));
        return;
      }
      console.info(`[resume] 续传库缺少 sessions 存储，已升版本重建：v${db.version} → v${nextVersion}`);
      openWithVersion(nextVersion, attempt + 1).then(resolve, reject);
    };
    req.onerror = () => {
      // 隐私模式/权限拒绝 → 降级 localStorage
      markUnavailable('打开续传库失败');
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      // 其它标签页持有旧连接：其关闭后本请求会继续，无需处理（超时由调用方降级兜底）
    };
  });
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

/**
 * 文件内容持久化预算（v1.1.16）
 *   目的：刷新浏览器后能**直接续传**，不需要用户逐个"重新选择文件"。
 *   IndexedDB 可以存 File/Blob，代价是占用浏览器配额（C 盘空间）。
 *   策略：单文件 ≤ PRESERVE_MAX_FILE 才存内容；所有记录的**文件内容**总量控制在 PRESERVE_MAX_TOTAL 内，
 *        超预算时按 updatedAt 从旧到新丢弃内容（只保留断点进度，任务仍可续传但需重新选择文件）。
 */
const PRESERVE_MAX_FILE = 1024 * 1024 * 1024; // 1GB：超过此大小的单个文件不存内容
const PRESERVE_MAX_TOTAL = 4 * 1024 * 1024 * 1024; // 4GB：文件内容总预算

function stripFile(rec: ResumeRecord): ResumeRecord {
  const { file: _file, ...rest } = rec;
  return rest as ResumeRecord;
}

/** 超预算时丢弃最旧记录的文件内容（不影响断点进度本身） */
async function pruneFileContents(): Promise<void> {
  if (idbUnavailable) return;
  try {
    const all = await tx<ResumeRecord[]>('readonly', (s) => s.getAll());
    const withFile = all.filter((r) => r.file);
    let total = withFile.reduce((a, r) => a + (r.file?.size ?? 0), 0);
    if (total <= PRESERVE_MAX_TOTAL) return;
    const oldestFirst = withFile.sort((a, b) => a.updatedAt - b.updatedAt);
    const drop: string[] = [];
    for (const r of oldestFirst) {
      if (total <= PRESERVE_MAX_TOTAL) break;
      total -= r.file?.size ?? 0;
      drop.push(r.key);
    }
    if (drop.length === 0) return;
    await tx('readwrite', (s) => {
      for (const rec of all) {
        if (drop.includes(rec.key)) s.put(stripFile(rec));
      }
      return s.count() as IDBRequest<number>;
    });
    console.info(`[resume] 文件内容预算已满，丢弃 ${drop.length} 条最旧记录的内容副本（断点进度保留）`);
  } catch {
    /* 预算清理失败不影响主流程 */
  }
}

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
        // v1.1.16：**把文件内容一起存**（IndexedDB 结构化克隆支持 File/Blob），
        // 这样刷新浏览器后可以直接续传，不必再让用户逐个"重新选择文件"。
        // 超过单文件上限的不存内容（只存断点进度），避免把浏览器配额吃满。
        s.put(rec.file && rec.file.size > PRESERVE_MAX_FILE ? stripFile(rec) : rec);
      }
      return s.count() as IDBRequest<number>;
    });
    void pruneFileContents();
  } catch {
    // IndexedDB 失败 → 降级 localStorage（File 引用无法序列化，丢弃）
    markUnavailable('写入续传记录失败（降级 localStorage）');
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
      markUnavailable('读取续传记录列表失败');
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
      markUnavailable('读取单条续传记录失败');
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
      markUnavailable('删除续传记录失败');
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

// 测试/调试钩子（与 window.__uploadStore 一致）：现场排查「刷新后为什么不续传」时直接看这里
if (typeof window !== 'undefined') {
  (window as unknown as { __resumeDebug?: unknown }).__resumeDebug = () => ({
    idbUnavailable,
    unavailableReason: unavailableReason ? String(unavailableReason) : null,
    dbVersion: currentDbVersion,
    dbName: DB_NAME,
    store: STORE,
    initialVersion: DB_VERSION,
    pendingWrites: pendingWrites.size,
  });
}
