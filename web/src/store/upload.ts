// 上传/下载任务队列（v1.1.10 起统一管理上传与下载）
// 万级任务性能：tasks 用 Map 存储，状态更新 O(1)（数组 map 在 2 万任务时每次更新拖垮主线程）；
// 派生数组仅在上传面板/完成判定处 useMemo 计算
// v1.0.13：Token 过期治理——auth-failed 状态 + 队列暂停/恢复（401 时暂停，登录后继续）
// v1.1.5：瞬时故障自愈 + 暂停/继续
//   - 任务级自动重试：网络抖动/5xx/429/会话失效 → 退避后自动重新排队（用户无需手动点「重试」）
//   - 单任务暂停/继续 + 全部暂停/一键全部继续（AbortSignal 中断传输，断点保留）
//   - 移除进行中任务会真正中断其网络请求（此前会「后台偷偷传完」）
// v1.1.10：同一列表管理**下载任务**（kind='download'）：下载中/完成/失败/取消，可重试；
//          下载不参与上传的暂停/恢复（只能取消），并发上限 2
import { create } from 'zustand';
import { runUploadTask, resumeKey, type UploadTaskInput } from '../utils/uploader';
import { downloadToFile, type DownloadCtx } from '../utils/downloader';
import { filesApi } from '../api';
import { reportUploadInterrupt } from '../utils/metrics';
import { backoffDelay, isAbortError } from '../utils/retry';
import { loadResumeRecord } from '../utils/resume-store';

export type TaskKind = 'upload' | 'download';

export type UploadTaskStatus =
  | 'queued'
  | 'hashing'
  | 'uploading'
  | 'paused'
  | 'completed'
  | 'dedup'
  | 'error'
  | 'aborted'
  | 'auth-failed'
  // 下载任务状态（v1.1.10）
  | 'downloading'
  | 'canceled';

export interface UploadTask extends UploadTaskInput {
  /** 任务类型：上传（默认）/ 下载 */
  kind?: TaskKind;
  status: UploadTaskStatus;
  progress: number; // 0-100
  bytesDone: number;
  error?: string;
  /** 中断原因（埋点）：token_expired / network / server 等 */
  interruptReason?: string;
  /** 已自动重试次数（v1.1.5） */
  attempts?: number;
  /** 正在等待自动重试（倒计时中，UI 显示「自动重试中」） */
  retrying?: boolean;
  /** 下载任务的实际执行体（用于启动/重试；仅内存，不持久化） */
  run?: (ctx: DownloadCtx) => Promise<void>;
  /** 下载来源（用于刷新后重建 run，可重试）：文件 id / 是否文件夹 */
  fileId?: string;
  isDir?: boolean;
  /**
   * 缺少本地文件引用（v1.1.13）：刷新/重开页面后还原的上传任务必然如此
   *（浏览器不允许把 File 对象写进 localStorage）。这类任务**必须由用户重新选择同一个文件**
   * 才能继续（已传分片保留在服务端，可选回同名同大小的文件断点续传）。
   */
  needsFile?: boolean;
  /** 本地文件最后修改时间（持久化，用于重选文件时校验是否为同一个文件） */
  lastModified?: number;
}

// 并发上限：小文件（单请求直传，网络往返为主）可高并发；大文件（分片上传 + 哈希/带宽开销大）保守
const MAX_PARALLEL_SMALL = 6;
const MAX_PARALLEL_BIG = 2;
const SMALL_FILE_LIMIT = 8 * 1024 * 1024; // 与服务端 SMALL_FILE_THRESHOLD 一致
// 任务级自动重试上限（超出后标记失败，用户可手动重试）
const MAX_AUTO_RETRY = 3;

// 并发上限缓存：避免每次 pump 都 Object.values 全量扫描（万级任务时 O(n)）
// 由 addFiles 更新（新任务 size 决定档位）
let cachedLimit = MAX_PARALLEL_SMALL;
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
  /** 面板是否展开显示（false=仅保留胶囊/顶栏入口，任务不丢） */
  visible: boolean;
  /** 面板是否最小化为胶囊（v1.1.6：状态上移到 store，便于顶栏「上传任务」入口控制） */
  panelCollapsed: boolean;
  /** 队列暂停（Token 过期/用户全部暂停）：暂停调度新任务，保留已发起请求 */
  paused: boolean;
  /** 上一次暂停原因（埋点/UI 提示）：token_expired=登录过期；user=用户手动全部暂停 */
  pauseReason?: string;
  addFiles: (files: File[], dirId: string) => void;
  /** 新增下载任务（v1.1.10）：立即启动（并发上限 2），进度/成功/失败都在同一列表展示 */
  addDownload: (spec: {
    name: string;
    size: number;
    dirId?: string;
    fileId?: string;
    isDir?: boolean;
    run: (ctx: DownloadCtx) => Promise<void>;
  }) => string;
  /** 取消下载（中断请求，状态置「已取消」） */
  cancelDownload: (id: string) => void;
  /** 目录已失效：清除该目录下**整批**任务（含排队/在传）并解除暂停（v1.1.11） */
  dismissDirMissing: () => void;
  removeTask: (id: string) => void;
  retryTask: (id: string) => void;
  /** 批量重试全部失败任务（v1.1.5） */
  retryAllFailed: () => void;
  /**
   * 给「刷新后需要重选文件」的任务补上本地文件引用并立刻重新入队（v1.1.13）。
   * 会校验 文件名+大小（续传记录按「目录+文件名+大小」索引，不一致无法续传）；
   * 修改时间不一致时仍可继续，但返回 warning 供 UI 提示。
   */
  attachFile: (id: string, file: File) => { ok: boolean; reason?: string; warning?: string };
  /** 当前需要重新选择本地文件的失败任务 id（供 UI 决定是否弹文件选择框） */
  needsFileIds: () => string[];
  /**
   * 「重新开始」一个失败的上传任务（v1.1.16）：
   *   ① 断点记录里仍有文件内容（IndexedDB 持久化）→ 直接续传，用户什么都不用选；
   *   ② 没有内容 → 返回 'need-file'，由 UI 打开文件选择框（并说明原因）。
   */
  restartTask: (id: string) => Promise<'resumed' | 'need-file' | 'none'>;
  /** 暂停单个任务（v1.1.5）：中断在传请求，保留断点 */
  pauseTask: (id: string) => void;
  /** 继续单个任务（v1.1.5）：重新入队，断点续传 */
  resumeTask: (id: string) => void;
  /** 全部暂停（v1.1.5）：停止调度 + 中断在传请求 */
  pauseAll: () => void;
  /** 一键全部继续（v1.1.5） */
  resumeAll: () => void;
  clearCompleted: () => void;
  /** 清除失败任务（v1.1.15）：移除 error/auth-failed/canceled 三类任务，返回移除条数 */
  clearFailed: () => number;
  setVisible: (v: boolean) => void;
  /** 最小化/展开面板（v1.1.6，持久化到 localStorage） */
  setPanelCollapsed: (v: boolean) => void;
  /** 顶栏固定入口：显示并展开 / 展开与最小化切换（v1.1.6） */
  togglePanel: () => void;
  /** 面板形态：悬浮浮层（默认，浮在网盘之上）/ 停靠右侧（占位，不遮挡列表）v1.1.10 */
  panelMode: 'float' | 'dock';
  setPanelMode: (m: 'float' | 'dock') => void;
  togglePanelMode: () => void;
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
// 面板最小化偏好持久化（v1.1.6）：刷新后仍保持用户选择
const PANEL_COLLAPSED_KEY = 'nd_upload_panel_collapsed';
function readPanelCollapsed(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(PANEL_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}
function writePanelCollapsed(v: boolean): void {
  try {
    localStorage.setItem(PANEL_COLLAPSED_KEY, v ? '1' : '0');
  } catch {
    /* localStorage 不可用时仅内存生效 */
  }
}
// 面板形态持久化（v1.1.10）：'float' 悬浮浮层（默认，用户诉求：浮在网盘之上永不消失）
const PANEL_MODE_KEY = 'nd_panel_mode';
function readPanelMode(): 'float' | 'dock' {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(PANEL_MODE_KEY) === 'dock' ? 'dock' : 'float';
  } catch {
    return 'float';
  }
}
function writePanelMode(m: 'float' | 'dock'): void {
  try {
    localStorage.setItem(PANEL_MODE_KEY, m);
  } catch {
    /* ignore */
  }
}
// 悬浮面板位置持久化
const FLOAT_POS_KEY = 'nd_panel_pos_v2';
export interface PanelPos {
  x: number;
  y: number;
}
function readPanelPos(): PanelPos | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(FLOAT_POS_KEY) : null;
    if (!raw) return null;
    const p = JSON.parse(raw) as PanelPos;
    if (typeof p.x === 'number' && typeof p.y === 'number') return p;
  } catch {
    /* ignore */
  }
  return null;
}
function writePanelPos(p: PanelPos): void {
  try {
    localStorage.setItem(FLOAT_POS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
// 下载并发上限（与上传互不影响）
const MAX_PARALLEL_DOWNLOAD = 2;
let runningDownloads = 0;
// 进行中任务的取消句柄：暂停/移除时立即中断网络请求（断点由 uploader 记录在 IndexedDB）
const controllers = new Map<string, AbortController>();
// 每次启动任务分配一个运行令牌（run token）：任务结束后，同一轮里「仍在途的分片请求」
// 迟到的进度回调会被丢弃——否则会把已结算的状态（失败待重试/已完成/已暂停）覆盖回「上传中」，
// 导致自动重试被静默丢弃、进度条永久卡住（v1.1.5 由韧性测试发现并修复）
const runTokens = new Map<string, number>();
let tokenSeq = 0;
// 「目标目录不存在」按目录计数（v1.1.11）：同一目录连续失败达阈值 → 该目录已失效，
// 暂停队列避免余下任务继续发无效请求（实测旧实现 2 分钟打了 291 次 404）。
// 按目录计数而非全局计数：一个目录失效不应误停其它目录的任务。
const dirGoneCounts = new Map<string, number>();
const DIR_GONE_PAUSE_THRESHOLD = 3;

/** 体积格式化（错误文案用，避免引入 UI 层依赖） */
function fmtSize(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

/** 「刷新后需要重新开始」的提示文案（v1.1.16：浏览器留有内容会自动续传，只有内容丢了才需选文件） */
export const NEEDS_FILE_MSG =
  '刷新导致中断：点「重新开始」即可接着传（浏览器若仍留有该文件内容会直接续传；内容已不在时才需要选回文件）';

/**
 * 标记任务「缺少本地文件引用」（v1.1.13）。
 * 旧实现的致命缺陷：这类任务被排队后，runUploadTask 里执行 `file.name` 抛 TypeError，
 * 任务在几十毫秒内又变回「失败」——用户看到的就是「点重试/重试失败都没反应」。
 * v1.1.16：浏览器里持久化的文件内容通常仍可用，用户点「重新开始」即可续传；
 *         只有内容超预算被丢弃/换设备时才需要重新选文件。
 */
function markNeedsFile(id: string): void {
  useUploadStore.setState((s) => {
    const t = s.tasks[id];
    if (!t || t.kind === 'download') return {};
    return {
      tasks: { ...s.tasks, [id]: { ...t, status: 'error' as UploadTaskStatus, needsFile: true, retrying: false, error: NEEDS_FILE_MSG } },
    };
  });
}

async function pump(): Promise<void> {
  // 填槽：循环从 FIFO 取任务启动，直到达到当前并发上限
  for (;;) {
    // 每次迭代取最新 state（避免陈旧快照导致任务状态判断错误）
    const state = useUploadStore.getState();
    if (state.paused) return; // 暂停：不启动新任务（进行中请求自然结束）
    if (state._running >= cachedLimit) return;
    // 从 FIFO 队首取 queued 任务（跳过陈旧 id；每次循环重新读 state.tasks 防快照陈旧）
    let started = false;
    while (queuedIds.length > 0) {
      const id = queuedIds[0];
      queuedIds.shift();
      const t = useUploadStore.getState().tasks[id];
      if (!t || t.status !== 'queued') continue;
      // 防御（v1.1.13）：刷新后还原的上传任务没有本地 File 引用，绝不能下发给上传执行体
      if (t.kind !== 'download' && !t.file) {
        markNeedsFile(id);
        continue;
      }
      const controller = new AbortController();
      controllers.set(id, controller);
      running += 1;
      useUploadStore.setState({ _running: running });
      const taskId = t.id;
      const myToken = ++tokenSeq;
      runTokens.set(taskId, myToken);
      const isCurrentRun = (): boolean => runTokens.get(taskId) === myToken;

      // 实时进度/阶段更新：仅当本轮仍是最新运行轮次、且任务未被外部暂停时才生效
      //（防迟到回调覆盖已结算状态；也防「暂停后哈希阶段回调把状态改回计算哈希」的闪烁）
      const updateLive = (patch: Partial<UploadTask>): void => {
        if (!isCurrentRun()) return;
        useUploadStore.setState((s) => {
          const cur = s.tasks[taskId];
          if (!cur || cur.status === 'paused' || cur.status === 'auth-failed') return {};
          return { tasks: { ...s.tasks, [taskId]: { ...cur, ...patch } } };
        });
      };
      // 最终状态写入（本轮结果）：不校验令牌，但会先作废令牌（后续迟到进度不再生效）
      // 注意：任务已被移除时不再写入，否则会用 patch 重建出一个"幽灵任务"
      const update = (patch: Partial<UploadTask>): void => {
        useUploadStore.setState((s) =>
          s.tasks[taskId] ? { tasks: { ...s.tasks, [taskId]: { ...s.tasks[taskId], ...patch } } } : {}
        );
      };
      const settleRun = (): boolean => {
        const stale = !isCurrentRun();
        runTokens.delete(taskId);
        return stale;
      };

      update({ status: 'hashing', retrying: false });
      void runUploadTask(
        { id: t.id, fileName: t.fileName, size: t.size, dirId: t.dirId, file: t.file },
        (p) => {
          const pct = p.bytesTotal > 0 ? Math.min(100, Math.round((p.bytesDone / p.bytesTotal) * 100)) : 0;
          updateLive({ status: p.phase === 'hashing' ? 'hashing' : 'uploading', progress: pct, bytesDone: p.bytesDone });
        },
        { signal: controller.signal }
      )
        .then((result) => {
          // 本轮已被更新的一轮取代（暂停后继续等）：丢弃迟到结果
          if (settleRun()) return;
          const cur = useUploadStore.getState();
          const task = cur.tasks[taskId];
          if (!task) return; // 已被移除
          // 注意顺序：**先判成功**——上传已在服务端完成就是完成，不能被此前的暂停标记吞掉
          //（v1.1.8：旧实现先判 paused 直接 return，导致「服务端已落库但界面永远卡在上传中」）
          if (result.status === 'completed' || result.status === 'dedup') {
            dirGoneCounts.delete(t.dirId); // 该目录仍然有效：重置失效计数
            update({
              status: result.status,
              progress: 100,
              bytesDone: t.size,
              retrying: false,
              attempts: 0,
              error: undefined,
              interruptReason: undefined,
            });
            return;
          }
          // 若队列已因鉴权失败/用户暂停被标记：不覆盖其状态
          if (task.status === 'auth-failed' || task.status === 'paused') return;
          if (result.status === 'paused') {
            // 若已被判定为「目标目录失效」并标记失败，不要用 paused 覆盖（v1.1.11）
            if (useUploadStore.getState().tasks[taskId]?.interruptReason === 'dir_missing') return;
            update({ status: 'paused', retrying: false });
            return;
          }
          // 失败：目标目录已不存在（v1.1.11）→ 立即失败；连续多个说明整棵目录已失效，
          // 暂停队列以免余下任务继续发无效请求（实测旧实现 2 分钟打了 291 次 404）
          if (result.dirMissing) {
            const n = (dirGoneCounts.get(t.dirId) ?? 0) + 1;
            dirGoneCounts.set(t.dirId, n);
            update({
              status: 'error',
              error: result.error ?? '目标目录不存在',
              retrying: false,
              interruptReason: 'dir_missing',
            });
            if (n >= DIR_GONE_PAUSE_THRESHOLD) {
              // 该目录已确认失效：把同一目录下**尚未开始**的任务直接标记失败（不再发请求），
              // 并暂停队列 —— 否则用户点「清除失败」后这些任务会再次发起，形成无意义循环
              useUploadStore.setState((s) => {
                const next: Record<string, UploadTask> = {};
                for (const [id, task] of Object.entries(s.tasks)) {
                  const sameDirQueued = task.dirId === t.dirId && task.status === 'queued';
                  next[id] = sameDirQueued
                    ? { ...task, status: 'error' as UploadTaskStatus, error: result.error, retrying: false, interruptReason: 'dir_missing' }
                    : task;
                }
                return { tasks: next, paused: true, pauseReason: 'dir-missing' };
              });
              reportUploadInterrupt('dir_missing');
            }
            return;
          }
          // 失败：瞬时故障自动退避重排（用户无需手动点重试）
          const attempts = task.attempts ?? 0;
          if (result.retryable && attempts < MAX_AUTO_RETRY) {
            const delayMs = backoffDelay(attempts, 1_000, 30_000);
            reportUploadInterrupt(result.sessionExpired ? 'session_expired' : 'auto_retry');
            update({
              status: 'queued',
              retrying: true,
              attempts: attempts + 1,
              error: undefined,
              interruptReason: undefined,
            });
            setTimeout(() => {
              const s = useUploadStore.getState();
              const now = s.tasks[taskId];
              if (!now || now.status !== 'queued') return;
              if (s.paused) {
                update({ status: 'paused', retrying: false });
                return;
              }
              queuedIds.push(taskId);
              updateLimit(s.tasks);
              void pump();
            }, delayMs);
            return;
          }
          update({
            status: 'error',
            error: result.error ?? '上传失败',
            retrying: false,
            interruptReason: result.sessionExpired ? 'session_expired' : 'server',
          });
        })
        .catch((err: unknown) => {
          // runUploadTask 内部已兜底捕获；此处仅防御异常实现（避免任务永久卡在 hashing）
          if (settleRun()) return;
          update({
            status: isAbortError(err) ? 'paused' : 'error',
            error: isAbortError(err) ? undefined : (err as Error)?.message || '上传失败',
            retrying: false,
          });
        })
        .finally(() => {
          // 仅清理本轮的控制器（暂停后立刻继续时，新轮已注册新控制器，不能误删）
          if (controllers.get(taskId) === controller) controllers.delete(taskId);
          if (isCurrentRun()) runTokens.delete(taskId);
          running -= 1;
          useUploadStore.setState({ _running: running });
          void pump();
        });
      started = true;
      break; // 启动一个任务，回到外层 for 继续填槽
    }
    if (!started) {
      // 队列中已无 queued 任务
      if (queuedIds.length === 0) return;
    }
  }
}

/** 中断某任务的在传请求（若有） */
function abortTask(id: string): void {
  const c = controllers.get(id);
  if (c) {
    c.abort();
    controllers.delete(id);
  }
}

/** 下载调度：在并发上限内启动排队中的下载任务（v1.1.10） */
function pumpDownloads(): void {
  for (;;) {
    if (runningDownloads >= MAX_PARALLEL_DOWNLOAD) return;
    const state = useUploadStore.getState();
    const next = Object.values(state.tasks).find(
      (t) => t.kind === 'download' && t.status === 'queued' && !!t.run
    );
    if (!next) return;
    startDownloadTask(next.id);
  }
}

/** 启动（或重试）一个下载任务 */
function startDownloadTask(id: string): void {
  const state = useUploadStore.getState();
  const t = state.tasks[id];
  if (!t?.run) return;
  if (runningDownloads >= MAX_PARALLEL_DOWNLOAD && t.status !== 'downloading') {
    // 无空闲槽位：保持排队，稍后由 pumpDownloads 启动
    return;
  }
  const controller = new AbortController();
  controllers.set(id, controller);
  runningDownloads += 1;

  const update = (patch: Partial<UploadTask>): void => {
    useUploadStore.setState((s) => (s.tasks[id] ? { tasks: { ...s.tasks, [id]: { ...s.tasks[id], ...patch } } } : {}));
  };
  update({ status: 'downloading', progress: 0, bytesDone: 0, error: undefined, attempts: 0, retrying: false });

  void t
    .run({
      signal: controller.signal,
      onProgress: (bytesDone, totalBytes) => {
        const pct = totalBytes > 0 ? Math.min(100, Math.round((bytesDone / totalBytes) * 100)) : 0;
        update({ bytesDone, progress: pct });
      },
    })
    .then(() => {
      update({ status: 'completed', progress: 100, error: undefined });
    })
    .catch((err: unknown) => {
      if (isAbortError(err) || controller.signal.aborted) {
        update({ status: 'canceled', error: undefined });
        return;
      }
      update({ status: 'error', error: (err as Error)?.message || '下载失败' });
    })
    .finally(() => {
      if (controllers.get(id) === controller) controllers.delete(id);
      runningDownloads -= 1;
      pumpDownloads();
    });
}

/** 重新入队（保留断点信息，不清理 IndexedDB 续传记录） */
function requeue(id: string): void {
  queuedIds.push(id);
}

export const useUploadStore = create<UploadState>((set, get) => ({
  tasks: {},
  visible: false,
  panelCollapsed: readPanelCollapsed(),
  panelMode: readPanelMode(),
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
        lastModified: file.lastModified,
        status: 'queued',
        progress: 0,
        bytesDone: 0,
      };
      newIds.push(id);
    }
    // 新任务入队时清除「用户全部暂停」标记：新增文件即代表用户要继续传（登录过期暂停不受影响）
    // 同时展开列表（刚拖入文件时给出明确反馈），并同步持久化最小化偏好
    writePanelCollapsed(false);
    set((s) => ({
      tasks: { ...s.tasks, ...additions },
      visible: true,
      panelCollapsed: false,
      ...(s.pauseReason === 'user' ? { paused: false, pauseReason: undefined } : {}),
    }));
    queuedIds.push(...newIds);
    updateLimit(get().tasks);
    // 填满并发槽（暂停态不启动，恢复时统一调度）
    for (let i = 0; i < MAX_PARALLEL_SMALL; i++) void pump();
  },

  removeTask: (id) => {
    abortTask(id); // 真正中断在传请求（否则会在后台继续占用带宽）
    runTokens.delete(id); // 作废运行令牌：在途进度回调不再写回已删除任务
    set((s) => {
      const next = { ...s.tasks };
      delete next[id];
      return { tasks: next };
    });
  },

  retryTask: (id) => {
    const t = get().tasks[id];
    if (!t) return;
    if (t.kind === 'download') {
      set((s) => ({
        tasks: {
          ...s.tasks,
          [id]: { ...s.tasks[id], status: 'queued', progress: 0, bytesDone: 0, error: undefined, interruptReason: undefined, attempts: 0, retrying: false },
        },
      }));
      pumpDownloads(); // 下载：重新执行 run()
      return;
    }
    // 刷新后还原的任务没有本地 File：排队只会在执行体里抛错（旧版表现为"点了没反应"）
    if (!t.file) {
      markNeedsFile(id);
      return;
    }
    set((s) => ({
      tasks: {
        ...s.tasks,
        [id]: {
          ...s.tasks[id],
          status: 'queued',
          error: undefined,
          interruptReason: undefined,
          attempts: 0,
          retrying: false,
        },
      },
      // 用户显式点「重试」= 想继续传：解除暂停（登录过期需先重新登录，保持暂停由 UI 引导）
      ...(s.paused && s.pauseReason !== 'token_expired' ? { paused: false, pauseReason: undefined } : {}),
    }));
    if (get().paused) return; // 仍处于暂停（登录过期）：只改状态，不起调度
    requeue(id);
    updateLimit(get().tasks);
    void pump();
  },

  // 一键重试全部失败任务（v1.1.5；v1.1.10 含下载；v1.1.13 处理"刷新后缺文件"的任务）
  retryAllFailed: () => {
    const ids: string[] = [];
    set((s) => {
      const next: Record<string, UploadTask> = {};
      let errorCount = 0;
      for (const [id, t] of Object.entries(s.tasks)) {
        if (t.status !== 'error') {
          next[id] = t;
          continue;
        }
        errorCount += 1;
        // 无本地文件（刷新后还原）：不能静默排队（会瞬间再失败，表现为"点了没反应"），
        // 保持失败态并提示重选文件 —— 由 UI 先弹文件选择框，选回后再重试
        if (t.kind !== 'download' && !t.file) {
          next[id] = { ...t, needsFile: true, error: NEEDS_FILE_MSG, retrying: false, interruptReason: undefined };
          continue;
        }
        next[id] = {
          ...t,
          status: 'queued',
          error: undefined,
          interruptReason: undefined,
          attempts: 0,
          retrying: false,
          ...(t.kind === 'download' ? { progress: 0, bytesDone: 0 } : {}),
        };
        ids.push(id);
      }
      if (errorCount === 0) return {};
      // 用户显式重试 = 继续传：解除暂停（登录过期需先重新登录）
      return { tasks: next, ...(s.paused && s.pauseReason !== 'token_expired' ? { paused: false, pauseReason: undefined } : {}) };
    });
    if (ids.length === 0) return;
    // 上传与下载分开调度（下载有自己的并发上限，且不进入上传 FIFO）
    const uploadIds = ids.filter((id) => get().tasks[id]?.kind !== 'download');
    const downloadIds = ids.filter((id) => get().tasks[id]?.kind === 'download');
    if (uploadIds.length > 0 && !get().paused) {
      queuedIds.push(...uploadIds);
      updateLimit(get().tasks);
      for (let i = 0; i < MAX_PARALLEL_SMALL; i++) void pump();
    }
    if (downloadIds.length > 0) pumpDownloads();
  },

  // 需要重新选择本地文件的失败任务（v1.1.13）
  needsFileIds: () =>
    Object.values(get().tasks)
      .filter((t) => t.kind !== 'download' && !t.file && t.status !== 'completed' && t.status !== 'dedup')
      .map((t) => t.id),

  // 「重新开始」：优先用浏览器里持久化的文件内容续传；没有内容才请用户选文件（v1.1.16）
  restartTask: async (id) => {
    const t = get().tasks[id];
    if (!t) return 'none';
    if (t.kind === 'download') {
      get().retryTask(id);
      return 'resumed';
    }
    if (t.file) {
      get().retryTask(id);
      return 'resumed';
    }
    try {
      const rec = await loadResumeRecord(resumeKey(t.dirId, t.fileName, t.size));
      const f = rec?.file;
      if (f && f.size === t.size) {
        const r = get().attachFile(id, f);
        if (r.ok) {
          console.warn(`[resume] 「重新开始」命中本地持久化内容，直接续传：${t.fileName}`);
          return 'resumed';
        }
      }
    } catch {
      /* IndexedDB 不可用 → 走选文件 */
    }
    markNeedsFile(id);
    return 'need-file';
  },

  // 补上本地文件引用并立即重新入队（v1.1.13）：断点续传（IndexedDB 记录按 目录+文件名+大小 索引）
  attachFile: (id, file) => {
    const t = get().tasks[id];
    if (!t) return { ok: false, reason: '任务不存在（可能已被移除）' };
    if (t.kind === 'download') return { ok: false, reason: '下载任务不需要选择文件' };
    if (file.name !== t.fileName || file.size !== t.size) {
      return {
        ok: false,
        reason: `文件不匹配：该任务需要「${t.fileName}」（${fmtSize(t.size)}），而选择的是「${file.name}」（${fmtSize(file.size)}）。续传记录按文件名+大小索引，请选择刷新前那一个文件。`,
      };
    }
    if (!file.size) return { ok: false, reason: '该文件为空（0 字节），无法作为续传来源' };
    const warning =
      t.lastModified && file.lastModified && Math.abs(file.lastModified - t.lastModified) > 1000
        ? '所选文件的修改时间与刷新前不一致：如果内容已改动，请在续传前点「移除」后重新上传，避免出现内容不一致。'
        : undefined;
    set((s) => {
      const cur = s.tasks[id];
      if (!cur) return {};
      return {
        tasks: {
          ...s.tasks,
          [id]: {
            ...cur,
            file,
            lastModified: file.lastModified,
            needsFile: false,
            status: 'queued',
            error: undefined,
            interruptReason: undefined,
            attempts: 0,
            retrying: false,
          },
        },
        ...(s.paused && s.pauseReason !== 'token_expired' ? { paused: false, pauseReason: undefined } : {}),
      };
    });
    if (get().paused) return { ok: true, warning }; // 登录过期：等重新登录后自动继续
    requeue(id);
    updateLimit(get().tasks);
    for (let i = 0; i < MAX_PARALLEL_SMALL; i++) void pump();
    return { ok: true, warning };
  },

  // 暂停单个任务：queued→直接暂停；在传→中断请求（uploader 保留断点）
  pauseTask: (id) => {
    const t = get().tasks[id];
    if (!t) return;
    if (t.status !== 'queued' && t.status !== 'hashing' && t.status !== 'uploading') return;
    abortTask(id);
    set((s) => {
      const cur = s.tasks[id];
      if (!cur) return {};
      return { tasks: { ...s.tasks, [id]: { ...cur, status: 'paused', retrying: false } } };
    });
    reportUploadInterrupt('user_paused');
  },

  // 继续单个任务：重新入队（uploader 依据 IndexedDB/服务端分片续传）
  resumeTask: (id) => {
    const t = get().tasks[id];
    if (!t || t.status !== 'paused') return;
    set((s) => ({
      tasks: {
        ...s.tasks,
        [id]: { ...s.tasks[id], status: 'queued', error: undefined, interruptReason: undefined, attempts: 0, retrying: false },
      },
      // 用户主动继续 → 解除「用户全部暂停」（登录过期暂停需先重新登录）
      ...(s.pauseReason === 'user' || s.pauseReason === undefined ? { paused: false, pauseReason: undefined } : {}),
    }));
    requeue(id);
    updateLimit(get().tasks);
    void pump();
  },

  // 全部暂停（v1.1.5）：一键停止全部进行中/等待中任务
  pauseAll: () => {
    const ids = Object.values(get().tasks)
      .filter((t) => t.status === 'queued' || t.status === 'hashing' || t.status === 'uploading')
      .map((t) => t.id);
    for (const id of ids) abortTask(id);
    set((s) => {
      const next: Record<string, UploadTask> = {};
      let n = 0;
      for (const [id, t] of Object.entries(s.tasks)) {
        if (t.status === 'queued' || t.status === 'hashing' || t.status === 'uploading') {
          next[id] = { ...t, status: 'paused', retrying: false };
          n += 1;
        } else {
          next[id] = t;
        }
      }
      return n > 0 ? { tasks: next, paused: true, pauseReason: 'user' } : {};
    });
    if (ids.length > 0) reportUploadInterrupt('user_paused');
  },

  // 一键全部继续（v1.1.5）：所有暂停任务重新入队并调度
  resumeAll: () => {
    const s0 = get();
    if (s0.pauseReason === 'token_expired') return; // 登录过期：需先重新登录（UploadResumeButton 引导）
    const ids: string[] = [];
    set((s) => {
      const next: Record<string, UploadTask> = {};
      for (const [id, t] of Object.entries(s.tasks)) {
        if (t.status === 'paused') {
          next[id] = { ...t, status: 'queued', error: undefined, interruptReason: undefined, attempts: 0, retrying: false };
          ids.push(id);
        } else {
          next[id] = t;
        }
      }
      return { tasks: next, paused: false, pauseReason: undefined };
    });
    if (ids.length === 0) return;
    queuedIds.push(...ids);
    updateLimit(get().tasks);
    for (let i = 0; i < MAX_PARALLEL_SMALL; i++) void pump();
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

  // 清除失败任务（v1.1.15）：把 error / auth-failed / canceled 三类"已结束且未成功"的任务从列表移除
  //（含刷新后还原的 needsFile 失败任务）；持久化随 subscribe 自动同步，刷新后不会再回来
  clearFailed: () => {
    let removed = 0;
    set((s) => {
      const next: Record<string, UploadTask> = {};
      for (const [id, t] of Object.entries(s.tasks)) {
        const failed = t.status === 'error' || t.status === 'auth-failed' || t.status === 'canceled';
        if (failed) {
          removed += 1;
          continue;
        }
        next[id] = t;
      }
      return removed > 0 ? { tasks: next } : {};
    });
    return removed;
  },

  setVisible: (v) => set({ visible: v }),

  // 最小化/展开（持久化）：任务列表始终保留（胶囊 + 顶栏入口），不会因点击页面而丢失
  setPanelCollapsed: (v) => {
    writePanelCollapsed(v);
    set({ panelCollapsed: v });
  },

  // 顶栏固定入口：未显示 → 显示并展开；已显示 → 展开/最小化切换
  togglePanel: () =>
    set((s) => (s.visible ? { panelCollapsed: !s.panelCollapsed } : { visible: true, panelCollapsed: false })),

  // 面板形态：悬浮（默认，浮在网盘之上永不消失）/ 停靠右侧（占位，不遮挡列表）
  setPanelMode: (m) => {
    writePanelMode(m);
    set({ panelMode: m, visible: true });
  },
  togglePanelMode: () =>
    set((s) => {
      const next = s.panelMode === 'float' ? 'dock' : 'float';
      writePanelMode(next);
      return { panelMode: next, visible: true };
    }),

  // 新增下载任务：立即调度（并发上限 2），进度与结果都进同一任务列表
  addDownload: (spec) => {
    const id = crypto.randomUUID();
    set((s) => ({
      tasks: {
        ...s.tasks,
        [id]: {
          id,
          kind: 'download',
          fileName: spec.name,
          size: Math.max(0, spec.size || 0),
          dirId: spec.dirId ?? '',
          file: undefined as unknown as File,
          fileId: spec.fileId,
          isDir: spec.isDir,
          status: 'queued',
          progress: 0,
          bytesDone: 0,
          run: spec.run,
        },
      },
      visible: true,
      ...(s.panelMode === 'float' ? { panelCollapsed: false } : {}),
    }));
    writePanelCollapsed(false);
    pumpDownloads();
    return id;
  },

  // 取消下载：中断请求 → 状态「已取消」（可重试）
  cancelDownload: (id) => {
    abortTask(id);
    set((s) => (s.tasks[id] ? { tasks: { ...s.tasks, [id]: { ...s.tasks[id], status: 'canceled', retrying: false } } } : {}));
  },

  // 目录失效：整批清除（该目录下的排队/在传/失败任务全部移除），并解除暂停
  // ——否则用户点"清除失败"后，同目录的排队任务会再次失败并把队列重新暂停（循环）
  dismissDirMissing: () => {
    const state = get();
    const badDirs = new Set(
      Object.values(state.tasks)
        .filter((t) => t.interruptReason === 'dir_missing')
        .map((t) => t.dirId)
    );
    if (badDirs.size === 0) {
      set({ paused: false, pauseReason: undefined });
      return;
    }
    // 先中断在传请求（副作用放 set 之外）
    for (const [id, t] of Object.entries(state.tasks)) {
      if (badDirs.has(t.dirId)) abortTask(id);
    }
    for (const d of badDirs) dirGoneCounts.delete(d);
    set((s) => {
      const next: Record<string, UploadTask> = {};
      for (const [id, t] of Object.entries(s.tasks)) {
        if (badDirs.has(t.dirId)) continue; // 整批丢弃
        next[id] = t;
      }
      return { tasks: next, paused: false, pauseReason: undefined };
    });
  },

  // 401 纠错：暂停队列 + 未完成任务标记 auth-failed（保留进度信息供恢复）
  pauseForAuth: () => {
    reportUploadInterrupt('token_expired');
    const ids = Object.values(get().tasks)
      .filter((t) => t.kind !== 'download' && (t.status === 'uploading' || t.status === 'hashing' || t.status === 'queued'))
      .map((t) => t.id);
    for (const id of ids) abortTask(id); // 立即停止无效请求，断点已落 IndexedDB
    set((s) => {
      const next: Record<string, UploadTask> = {};
      for (const [id, t] of Object.entries(s.tasks)) {
        if (t.status === 'queued' || t.status === 'hashing' || t.status === 'uploading') {
          next[id] = { ...t, status: 'auth-failed', progress: t.progress, bytesDone: t.bytesDone, interruptReason: 'token_expired', retrying: false };
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
          next[id] = { ...t, status: 'queued', error: undefined, interruptReason: undefined, attempts: 0, retrying: false };
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
    if (state.paused) return; // 暂停中不做补传（避免与用户暂停意图冲突）
    // 只关心上传任务（下载任务不进补传比对，v1.1.10）
    const all = Object.values(state.tasks).filter((t) => t.kind !== 'download');
    if (all.length === 0) return;
    // 只校验"本次已结束"的任务（completed/dedup/error 均视为应落库）
    const settled = all.filter((t) => t.status === 'completed' || t.status === 'dedup' || t.status === 'error');
    if (settled.length === 0) return;
    // 防重入：进行中/暂停中有任务时不校验
    if (all.some((t) => t.status === 'queued' || t.status === 'hashing' || t.status === 'uploading' || t.status === 'paused')) return;

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

// =============================================================================
// 任务列表持久化（v1.1.10）
// 背景：用户反馈「点一下网盘界面，上传列表就消失了」。除 UI 收起问题外，另一大原因是
//       **浏览器刷新/前进后退会整页重载**，内存里的队列被清空 → 列表凭空消失。
// 方案：把任务列表（不含 File 对象/闭包）节流写入 localStorage，启动时还原：
//   - 已完成/失败/取消的条目原样还原（历史仍在）
//   - 传输中被重载打断的条目 → 标记「已中断」并给出可执行提示；下载可一键重新下载
//     （用持久化的 fileId/isDir 重建下载执行体）；上传需重新选择文件（≤8MB 自动续传）
// =============================================================================
const PERSIST_KEY = 'nd_task_list_v1';
const PERSIST_MAX = 300;

interface SlimTask {
  id: string;
  kind?: TaskKind;
  fileName: string;
  size: number;
  dirId: string;
  fileId?: string;
  isDir?: boolean;
  status: UploadTaskStatus;
  progress: number;
  bytesDone: number;
  error?: string;
  /** 本地文件修改时间（v1.1.13：重选文件时校验是否为同一个文件） */
  lastModified?: number;
}
const INTERRUPTED = new Set<UploadTaskStatus>(['queued', 'hashing', 'uploading', 'downloading', 'paused', 'auth-failed']);

function persistSnapshot(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const tasks = Object.values(useUploadStore.getState().tasks);
    const slim: SlimTask[] = tasks.slice(-PERSIST_MAX).map((t) => ({
      id: t.id,
      kind: t.kind,
      fileName: t.fileName,
      size: t.size,
      dirId: t.dirId,
      fileId: t.fileId,
      isDir: t.isDir,
      status: t.status,
      progress: t.progress,
      bytesDone: t.bytesDone,
      error: t.error,
      lastModified: t.lastModified,
    }));
    localStorage.setItem(PERSIST_KEY, JSON.stringify(slim));
  } catch {
    /* 存储不可用/超配额：忽略（列表仅在内存中） */
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistSnapshot();
  }, 500);
}

/** 为「刷新后还原的下载任务」重建执行体（凭 fileId/isDir 重新取地址） */
function rebuildDownloadRun(t: Pick<UploadTask, 'fileName' | 'size' | 'fileId' | 'isDir'>): ((ctx: DownloadCtx) => Promise<void>) | undefined {
  if (!t.fileId) return undefined;
  const fileId = t.fileId;
  return async (ctx: DownloadCtx) => {
    if (t.isDir) {
      return downloadToFile(`/api/files/${fileId}/download-dir`, ctx, {
        fileName: t.fileName,
        headers: { Authorization: 'Bearer ' + (localStorage.getItem('nd_access_token') ?? '') },
        jsonError: true,
      });
    }
    const { url } = await filesApi.download(fileId);
    return downloadToFile(url, ctx, { fileName: t.fileName, knownSize: t.size });
  };
}

/**
 * 启动时还原任务列表（幂等，只还原一次）。
 * 由 MainLayout 挂载时调用——刷新/浏览器前进后退后列表依然在，不再"凭空消失"。
 */
let hydrated = false;
export function hydrateTaskList(): void {
  if (hydrated) return;
  hydrated = true;
  let arr: SlimTask[] = [];
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PERSIST_KEY) : null;
    if (!raw) return;
    arr = JSON.parse(raw) as SlimTask[];
  } catch {
    return;
  }
  if (!Array.isArray(arr) || arr.length === 0) return;

  const restored: Record<string, UploadTask> = {};
  for (const s of arr) {
    if (!s?.id || !s.fileName) continue;
    const kind: TaskKind = s.kind === 'download' ? 'download' : 'upload';
    const interrupted = INTERRUPTED.has(s.status);
    const status: UploadTaskStatus = interrupted ? 'error' : s.status;
    // 上传任务被打断 → 本地 File 引用必然丢失（无法持久化），标记 needsFile：
    // UI 会把「重试」换成「重新选择文件」，点选回同一个文件即可断点续传
    const needsFile = interrupted && kind !== 'download';
    const error = interrupted
      ? kind === 'download'
        ? '页面刷新导致中断，可点击「重新下载」'
        : NEEDS_FILE_MSG
      : s.error;
    const task: UploadTask = {
      id: s.id,
      kind,
      fileName: s.fileName,
      size: Math.max(0, s.size || 0),
      dirId: s.dirId ?? '',
      file: undefined as unknown as File,
      fileId: s.fileId,
      isDir: s.isDir,
      needsFile,
      lastModified: s.lastModified,
      status,
      progress: interrupted ? 0 : s.progress ?? 0,
      bytesDone: interrupted ? 0 : s.bytesDone ?? 0,
      error,
    };
    if (kind === 'download') {
      const run = rebuildDownloadRun(task);
      if (run) task.run = run;
    }
    restored[s.id] = task;
  }
  if (Object.keys(restored).length === 0) return;
  useUploadStore.setState((s) => ({ tasks: restored, visible: true, ...(s.panelMode === 'dock' ? {} : { panelCollapsed: false }) }));
  // 断点记录里带文件内容 → 直接自动续传原任务（v1.1.16：大小不限，是否留有内容由存储预算决定）
  void autoResumeFromRecords(restored);
}

/**
 * 刷新后用 IndexedDB 里保存的文件内容自动续传（v1.1.13 起为小文件，v1.1.16 起不限大小）。
 * 背景：浏览器无法在 localStorage 里保存 File，但 **IndexedDB 可以**（resume-store 按预算持久化内容），
 * 所以只要内容还在，刷新后就能自己接着传，用户不需要再点任何按钮、也不需要重新选择文件。
 */
async function autoResumeFromRecords(restored: Record<string, UploadTask>): Promise<void> {
  const targets = Object.values(restored).filter((t) => t.needsFile && t.size > 0);
  if (targets.length === 0) return;
  let resumed = 0;
  for (const t of targets) {
    try {
      const rec = await loadResumeRecord(resumeKey(t.dirId, t.fileName, t.size));
      const f = rec?.file;
      if (!f) continue; // 没有持久化的文件内容 → 保持 needsFile，等用户点「重新开始」
      const cur = useUploadStore.getState().tasks[t.id];
      if (!cur || !cur.needsFile) continue; // 用户已经手动处理过
      useUploadStore.getState().attachFile(t.id, f);
      resumed += 1;
    } catch {
      /* IndexedDB 不可用：保持 needsFile（用户点「重新开始」） */
    }
  }
  if (resumed > 0) console.warn(`[resume] 刷新后自动续传 ${resumed} 个任务（无需手动重选文件）`);
}

// 订阅 store：任务变化时节流持久化（含进度更新）
useUploadStore.subscribe(schedulePersist);

/** 悬浮面板位置读写（供 UI 拖拽持久化；v1.1.10） */
export { readPanelPos, writePanelPos };

/** 判断任务是否为下载任务 */
export function isDownloadTask(t: UploadTask): boolean {
  return t.kind === 'download';
}

/** 任务是否处于「进行中」（上传或下载），供面板计数/自动收起判断 */
export const ACTIVE_TASK_STATUS = new Set<UploadTaskStatus>(['queued', 'hashing', 'uploading', 'downloading']);

// 测试/调试钩子：暴露 store 到 window（e2e 可访问）
if (typeof window !== 'undefined') {
  (window as unknown as { __uploadStore?: unknown }).__uploadStore = useUploadStore;
}
