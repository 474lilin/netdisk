// 审计日志查询（企业管理员）
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import { queryAudit } from '../lib/audit.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get(
  '/',
  validateQuery(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      userId: z.string().uuid().optional(),
      action: z.string().max(64).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { page: number; pageSize: number; userId?: string; action?: string; from?: string; to?: string };
    res.json(await queryAudit({ orgId: req.user!.orgId, ...q }));
  })
);

export default router;
