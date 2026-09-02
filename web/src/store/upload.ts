// 上传队列：任务调度（小文件高并发、大文件保守并发；任务内分片 4 并发）
// 万级任务性能：tasks 用 Map 存储，状态更新 O(1)（数组 map 在 2 万任务时每次更新拖垮主线程）；
// 派生数组仅在上传面板/完成判定处 useMemo 计算
// v1.0.13：Token 过期治理——auth-failed 状态 + 队列暂停/恢复（401 时暂停，登录后继续）
import { create } from 'zustand';
import { runUploadTask, type UploadTaskInput } from '../utils/uploader';
import { reportUploadInterrupt } from '../utils/metrics';

export type UploadTaskStatus = 'queued' | 'hashing' | 'uploading' | 'completed' | 'dedup' | 'error' | 'aborted' | 'auth-failed';

export interface UploadTask extends UploadTaskInput {
  status: UploadTaskStatus;
  progress: number; // 0-100
  bytesDone: number;
  error?: string;
  /** 中断原因（埋点）：token_expired / network / server 等 */
  interruptReason?: string;
}

// 并发上限：小文件（单请求直传，网络往返为主）可高并发；大文件（分片上传 + 哈希/带宽开销大）保守
const MAX_PARALLEL_SMALL = 6;
const MAX_PARALLEL_BIG = 2;
const SMALL_FILE_LIMIT = 8 * 1024 * 1024; // 与服务端 SMALL_FILE_THRESHOLD 一致

// 并发上限缓存：避免每次 pump 都 Object.values 全量扫描（万级任务时 O(n)）
// 由 addFiles 更新（新任务 size 决定档位）
let cachedLimit = MAX_PARALLEL_SMALL;
function currentLimit(tasks: Record<string, UploadTask>): number {
  return cachedLimit;
}
function updateLimit(tasks: Record<string, UploadTask>): void {
  for (const t of Object.values(tasks)) {
    if (t.status === 'queued' || t.status === 'hashing' || t.status === 'uploading') {
      cachedLimit = t.size <= SMALL_FILE_LIMIT ? MAX_PARALLEL_SMALL : MAX_PARALLEL_BIG;
      return;
    }
  }
}

interface UploadState {
  tasks: Record<string, UploadTask>;
  visible: boolean;
  /** 队列暂停（Token 过期/刷新失败时）：暂停调度新任务，保留已发起请求 */
  paused: boolean;
  /** 上一次暂停原因（埋点/UI 提示） */
  pauseReason?: string;
  addFiles: (files: File[], dirId: string) => void;
  removeTask: (id: string) => void;
  retryTask: (id: string) => void;
  clearCompleted: () => void;
  setVisible: (v: boolean) => void;
  /** 401 纠错：暂停队列，未完成任务标记 auth-failed（不丢弃） */
  pauseForAuth: () => void;
  /** 恢复：auth-failed 任务重新入队（不重置已传进度，靠 uploader 断点续传） */
  resumeAuth: () => void;
  /** 完整性校验 + 自动补传：全部任务结束后，对比服务端落库，缺失文件重新入队（永久修正漏传） */
  verifyAndBackfill: () => Promise<void>;
  _running: number;
}

let running = 0;
// 等待队列（FIFO）：避免每次 pump 都 Object.values 全量扫描（万级任务时 O(n) 阻塞主线程）
let queuedIds: string[] = [];

async function pump(): Promise<void> {
  // 填槽：循环从 FIFO 取任务启动，直到达到当前并发上限
  for (;;) {
    // 每次迭代取最新 state（避免陈旧快照导致任务状态判断错误）
    const state = useUploadStore.getState();
    if (state.paused) return; // 暂停：不启动新任务（进行中请求自然结束）
    if (state._running >= cachedLimit) return;
    // 从 FIFO 队首取 queued 任务（跳过陈旧 id；每次循环重新读 state.tasks 防快照陈旧）
    while (queuedIds.length > 0) {
      const id = queuedIds[0];
      queuedIds.shift();
      const t = useUploadStore.getState().tasks[id];
      if (t && t.status === 'queued') {
        running += 1;
        useUploadStore.setState({ _running: running });
        const taskId = t.id;

        const update = (patch: Partial<UploadTask>): void => {
          useUploadStore.setState((s) => ({
            tasks: { ...s.tasks, [taskId]: { ...s.tasks[taskId], ...patch } },
          }));
        };

        update({ status: 'hashing' });
        void runUploadTask(
          { id: t.id, fileName: t.fileName, size: t.size, dirId: t.dirId, file: t.file },
          (p) => {
            const pct = p.bytesTotal > 0 ? Math.min(100, Math.round((p.bytesDone / p.bytesTotal) * 100)) : 0;
            update({ status: p.phase === 'hashing' ? 'hashing' : 'uploading', progress: pct, bytesDone: p.bytesDone });
          }
        )
          .then((result) => {
            const cur = useUploadStore.getState();
            // 若队列已因鉴权失败暂停，此任务已标记 auth-failed：不覆盖
            if (cur.tasks[taskId]?.status === 'auth-failed') return;
            if (result.status === 'completed' || result.status === 'dedup') {
              update({ status: result.status, progress: 100, bytesDone: t.size });
            } else {
              update({ status: 'error', error: result.error, progress: 0, bytesDone: 0, interruptReason: 'server' });
            }
          })
          .finally(() => {
            running -= 1;
            useUploadStore.setState({ _running: running });
            void pump();
          });
        break; // 启动一个任务，回到外层 for 继续填槽
      }
    }
    if (queuedIds.length === 0) return; // 队列空
  }
}

export const useUploadStore = create<UploadState>((set, get) => ({
  tasks: {},
  visible: false,
  paused: false,
  pauseReason: undefined,
  _running: 0,

  addFiles: (files, dirId) => {
    const additions: Record<string, UploadTask> = {};
    const newIds: string[] = [];
    for (const file of files) {
      const id = crypto.randomUUID();
      additions[id] = {
        id,
        fileName: file.name,
        size: file.size,
        dirId,
        file,
        status: 'queued',
        progress: 0,
        bytesDone: 0,
      };
      newIds.push(id);
    }
    set((s) => ({ tasks: { ...s.tasks, ...additions }, visible: true }));
    queuedIds.push(...newIds);
    updateLimit(get().tasks);
    // 填满并发槽（暂停态不启动，恢复时统一调度）
    for (let i = 0; i < MAX_PARALLEL_SMALL; i++) void pump();
  },

  removeTask: (id) => {
    set((s) => {
      const next = { ...s.tasks };
      delete next[id];
      return { tasks: next };
    });
  },

  retryTask: (id) => {
    set((s) => ({
      tasks: { ...s.tasks, [id]: { ...s.tasks[id], status: 'queued', progress: 0, bytesDone: 0, error: undefined, interruptReason: undefined } },
    }));
    queuedIds.push(id);
    void pump();
  },

  clearCompleted: () => {
    set((s) => {
      const next: Record<string, UploadTask> = {};
      for (const [id, t] of Object.entries(s.tasks)) {
        if (t.status !== 'completed' && t.status !== 'dedup') next[id] = t;
      }
      return { tasks: next };
    });
  },

  setVisible: (v) => set({ visible: v }),

  // 401 纠错：暂停队列 + 未完成任务标记 auth-failed（保留进度信息供恢复）
  pauseForAuth: () => {
    reportUploadInterrupt('token_expired');
    set((s) => {
      const next: Record<string, UploadTask> = {};
      for (const [id, t] of Object.entries(s.tasks)) {
        if (t.status === 'queued' || t.status === 'hashing' || t.status === 'uploading') {
          next[id] = { ...t, status: 'auth-failed', progress: t.progress, bytesDone: t.bytesDone, interruptReason: 'token_expired' };
        } else {
          next[id] = t;
        }
      }
      return { tasks: next, paused: true, pauseReason: 'token_expired' };
    });
  },

  // 恢复：auth-failed → queued 重新入队（uploader 断点续传复用已传分片，不重复上传已完成部分）
  resumeAuth: () => {
    const reIds: string[] = [];
    set((s) => {
      const next: Record<string, UploadTask> = {};
      for (const [id, t] of Object.entries(s.tasks)) {
        if (t.status === 'auth-failed') {
          next[id] = { ...t, status: 'queued', progress: 0, bytesDone: 0, error: undefined, interruptReason: undefined };
          reIds.push(id);
        } else {
          next[id] = t;
        }
      }
      return { tasks: next, paused: false, pauseReason: undefined };
    });
    queuedIds.push(...reIds);
    updateLimit(get().tasks);
    for (let i = 0; i < MAX_PARALLEL_SMALL; i++) void pump();
  },

  // 完整性校验 + 自动补传：全部任务结束后，按目录查服务端落库，缺失文件重新入队
  // （永久修正：偶发任务丢失导致漏传，无论原因，最终保证 100% 落库）
  verifyAndBackfill: async () => {
    const state = get();
    const all = Object.values(state.tasks);
    if (all.length === 0) return;
    // 只校验"本次已结束"的任务（completed/dedup/error 均视为应落库）
    const settled = all.filter((t) => t.status === 'completed' || t.status === 'dedup' || t.status === 'error');
    if (settled.length === 0) return;
    // 防重入：进行中有任务时不校验
    if (all.some((t) => t.status === 'queued' || t.status === 'hashing' || t.status === 'uploading')) return;

    // 按目录分组期望文件
    const byDir = new Map<string, Map<string, { size: number; file?: File }>>();
    for (const t of settled) {
      if (!byDir.has(t.dirId)) byDir.set(t.dirId, new Map());
      byDir.get(t.dirId)!.set(t.fileName, { size: t.size, file: t.file });
    }

    // 查服务端每目录列表，找缺失（大目录一次拉全：offset 分页在 2 万文件下会漏）
    const missing: Array<{ dirId: string; fileName: string; size: number; file?: File }> = [];
    for (const [dirId, expect] of byDir) {
      try {
        // 分页拉全目录（每批 5000，最多 20 批 = 10 万）
        const serverNames = new Set<string>();
        let offset = 0;
        for (;;) {
          const res = await fetch(`/api/files?dirId=${encodeURIComponent(dirId)}&offset=${offset}&limit=5000`, {
            headers: { Authorization: 'Bearer ' + (localStorage.getItem('nd_access_token') ?? '') },
          });
          if (!res.ok) break;
          const data = (await res.json()) as { items?: Array<{ name: string; size: number }>; hasMore?: boolean };
          const items = data.items ?? [];
          for (const i of items) serverNames.add(i.name);
          if (!data.hasMore || items.length < 5000) break;
          offset += items.length;
          if (offset > 100000) break; // 防御：超大目录截断（理论上限）
        }
        for (const [name, info] of expect) {
          // 同名同大小视为已传（服务端按名查重，大小校验防误判）
          if (!serverNames.has(name)) {
            missing.push({ dirId, fileName: name, size: info.size, file: info.file });
          }
        }
      } catch {
        /* 网络异常跳过该目录校验 */
      }
    }

    if (missing.length === 0) return;
    // 重新入队缺失文件（File 引用还在内存；无 File 的（大文件）提示用户重选）
    const noFile = missing.filter((m) => !m.file);
    const withFile = missing.filter((m) => m.file);
    if (withFile.length > 0) {
      console.warn(`[verify] 补传 ${withFile.length} 个未落库文件`);
      for (const m of withFile) get().addFiles([m.file!], m.dirId);
    }
    if (noFile.length > 0) {
      console.warn(`[verify] ${noFile.length} 个大文件未落库（需重选补传）: ${noFile.map((m) => m.fileName).join(', ')}`);
    }
  },
}));

/** 派生：任务数组（面板渲染/完成判定用）——在组件内 useMemo 调用 */
export function useTaskList(): UploadTask[] {
  const tasks = useUploadStore((s) => s.tasks);
  return Object.values(tasks);
}

// 测试/调试钩子：暴露 store 到 window（e2e 可访问）
if (typeof window !== 'undefined') {
  (window as unknown as { __uploadStore?: unknown }).__uploadStore = useUploadStore;
}
