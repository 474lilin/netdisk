// 监控状态：Redis 内存 / 缓存命中率 / 清理任务执行记录 / 活动告警（需登录）
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../lib/errors.js';
import { getMonitorStatus, getMonitorSnapshot } from '../services/monitor.service.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json(await getMonitorStatus());
  })
);

// 立即触发一次监控自检（运维用，手动评估告警）
router.post(
  '/check',
  asyncHandler(async (req, res) => {
    if (req.user!.role !== 1) {
      res.status(403).json({ code: 'FORBIDDEN', message: '仅管理员可手动触发监控检查' });
      return;
    }
    const { runMonitorCheck } = await import('../services/monitor.service.js');
    const r = await runMonitorCheck();
    res.json({ ...r, snapshot: getMonitorSnapshot() });
  })
);

export default router;
