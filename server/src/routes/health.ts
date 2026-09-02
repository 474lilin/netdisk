// 健康检查（docker compose 依赖此接口判断服务就绪）
// 扩展：附加监控摘要（Redis 内存 / 命中率 / 活动告警 / 停滞任务）——读内存缓存，无高频 Redis 调用
import { Router } from 'express';
import { pingDb } from '../db/pool.js';
import { pingMinio } from '../lib/minio.js';
import { getMonitorSnapshot } from '../services/monitor.service.js';

const router = Router();

router.get('/', async (_req, res) => {
  const [db, minio] = await Promise.all([pingDb(), pingMinio()]);
  const snap = getMonitorSnapshot();
  const redisAvailable = snap?.redis?.available ?? false;
  res.status(db && minio ? 200 : 503).json({
    ok: db && minio,
    db,
    minio,
    // 监控摘要（仅观测，不影响 ok 判定——Redis 断连时缓存静默降级，业务可用）
    monitor: snap
      ? {
          redis: redisAvailable
            ? {
                memPct: snap.redis!.memPct,
                usedMb: Math.round(snap.redis!.usedBytes / 1048576),
                maxMb: Math.round(snap.redis!.maxBytes / 1048576),
                hitRate: snap.redis!.hitRate !== null ? Math.round(snap.redis!.hitRate * 100) : null,
              }
            : null,
          activeAlerts: snap.activeAlerts,
          staleJobs: snap.staleJobs,
        }
      : null,
    ts: new Date().toISOString(),
  });
});

export default router;
