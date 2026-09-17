// 上传/下载任务列表（v1.1.10：默认悬浮浮层，浮在网盘之上且永不消失；可切停靠右侧）
// 形态演进：
//   v1.1.5 右下角可拖拽悬浮卡片（不遮挡页面 → 但收起后不易找回）
//   v1.1.6 列表常驻：不再自动隐藏 + 顶栏固定「上传任务」入口
//   v1.1.7 桌面端改为右侧常驻栏（占位式）
//   v1.1.9 取消 Esc 收起；收起态改为带文字的紧凑面板
//   v1.1.10 默认回到**悬浮浮层**（用户诉求：浮在网盘界面之上，操作网盘时列表不消失）；
//           可一键切换「悬浮 / 停靠右侧」；同一列表管理**上传 + 下载**任务
// 关键保证：只要有任务，列表就一定以「浮层/紧凑面板/胶囊」之一存在，任何点击都不会让它消失
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Badge, Button, Checkbox, Divider, Layout, List, Progress, Space, Tag, Tooltip, Typography, message, notification,
} from 'antd';
import {
  CheckCircleOutlined,
  CloudDownloadOutlined,
  CloudUploadOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownOutlined,
  FolderOpenOutlined,
  LeftOutlined,
  LoginOutlined,
  MinusOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RightOutlined,
  StopOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { ACTIVE_TASK_STATUS, readPanelPos, useUploadStore, writePanelPos } from '../store/upload';
import type { UploadTask } from '../store/upload';
import { pickFiles } from '../utils/filePicker';
import { formatSize } from '../utils/format';
import { useIsMobile } from '../utils/useMediaQuery';

const { Sider } = Layout;

const MAX_RENDER = 200;
const FLOAT_W = 380;
const FLOAT_H = 460;

const STATUS_META: Record<string, { color: string; label: string }> = {
  queued: { color: 'default', label: '等待中' },
  hashing: { color: 'processing', label: '计算哈希' },
  uploading: { color: 'processing', label: '上传中' },
  downloading: { color: 'processing', label: '下载中' },
  paused: { color: 'warning', label: '已暂停' },
  completed: { color: 'success', label: '已完成' },
  dedup: { color: 'success', label: '秒传(去重)' },
  error: { color: 'error', label: '失败' },
  aborted: { color: 'warning', label: '已中止' },
  canceled: { color: 'default', label: '已取消' },
  'auth-failed': { color: 'warning', label: '登录过期' },
};

const ACTIVE_STATUS = ACTIVE_TASK_STATUS;

function isDone(t: UploadTask): boolean {
  return t.status === 'completed' || t.status === 'dedup';
}
function isDownload(t: UploadTask): boolean {
  return t.kind === 'download';
}
function isActiveTask(t: UploadTask): boolean {
  return ACTIVE_STATUS.has(t.status);
}

export default function UploadQueue() {
  // 低频轮询（1s）：避免订阅每任务状态变化导致的高频重渲染（万级任务时每次 setState 都重渲染）
  const [snapshot, setSnapshot] = useState(() => {
    const s = useUploadStore.getState();
    return {
      tasks: Object.values(s.tasks),
      visible: s.visible,
      panelCollapsed: s.panelCollapsed,
      running: s._running,
      paused: s.paused,
      pauseReason: s.pauseReason,
    };
  });
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const timer = setInterval(() => {
      const s = useUploadStore.getState();
      setSnapshot({
        tasks: Object.values(s.tasks),
        visible: s.visible,
        panelCollapsed: s.panelCollapsed,
        running: s._running,
        paused: s.paused,
        pauseReason: s.pauseReason,
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const { tasks, visible, panelCollapsed: collapsed, running, paused, pauseReason } = snapshot;
  // 视口宽度：用于让右侧常驻栏自适应，保证文件列表始终有可用宽度（v1.1.8）
  const [vw, setVw] = useState<number>(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = (): void => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const setVisible = useUploadStore((s) => s.setVisible);
  const setPanelCollapsed = useUploadStore((s) => s.setPanelCollapsed);
  const panelMode = useUploadStore((s) => s.panelMode);
  const togglePanelMode = useUploadStore((s) => s.togglePanelMode);
  const removeTask = useUploadStore((s) => s.removeTask);
  const retryTask = useUploadStore((s) => s.retryTask);
  const retryAllFailed = useUploadStore((s) => s.retryAllFailed);
  const attachFile = useUploadStore((s) => s.attachFile);
  const pauseTask = useUploadStore((s) => s.pauseTask);
  const resumeTask = useUploadStore((s) => s.resumeTask);
  const pauseAll = useUploadStore((s) => s.pauseAll);
  const resumeAll = useUploadStore((s) => s.resumeAll);
  const clearCompleted = useUploadStore((s) => s.clearCompleted);
  const resumeAuth = useUploadStore((s) => s.resumeAuth);
  const cancelDownload = useUploadStore((s) => s.cancelDownload);

  // 暂停/继续都给出明确反馈（v1.1.9）：
  // 用户反馈「点了一下就暂停了，不知道发生了什么、按钮在哪」——操作后立刻提示，
  // 并说明恢复入口与断点保留，避免"静默暂停"。
  const handlePauseAll = (): void => {
    const n = activeCount;
    pauseAll();
    if (n > 0) {
      message.info(`已暂停 ${n} 个上传任务（已传分片保留）。点「全部继续」或顶栏「上传任务」可恢复。`);
    }
  };
  const handleResumeAll = (): void => {
    const n = pausedCount;
    resumeAll();
    if (n > 0) message.success(`已继续 ${n} 个上传任务（从断点续传，不重复上传）`);
  };

  // ---------- 重试（v1.1.13：刷新后缺文件的任务改走「重新选择文件」） ----------
  // 背景：刷新/重开页面后，浏览器不允许恢复 File 对象，任务只剩名字与大小。
  // 旧实现点「重试」会直接把它排队 → 上传执行体读 file.name 抛错 → 几十毫秒后又变回失败，
  // 用户看到的就是「按钮点了没反应」。现在改为：先让用户选回同一个文件，再断点续传。
  /** 该任务是否缺少本地文件引用（刷新后还原的上传任务） */
  const needsFileOf = (t: UploadTask): boolean => t.kind !== 'download' && !t.file;
  /** 当前所有等待重选文件的失败任务（实时读 store，避免 1s 快照延迟） */
  const collectNeedsFile = (): UploadTask[] => {
    const all = Object.values(useUploadStore.getState().tasks);
    return all.filter((t) => needsFileOf(t) && t.status === 'error');
  };

  const handleRetryOne = async (t: UploadTask): Promise<void> => {
    if (!needsFileOf(t)) {
      retryTask(t.id);
      return;
    }
    const picked = await pickFiles({ multiple: false });
    if (picked.length === 0) {
      message.info(`未选择文件：「${t.fileName}」需要选回刷新前那一个文件才能续传。`);
      return;
    }
    const r = attachFile(t.id, picked[0]);
    if (!r.ok) {
      message.error(r.reason ?? '文件不匹配');
      return;
    }
    if (r.warning) message.warning(r.warning);
    message.success(`已选回「${picked[0].name}」，从断点继续上传（不重复上传已传分片）`);
  };

  const handleRetryAll = async (): Promise<void> => {
    const need = collectNeedsFile();
    if (need.length > 0) {
      message.info(`有 ${need.length} 个任务在刷新前被中断，需要重新选择这些文件才能续传`);
      const picked = await pickFiles({ multiple: true });
      const used = new Set<number>();
      for (const t of need) {
        const idx = picked.findIndex(
          (f, i) => !used.has(i) && f.name === t.fileName && f.size === t.size
        );
        if (idx >= 0) {
          used.add(idx);
          attachFile(t.id, picked[idx]);
        }
      }
      const stillMissing = collectNeedsFile();
      if (stillMissing.length > 0) {
        const names = stillMissing.slice(0, 5).map((t) => t.fileName).join('、');
        message.warning(
          `仍有 ${stillMissing.length} 个任务没有选回文件：${names}${stillMissing.length > 5 ? ' 等' : ''}。请逐个点任务右侧的「重新选择文件」。`
        );
      }
    }
    retryAllFailed(); // 有本地文件的失败任务（网络/服务端错误）照常重试
  };

  // 注意：不再监听 Esc 收起面板（v1.1.9）——
  // 旧行为会导致「按 Esc 关预览/弹窗时，上传队列一起收成图标细栏」，
  // 用户既看不到进度、也找不到暂停/继续按钮。收起只由显式按钮触发。
  // 同时（v1.1.10）悬浮模式也不再响应任何"点击外部/失焦"事件——操作网盘绝不影响列表。

  // 悬浮模式下可拖拽：位置持久化
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    if (typeof window === 'undefined') return { x: 0, y: 0 };
    const saved = readPanelPos();
    return saved ?? { x: Math.max(12, window.innerWidth - FLOAT_W - 24), y: Math.max(12, window.innerHeight - FLOAT_H - 24) };
  });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const onDragStart = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (panelMode !== 'float') return;
    const rect = (e.currentTarget as HTMLElement).closest('.upload-float')?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (!d) return;
    const x = Math.min(Math.max(4, e.clientX - d.dx), Math.max(4, window.innerWidth - 120));
    const y = Math.min(Math.max(4, e.clientY - d.dy), Math.max(4, window.innerHeight - 60));
    setPos({ x, y });
  };
  const onDragEnd = (): void => {
    if (!dragRef.current) return;
    dragRef.current = null;
    writePanelPos(pos);
  };

  // 选择集裁剪：任务被移除后清理残留选中
  useEffect(() => {
    if (selected.size === 0) return;
    const alive = new Set(tasks.map((t) => t.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of selected) {
      if (alive.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setSelected(next);
  }, [tasks, selected]);

  const activeCount = tasks.filter((t) => ACTIVE_STATUS.has(t.status)).length;
  const pausedCount = tasks.filter((t) => t.status === 'paused').length;
  const totalDone = tasks.filter(isDone).length;
  const totalFailed = tasks.filter((t) => t.status === 'error').length;
  const totalAuthFailed = tasks.filter((t) => t.status === 'auth-failed').length;
  // 下载相关计数（v1.1.10）
  const downloadActive = tasks.filter((t) => isDownload(t) && ACTIVE_STATUS.has(t.status)).length;
  const uploadActive = tasks.filter((t) => !isDownload(t) && ACTIVE_STATUS.has(t.status)).length;
  const downloadCount = tasks.filter(isDownload).length;
  const uploadCount = tasks.length - downloadCount;

  // 总进度（按文件大小加权，大文件拖动更符合直觉）
  const overallPct = useMemo(() => {
    let total = 0;
    let done = 0;
    for (const t of tasks) {
      total += Math.max(t.size, 1);
      done += (Math.max(t.size, 1) * (isDone(t) ? 100 : t.progress)) / 100;
    }
    return total > 0 ? Math.round((done / total) * 100) : 0;
  }, [tasks]);

  // 渲染裁剪：进行中/失败/暂停优先，其次最近完成的；总量远超时显示提示
  const renderTasks = useMemo(() => {
    if (tasks.length <= MAX_RENDER) return tasks;
    const focus = tasks.filter(
      (t) => ACTIVE_STATUS.has(t.status) || t.status === 'error' || t.status === 'paused' || t.status === 'auth-failed'
    );
    if (focus.length >= MAX_RENDER) return focus.slice(0, MAX_RENDER);
    const rest = tasks.filter((t) => !focus.includes(t)).slice(-(MAX_RENDER - focus.length));
    return [...focus, ...rest];
  }, [tasks]);

  // 实时速率（每秒差分 bytesDone）
  const [speeds, setSpeeds] = useState<Record<string, number>>({});
  const prevRef = useRef<Record<string, { bytes: number; ts: number }>>({});
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const list = Object.values(useUploadStore.getState().tasks);
      const next: Record<string, number> = {};
      for (const t of list) {
        if (t.status !== 'uploading' && t.status !== 'hashing') continue;
        const prev = prevRef.current[t.id];
        if (prev) {
          const dt = (now - prev.ts) / 1000;
          if (dt > 0.2) next[t.id] = Math.max(0, (t.bytesDone - prev.bytes) / dt);
        }
        prevRef.current[t.id] = { bytes: t.bytesDone, ts: now };
      }
      setSpeeds(next);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const overallSpeed = useMemo(() => Object.values(speeds).reduce((a, b) => a + b, 0), [speeds]);

  // 全部任务结束（成功/失败/暂停均视为已结束）：只做完成提示 + 完整性校验
  // v1.1.6：不再自动隐藏面板——任务列表常驻，由用户「清除已完成」或「最小化」决定去留
  const allSettled = tasks.length > 0 && activeCount === 0 && pausedCount === 0 && totalAuthFailed === 0 && !paused;
  const notifiedRef = useRef<string>('');
  useEffect(() => {
    // 注意：不依赖面板是否展开——面板收起时上传仍在继续，完成提示与完整性校验必须照常触发
    if (!allSettled) return;
    const done = tasks.filter(isDone).length;
    const failed = tasks.filter((t) => t.status === 'error').length;
    const hasFinished = done > 0;
    const hasError = failed > 0;
    // 汇总提示（每个批次只弹一次；避免重复渲染时多次通知）
    const signature = `${done}:${failed}:${tasks.length}`;
    if (notifiedRef.current !== signature) {
      notifiedRef.current = signature;
      if (hasFinished || hasError) {
        const title = hasError
          ? `任务完成：${done} 成功，${failed} 失败`
          : downloadCount > 0 && uploadCount > 0
            ? `任务完成：${done} 个（上传 ${uploadCount} · 下载 ${downloadCount}）`
            : downloadCount > 0
              ? `下载完成：${done} 个文件`
              : `上传完成：${done} 个文件`;
        notification[hasError ? 'warning' : 'success']({
          message: title,
          description: hasError
            ? '失败项已保留在任务列表中，可点「重试失败」；若刷新过页面，会先让你选回本地文件再断点续传'
            : downloadCount > 0
              ? '文件已保存到浏览器下载目录（任务列表保留，可点「清除已完成」收起）'
              : '文件已保存到当前目录（任务列表保留，可点「清除已完成」收起）',
          duration: 4,
        });
      }
    }
    if (!hasFinished || hasError) return;
    // 完整性校验 + 自动补传（全部任务成功结束后）：防偶发漏传，保证 100% 落库
    void useUploadStore.getState().verifyAndBackfill();
  }, [allSettled, tasks]);

  // ---------- 选中态派生的批量操作 ----------
  const selectedTasks = useMemo(() => tasks.filter((t) => selected.has(t.id)), [tasks, selected]);
  const selPausable = selectedTasks.filter((t) => ACTIVE_STATUS.has(t.status)).length;
  const selResumable = selectedTasks.filter((t) => t.status === 'paused').length;
  const allSelected = tasks.length > 0 && selected.size === tasks.length;
  const partlySelected = selected.size > 0 && !allSelected;

  const toggleAll = (checked: boolean): void => {
    setSelected(checked ? new Set(tasks.map((t) => t.id)) : new Set());
  };
  const toggleOne = (id: string, checked: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const pauseSelected = (): void => {
    for (const t of selectedTasks) if (ACTIVE_STATUS.has(t.status)) pauseTask(t.id);
  };
  const resumeSelected = (): void => {
    for (const t of selectedTasks) if (t.status === 'paused') resumeTask(t.id);
  };

  // ---------- 渲染 ----------
  // 任务列表常驻（v1.1.6+）：只要有任务就一定渲染某种形态，操作网盘/切页/按 Esc 都不会消失
  //   桌面端-悬浮（默认，v1.1.10）：fixed 浮层浮在网盘之上（可拖拽、可最小化为浮层胶囊）
  //   桌面端-停靠：右侧占位常驻栏（不覆盖列表）
  //   移动端：底部非模态面板 + 进度胶囊
  if (tasks.length === 0) return null;

  const summary = `${totalDone}/${tasks.length}`;
  const allDone = activeCount === 0 && pausedCount === 0 && totalFailed === 0 && totalAuthFailed === 0 && totalDone > 0;
  const expand = (): void => {
    setVisible(true);
    setPanelCollapsed(false);
  };

  const authExpired = pauseReason === 'token_expired';
  const hasToken = typeof window !== 'undefined' && !!localStorage.getItem('nd_access_token');

  // 形态切换按钮（悬浮 ⇄ 停靠）
  const modeButton = (
    <Tooltip title={panelMode === 'float' ? '切换为「停靠右侧」（占位，不覆盖文件列表）' : '切换为「悬浮浮层」（浮在网盘之上，可拖动）'}>
      <Button
        size="small"
        type="text"
        icon={panelMode === 'float' ? <RightOutlined /> : <UpOutlined />}
        onClick={() => togglePanelMode()}
      />
    </Tooltip>
  );

  // 面板主体（浮层 / 停靠栏 / 移动端底部面板共用，避免多套列表逻辑分叉）
  const body = (
    <>
      <div
        className="upload-panel__header"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <Space size={6} wrap style={{ minWidth: 0 }}>
          <CloudUploadOutlined style={{ color: '#1677ff' }} />
          <Typography.Text strong style={{ fontSize: 13 }}>上传队列 · 下载任务</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{summary}</Typography.Text>
          {uploadActive > 0 && <Tag color="processing" style={{ marginInlineEnd: 0 }}>上传 {uploadActive}</Tag>}
          {downloadActive > 0 && <Tag color="blue" style={{ marginInlineEnd: 0 }}>下载 {downloadActive}</Tag>}
          {pausedCount > 0 && <Tag color="warning" style={{ marginInlineEnd: 0 }}>{pausedCount} 已暂停</Tag>}
          {totalFailed > 0 && <Tag color="error" style={{ marginInlineEnd: 0 }}>{totalFailed} 失败</Tag>}
        </Space>
        <Space size={0}>
          {!isMobile && modeButton}
          {isMobile ? (
            <>
              <Tooltip title="最小化为胶囊（列表保留）">
                <Button size="small" type="text" icon={<MinusOutlined />} onClick={() => setPanelCollapsed(true)} />
              </Tooltip>
              <Tooltip title="收起面板（列表保留在胶囊 / 顶栏「上传任务」）">
                <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => setVisible(false)} />
              </Tooltip>
            </>
          ) : (
            <Tooltip title={panelMode === 'float' ? '最小化为浮层胶囊（列表保留，随时展开）' : '收起为右侧紧凑面板（列表保留）'}>
              <Button size="small" type="text" icon={<MinusOutlined />} onClick={() => setPanelCollapsed(true)} />
            </Tooltip>
          )}
        </Space>
      </div>

      {/* 总进度 */}
      <Progress
        className="upload-overall-progress"
        percent={overallPct}
        size="small"
        status={totalFailed > 0 ? 'exception' : activeCount > 0 ? 'active' : 'normal'}
        style={{ margin: '0 0 6px' }}
        format={(p) => `${p ?? 0}%${overallSpeed > 0 && activeCount > 0 ? ` · ${formatSize(overallSpeed)}/s` : ''}`}
      />

      {authExpired && (        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={`登录已过期，${totalAuthFailed} 个文件等待继续上传`}
          description="上传已暂停（已上传部分不会重复上传）。请重新登录后点击「继续上传」。"
          action={
            <Button
              size="small"
              icon={<LoginOutlined />}
              onClick={() => {
                if (hasToken) {
                  resumeAuth();
                } else {
                  try {
                    sessionStorage.setItem('nd_resume_upload', '1');
                  } catch {
                    /* ignore */
                  }
                  navigate('/login');
                }
              }}
            >
              {hasToken ? '继续上传' : '重新登录'}
            </Button>
          }
        />
      )}

      {/* 目标目录失效（v1.1.11）：整棵目录被删/移动后，队列自动暂停并给出可执行指引 */}
      {pauseReason === 'dir-missing' && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 8 }}
          message="上传目标目录已不存在，队列已暂停"
          description="这些文件原本要传进的目录已被删除或移动。请重新选择目录后再上传；已失败的任务可点「移除」清理。"
          action={
            <Space direction="vertical" size={4}>
              <Button size="small" onClick={() => resumeAll()}>
                仍然继续
              </Button>
              <Button
                size="small"
                danger
                onClick={() => useUploadStore.getState().dismissDirMissing()}
              >
                清除这些失败任务
              </Button>
            </Space>
          }
        />
      )}
      <div className="upload-panel__toolbar">
        <Checkbox checked={allSelected} indeterminate={partlySelected} onChange={(e) => toggleAll(e.target.checked)}>
          <span style={{ fontSize: 12 }}>全选</span>
        </Checkbox>
        <Space size={4} wrap>
          <Tooltip title="暂停选中的任务（在传请求立即停止，断点保留）">
            <Button size="small" icon={<PauseCircleOutlined />} disabled={selPausable === 0} onClick={pauseSelected}>
              暂停{selPausable > 0 ? `(${selPausable})` : ''}
            </Button>
          </Tooltip>
          <Tooltip title="继续选中的任务（从断点续传，不重复上传）">
            <Button size="small" icon={<PlayCircleOutlined />} disabled={selResumable === 0} onClick={resumeSelected}>
              继续{selResumable > 0 ? `(${selResumable})` : ''}
            </Button>
          </Tooltip>
          <Divider type="vertical" style={{ margin: '0 2px' }} />
          <Tooltip title="全部暂停（一键停止所有上传任务）">
            <Button
              size="small"
              type={activeCount > 0 ? 'primary' : 'default'}
              ghost={activeCount > 0}
              icon={<PauseCircleOutlined />}
              disabled={activeCount === 0}
              onClick={handlePauseAll}
            >
              全部暂停
            </Button>
          </Tooltip>
          <Tooltip title="一键全部继续（所有已暂停任务从断点续传）">
            <Button size="small" type={pausedCount > 0 ? 'primary' : 'default'} icon={<PlayCircleOutlined />} disabled={pausedCount === 0} onClick={handleResumeAll}>
              全部继续
            </Button>
          </Tooltip>
          <Tooltip title="重试全部失败任务（刷新前中断的任务会先弹出文件选择框，选回文件即断点续传）">
            <Button size="small" icon={<ReloadOutlined />} disabled={totalFailed === 0} onClick={() => void handleRetryAll()}>
              重试失败
            </Button>
          </Tooltip>
          <Tooltip title="清除已完成/秒传的任务记录（列表随之收起）">
            <Button size="small" icon={<DeleteOutlined />} disabled={totalDone === 0} onClick={() => clearCompleted()}>
              清除已完成
            </Button>
          </Tooltip>
        </Space>
      </div>

      {/* 任务列表 */}
      <div className="upload-panel__list">
        <List
          className="upload-queue"
          size="small"
          dataSource={renderTasks}
          locale={{ emptyText: '暂无上传任务' }}
          renderItem={(t) => {
            const meta = STATUS_META[t.status];
            const done = isDone(t);
            const failed = t.status === 'error';
            const dl = isDownload(t);
            const active = t.status === 'uploading' || t.status === 'hashing' || t.status === 'downloading';
            const isPaused = t.status === 'paused';
            const speed = speeds[t.id] ?? 0;
            return (
              <List.Item
                className="upload-panel__item"
                actions={[
                  // 上传：暂停/继续；下载：取消/重试（下载不支持暂停，只能取消）
                  !dl && active ? (
                    <Tooltip key="pause" title="暂停此任务">
                      <Button size="small" type="text" icon={<PauseCircleOutlined />} onClick={() => pauseTask(t.id)} />
                    </Tooltip>
                  ) : null,
                  !dl && isPaused ? (
                    <Tooltip key="resume" title="继续此任务（断点续传）">
                      <Button size="small" type="text" icon={<PlayCircleOutlined />} onClick={() => resumeTask(t.id)} />
                    </Tooltip>
                  ) : null,
                  dl && (active || t.status === 'queued') ? (
                    <Tooltip key="cancel" title="取消下载">
                      <Button size="small" type="text" icon={<StopOutlined />} onClick={() => cancelDownload(t.id)} />
                    </Tooltip>
                  ) : null,
                  (failed || (dl && t.status === 'canceled')) ? (
                    needsFileOf(t) ? (
                      <Tooltip key="pick" title="刷新后本地文件引用已丢失：点此选回同一个文件，从断点继续上传">
                        <Button
                          size="small"
                          type="text"
                          icon={<FolderOpenOutlined />}
                          onClick={() => void handleRetryOne(t)}
                        />
                      </Tooltip>
                    ) : (
                      <Tooltip key="retry" title={dl ? '重新下载' : '重试'}>
                        <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => retryTask(t.id)} />
                      </Tooltip>
                    )
                  ) : null,
                  <Tooltip key="rm" title="移除任务">
                    <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => removeTask(t.id)} />
                  </Tooltip>,
                ].filter(Boolean) as React.ReactElement[]}
              >
                <Checkbox checked={selected.has(t.id)} onChange={(e) => toggleOne(t.id, e.target.checked)} style={{ marginRight: 8 }} />
                <div style={{ width: '100%', minWidth: 0 }}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Typography.Text ellipsis style={{ maxWidth: isMobile ? 150 : 100, fontSize: 13 }} title={t.fileName}>
                      {dl ? <CloudDownloadOutlined style={{ marginRight: 4, color: '#1677ff' }} /> : null}
                      {t.fileName}
                    </Typography.Text>
                    <Space size={4}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {dl && t.bytesDone > 0 ? `${formatSize(t.bytesDone)}${t.size > 0 ? ` / ${formatSize(t.size)}` : ''}` : formatSize(t.size)}
                      </Typography.Text>
                      <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>
                        {t.status === 'dedup' ? <ThunderboltOutlined /> : done ? <CheckCircleOutlined /> : failed ? <CloseCircleOutlined /> : t.retrying ? <SyncOutlined spin /> : null}{' '}
                        {t.retrying ? `自动重试 ${t.attempts ?? 1}` : meta.label}
                      </Tag>
                    </Space>
                  </Space>
                  {active || isPaused || t.retrying ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Progress
                        percent={t.progress}
                        size="small"
                        status={isPaused ? 'normal' : 'active'}
                        strokeColor={isPaused ? '#faad14' : dl ? '#1677ff' : undefined}
                        style={{ flex: 1, marginInlineEnd: 0 }}
                      />
                      {speed > 0 && active && (
                        <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                          {formatSize(speed)}/s
                        </Typography.Text>
                      )}
                    </div>
                  ) : failed ? (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>{t.error}</Typography.Text>
                  ) : null}
                </div>
              </List.Item>
            );
          }}
        />
      </div>

      {tasks.length > MAX_RENDER && (
        <Alert
          type="info"
          showIcon
          style={{ margin: '8px 10px 0' }}
          message={`共 ${tasks.length} 个任务，仅显示部分（进行中/暂停/失败优先）`}
          description={`已完成 ${totalDone} · 失败 ${totalFailed}${pausedCount ? ` · 已暂停 ${pausedCount}` : ''}${totalAuthFailed ? ` · 登录过期 ${totalAuthFailed}` : ''} · 剩余 ${tasks.length - totalDone - totalFailed - totalAuthFailed - pausedCount}`}
        />
      )}

      <div className="upload-panel__footer">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {running > 0
            ? `${running} 个任务正在传输`
            : pausedCount > 0
              ? '已暂停，点击「全部继续」恢复'
              : allDone
                ? `全部完成 ${summary} · 点「清除已完成」收起`
                : '空闲'}
        </Typography.Text>
        {isMobile ? (
          <Tooltip title="最小化为胶囊（列表保留）">
            <Button size="small" type="text" icon={<DownOutlined />} onClick={() => setPanelCollapsed(true)} />
          </Tooltip>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            固定右侧
          </Typography.Text>
        )}
      </div>
    </>
  );

  // ---------- 移动端：进度胶囊 / 底部非模态面板 ----------
  if (isMobile) {
    if (collapsed || !visible) {
      return (
        <div className="upload-panel-pill" role="status">
          <Badge count={activeCount} size="small" offset={[-2, 2]}>
            <CloudUploadOutlined style={{ fontSize: 16, color: allDone ? '#52c41a' : '#1677ff' }} />
          </Badge>
          <span className="upload-panel-pill__text" onClick={expand} title="点击展开上传任务列表">
            {allDone ? `上传完成 ${summary} · 100%` : `上传 ${summary} · ${overallPct}%`}
            {overallSpeed > 0 && activeCount > 0 && <span className="upload-panel-pill__speed">{formatSize(overallSpeed)}/s</span>}
            {totalFailed > 0 && <span className="upload-panel-pill__fail">{totalFailed} 失败</span>}
            {pausedCount > 0 && <span className="upload-panel-pill__fail">{pausedCount} 暂停</span>}
          </span>
          {activeCount > 0 ? (
            <Tooltip title="全部暂停">
              <Button size="small" type="text" icon={<PauseCircleOutlined />} onClick={handlePauseAll} />
            </Tooltip>
          ) : pausedCount > 0 ? (
            <Tooltip title="全部继续">
              <Button size="small" type="text" icon={<PlayCircleOutlined />} onClick={handleResumeAll} />
            </Tooltip>
          ) : totalDone > 0 ? (
            <Tooltip title="清除已完成任务">
              <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => clearCompleted()} />
            </Tooltip>
          ) : null}
          <Tooltip title="展开上传任务列表">
            <Button size="small" type="text" icon={<UpOutlined />} onClick={expand} />
          </Tooltip>
        </div>
      );
    }
    return (
      <div className="upload-panel" role="dialog" aria-label="上传队列">
        {body}
      </div>
    );
  }

  // ---------- 桌面端 ----------
  const expanded = visible && !collapsed;
  const compactPanel = (
    // 收起态（v1.1.9+）：带文字的紧凑面板（进度 + 全部暂停/全部继续 常驻按钮）
    <div className="upload-dock__mini">
      <div className="upload-dock__mini-head">
        <Space size={6}>
          <CloudUploadOutlined style={{ color: allDone ? '#52c41a' : '#1677ff' }} />
          <Typography.Text strong style={{ fontSize: 13 }}>任务列表</Typography.Text>
        </Space>
        <Space size={0}>
          {modeButton}
          <Tooltip title="展开任务列表（查看每个文件）">
            <Button size="small" type="text" icon={<LeftOutlined />} onClick={expand}>
              展开
            </Button>
          </Tooltip>
        </Space>
      </div>

      <div className="upload-dock__mini-body">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          已完成 {summary} · {overallPct}%
          {overallSpeed > 0 && activeCount > 0 ? ` · ${formatSize(overallSpeed)}/s` : ''}
        </Typography.Text>
        <Progress
          percent={overallPct}
          size="small"
          showInfo={false}
          status={totalFailed > 0 ? 'exception' : activeCount > 0 ? 'active' : 'normal'}
          style={{ margin: '4px 0 8px' }}
        />
        {/* 暂停/继续按钮常驻（无任务可操作时置灰而非消失）——避免用户找不到按钮 */}
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Button
            block
            type={uploadActive > 0 ? 'primary' : 'default'}
            ghost={uploadActive > 0}
            disabled={uploadActive === 0}
            icon={<PauseCircleOutlined />}
            onClick={handlePauseAll}
          >
            全部暂停{uploadActive > 0 ? `（${uploadActive}）` : ''}
          </Button>
          <Button
            block
            type={pausedCount > 0 ? 'primary' : 'default'}
            disabled={pausedCount === 0}
            icon={<PlayCircleOutlined />}
            onClick={handleResumeAll}
          >
            全部继续{pausedCount > 0 ? `（${pausedCount}）` : ''}
          </Button>
          {totalFailed > 0 && (
            <Button block size="small" icon={<ReloadOutlined />} onClick={() => void handleRetryAll()}>
              重试失败（{totalFailed}）
            </Button>
          )}
          {totalDone > 0 && (
            <Button block size="small" icon={<DeleteOutlined />} onClick={() => clearCompleted()}>
              清除已完成（{totalDone}）
            </Button>
          )}
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
          {activeCount > 0
            ? `${uploadActive} 上传 · ${downloadActive} 下载 进行中`
            : pausedCount > 0
              ? `已暂停 ${pausedCount} 个（点「全部继续」恢复）`
              : allDone
                ? `全部完成 ${summary}`
                : '空闲'}
          {totalFailed > 0 ? ` · ${totalFailed} 个失败` : ''}
        </Typography.Text>
      </div>
    </div>
  );

  // 停靠模式（可选）：右侧占位常驻栏，不覆盖文件列表
  if (panelMode === 'dock') {
    // 宽度自适应（v1.1.8）：左导航 220 + 文件区最少 ~420
    const siderWidth = 220;
    const dockWidth = Math.max(240, Math.min(360, vw - siderWidth - 420));
    return (
      <Sider className="upload-dock" theme="light" width={dockWidth} collapsedWidth={196} collapsed={!expanded} trigger={null}>
        {expanded ? body : compactPanel}
      </Sider>
    );
  }

  // 悬浮模式（默认，v1.1.10）：fixed 浮层，浮在网盘界面之上；不响应任何"点击外部"事件，
  // 因此操作网盘（点文件/切目录/开预览/按 Esc）都不会让它消失；可拖拽、可最小化为浮层胶囊
  if (!expanded) {
    return (
      <div className="upload-float-pill" role="status">
        <Badge count={activeCount} size="small" offset={[-2, 2]}>
          <CloudUploadOutlined style={{ fontSize: 16, color: allDone ? '#52c41a' : '#1677ff' }} />
        </Badge>
        <span className="upload-panel-pill__text" onClick={expand} title="点击展开任务列表">
          {allDone ? `任务完成 ${summary}` : `任务 ${summary} · ${overallPct}%`}
          {overallSpeed > 0 && activeCount > 0 && <span className="upload-panel-pill__speed">{formatSize(overallSpeed)}/s</span>}
          {totalFailed > 0 && <span className="upload-panel-pill__fail">{totalFailed} 失败</span>}
          {pausedCount > 0 && <span className="upload-panel-pill__fail">{pausedCount} 暂停</span>}
        </span>
        {uploadActive > 0 ? (
          <Tooltip title="全部暂停（上传）">
            <Button size="small" type="text" icon={<PauseCircleOutlined />} onClick={handlePauseAll} />
          </Tooltip>
        ) : pausedCount > 0 ? (
          <Tooltip title="全部继续">
            <Button size="small" type="text" icon={<PlayCircleOutlined />} onClick={handleResumeAll} />
          </Tooltip>
        ) : totalDone > 0 ? (
          <Tooltip title="清除已完成任务">
            <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => clearCompleted()} />
          </Tooltip>
        ) : null}
        <Tooltip title="展开任务列表">
          <Button size="small" type="text" icon={<UpOutlined />} onClick={expand} />
        </Tooltip>
      </div>
    );
  }

  return (
    <div
      className="upload-float"
      style={{ left: Math.min(pos.x, Math.max(4, vw - 160)), top: pos.y }}
      role="dialog"
      aria-label="上传下载任务列表"
    >
      {body}
    </div>
  );
}
