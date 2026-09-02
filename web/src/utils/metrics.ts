// 前端埋点（v1.0.13）：上传中断原因上报
// 轻量实现：localStorage 持久化计数（离线可观测）；后续可替换为 navigator.sendBeacon 到采集端点
// 埋点字段：interrupt_reason = token_expired | network | server | timeout | aborted

const KEY = 'nd_upload_interrupts';

interface InterruptRecord {
  reason: string;
  count: number;
  lastTs: number;
}

export function reportUploadInterrupt(reason: string): void {
  try {
    const raw = localStorage.getItem(KEY);
    const map = (raw ? JSON.parse(raw) : {}) as Record<string, InterruptRecord>;
    const rec = map[reason] ?? { reason, count: 0, lastTs: 0 };
    rec.count += 1;
    rec.lastTs = Date.now();
    map[reason] = rec;
    // 保留最近 200 条原因统计，防止无限膨胀
    const keys = Object.keys(map);
    if (keys.length > 200) {
      const sorted = keys.sort((a, b) => (map[a].lastTs - map[b].lastTs));
      delete map[sorted[0]];
    }
    localStorage.setItem(KEY, JSON.stringify(map));
    // 调试可见
    console.warn(`[upload-interrupt] reason=${reason} total=${rec.count}`);
  } catch {
    /* localStorage 不可用则忽略 */
  }
}

/** 读取累计中断统计（可观测性/调试） */
export function getUploadInterrupts(): Record<string, InterruptRecord> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, InterruptRecord>;
  } catch {
    return {};
  }
}
