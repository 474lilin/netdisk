// 顶栏「上传任务」固定入口（v1.1.6）
// 目的：任务列表常驻——即使面板被收起/最小化，也能一眼看到进度/失败数并一键打开列表，
// 不会出现「点一下网盘界面，任务列表就找不到了」的情况。
// 性能：与上传面板一致，采用 1s 轮询快照（不订阅每任务进度更新，避免万级任务时高频重渲染）
import { useEffect, useState } from 'react';
import { Badge, Button, Tooltip } from 'antd';
import { CloudUploadOutlined } from '@ant-design/icons';
import { useUploadStore } from '../store/upload';
import { useIsMobile } from '../utils/useMediaQuery';

const ACTIVE_STATUS = new Set(['queued', 'hashing', 'uploading']);

interface Snapshot {
  total: number;
  active: number;
  paused: number;
  failed: number;
  done: number;
  pct: number;
}

function readSnapshot(): Snapshot {
  const tasks = Object.values(useUploadStore.getState().tasks);
  let active = 0;
  let paused = 0;
  let failed = 0;
  let done = 0;
  let totalSize = 0;
  let finishedSize = 0;
  for (const t of tasks) {
    const size = Math.max(t.size, 1);
    totalSize += size;
    if (ACTIVE_STATUS.has(t.status)) active += 1;
    else if (t.status === 'paused') paused += 1;
    else if (t.status === 'error') failed += 1;
    if (t.status === 'completed' || t.status === 'dedup') {
      done += 1;
      finishedSize += size;
    } else {
      finishedSize += (size * t.progress) / 100;
    }
  }
  return {
    total: tasks.length,
    active,
    paused,
    failed,
    done,
    pct: totalSize > 0 ? Math.round((finishedSize / totalSize) * 100) : 0,
  };
}

export default function UploadTaskButton() {
  const [snap, setSnap] = useState<Snapshot>(() => readSnapshot());
  const togglePanel = useUploadStore((s) => s.togglePanel);
  const isMobile = useIsMobile();

  useEffect(() => {
    const timer = setInterval(() => setSnap(readSnapshot()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (snap.total === 0) return null;

  const allDone = snap.active === 0 && snap.paused === 0 && snap.failed === 0 && snap.done > 0;
  const tip = snap.active > 0
    ? `上传任务：${snap.done}/${snap.total} 完成 · ${snap.pct}%${snap.failed ? ` · ${snap.failed} 失败` : ''}（点击展开/最小化）`
    : snap.paused > 0
      ? `上传任务：${snap.paused} 个已暂停（点击展开列表）`
      : snap.failed > 0
        ? `上传任务：${snap.failed} 个失败，可一键重试`
        : allDone
          ? `上传任务：全部完成（${snap.done}/${snap.total}），点击查看列表`
          : '上传任务';

  return (
    <Tooltip title={tip}>
      <Badge
        count={snap.active || snap.paused || snap.failed || 0}
        size="small"
        offset={[-4, 2]}
        color={snap.failed ? 'red' : undefined}
      >
        <Button size="small" type="text" icon={<CloudUploadOutlined />} onClick={() => togglePanel()}>
          {!isMobile && (snap.active > 0 ? `${snap.done}/${snap.total} · ${snap.pct}%` : '上传任务')}
        </Button>
      </Badge>
    </Tooltip>
  );
}
