// 上传队列面板：进度（含哈希阶段）/ 实时速率 / 重试 / 清理
// 大任务量（万级文件）渲染裁剪：仅渲染进行中/失败/最近完成的最多 MAX_RENDER 条，避免卡死
import { useEffect, useMemo, useRef, useState } from 'react';
import { Drawer, List, Progress, Button, Tag, Space, Typography, notification, Alert } from 'antd';
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useUploadStore } from '../store/upload';
import { formatSize } from '../utils/format';
import { useIsMobile } from '../utils/useMediaQuery';

const MAX_RENDER = 200;

const STATUS_META: Record<string, { color: string; label: string }> = {
  queued: { color: 'default', label: '等待中' },
  hashing: { color: 'processing', label: '计算哈希' },
  uploading: { color: 'processing', label: '上传中' },
  completed: { color: 'success', label: '已完成' },
  dedup: { color: 'success', label: '秒传(去重)' },
  error: { color: 'error', label: '失败' },
  aborted: { color: 'warning', label: '已中止' },
  'auth-failed': { color: 'warning', label: '登录过期' },
};

export default function UploadQueue() {
  // 低频轮询（1s）：避免订阅每任务状态变化导致的高频重渲染（万级任务时每次 setState 都重渲染）
  const [snapshot, setSnapshot] = useState(() => {
    const s = useUploadStore.getState();
    return { tasks: Object.values(s.tasks), visible: s.visible, active: s._running };
  });
  const isMobile = useIsMobile();
  useEffect(() => {
    const timer = setInterval(() => {
      const s = useUploadStore.getState();
      setSnapshot((prev) => {
        const tasks = Object.values(s.tasks);
        if (tasks.length === prev.tasks.length && s.visible === prev.visible) {
          // 数量未变但进度在更新：仍需重渲染（进度条），直接更新引用
        }
        return { tasks, visible: s.visible, active: s._running };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  const { tasks, visible, active } = snapshot;
  const setVisible = useUploadStore((s) => s.setVisible);
  const removeTask = useUploadStore((s) => s.removeTask);
  const retryTask = useUploadStore((s) => s.retryTask);
  const clearCompleted = useUploadStore((s) => s.clearCompleted);
  const activeCount = active > 0 ? tasks.filter((t) => t.status === 'queued' || t.status === 'uploading' || t.status === 'hashing').length : 0;

  // 渲染裁剪：进行中/失败/登录过期优先，其次最近完成的；总量远超时显示提示
  const renderTasks = useMemo(() => {
    if (tasks.length <= MAX_RENDER) return tasks;
    const active = tasks.filter((t) => t.status === 'queued' || t.status === 'hashing' || t.status === 'uploading' || t.status === 'error' || t.status === 'auth-failed');
    if (active.length >= MAX_RENDER) return active.slice(0, MAX_RENDER);
    const rest = tasks.filter((t) => !active.includes(t)).slice(-(MAX_RENDER - active.length));
    return [...active, ...rest];
  }, [tasks]);
  const totalDone = tasks.filter((t) => t.status === 'completed' || t.status === 'dedup').length;
  const totalFailed = tasks.filter((t) => t.status === 'error').length;
  const totalAuthFailed = tasks.filter((t) => t.status === 'auth-failed').length;

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

  // 全部任务成功完成后自动收起（有失败项/登录过期时保留供用户处理）
  const allSettled = tasks.length > 0 && activeCount === 0 && totalAuthFailed === 0;
  const notifiedRef = useRef<string>('');
  useEffect(() => {
    if (!allSettled || !visible) return;
    const done = tasks.filter((t) => t.status === 'completed' || t.status === 'dedup').length;
    const failed = tasks.filter((t) => t.status === 'error').length;
    const hasFinished = done > 0;
    const hasError = failed > 0;
    // 汇总提示（每个批次只弹一次；避免重复渲染时多次通知）
    const signature = `${done}:${failed}:${tasks.length}`;
    if (notifiedRef.current !== signature) {
      notifiedRef.current = signature;
      if (hasFinished || hasError) {
        const title = hasError ? `上传完成：${done} 成功，${failed} 失败` : `上传完成：${done} 个文件`;
        notification[hasError ? 'warning' : 'success']({
          message: title,
          description: hasError ? '失败项已保留在队列中，可点击重试' : '文件已保存到当前目录',
          duration: 4,
        });
      }
    }
    if (!hasFinished || hasError) return;
    // 完整性校验 + 自动补传（全部任务成功结束后）：防偶发漏传，保证 100% 落库
    void useUploadStore.getState().verifyAndBackfill();
    const timer = setTimeout(() => useUploadStore.getState().setVisible(false), 2500);
    return () => clearTimeout(timer);
  }, [allSettled, visible, tasks]);

  return (
    <Drawer
      title={
        <Space>
          <CloudUploadOutlined /> 上传队列
          {activeCount > 0 && <Tag color="processing">{activeCount} 进行中</Tag>}
        </Space>
      }
      placement="right"
      width={isMobile ? '100%' : 420}
      open={visible}
      onClose={() => setVisible(false)}
      extra={
        <Button size="small" onClick={clearCompleted}>
          清除已完成
        </Button>
      }
    >
      <List
        className="upload-queue"
        dataSource={renderTasks}
        locale={{ emptyText: '暂无上传任务' }}
        renderItem={(t) => {
          const meta = STATUS_META[t.status];
          const done = t.status === 'completed' || t.status === 'dedup';
          const failed = t.status === 'error';
          const active = t.status === 'uploading' || t.status === 'hashing';
          const speed = speeds[t.id] ?? 0;
          return (
            <List.Item
              actions={[
                failed ? (
                  <Button key="retry" size="small" icon={<ReloadOutlined />} onClick={() => retryTask(t.id)}>
                    重试
                  </Button>
                ) : null,
                <Button key="rm" size="small" type="text" icon={<DeleteOutlined />} onClick={() => removeTask(t.id)} />,
              ].filter(Boolean) as React.ReactElement[]}
            >
              <div style={{ width: '100%' }}>
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Typography.Text ellipsis style={{ maxWidth: 200 }}>{t.fileName}</Typography.Text>
                  <Space size={4}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{formatSize(t.size)}</Typography.Text>
                    <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>
                      {t.status === 'dedup' ? <ThunderboltOutlined /> : done ? <CheckCircleOutlined /> : failed ? <CloseCircleOutlined /> : null} {meta.label}
                    </Tag>
                  </Space>
                </Space>
                {active ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Progress
                      percent={t.progress}
                      size="small"
                      status="active"
                      style={{ flex: 1, marginInlineEnd: 0 }}
                    />
                    {speed > 0 && (
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
      {tasks.length > MAX_RENDER && (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 8 }}
          message={`共 ${tasks.length} 个任务，仅显示部分（进行中/失败优先）`}
          description={`已完成 ${totalDone} · 失败 ${totalFailed}${totalAuthFailed ? ` · 登录过期 ${totalAuthFailed}` : ''} · 剩余 ${tasks.length - totalDone - totalFailed - totalAuthFailed}`}
        />
      )}
    </Drawer>
  );
}
