// 搜索路由（元数据检索，PG 查询）
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import { searchFiles } from '../services/search.service.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  validateQuery(
    z.object({
      q: z.string().max(100),
      creatorId: z.string().uuid().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    })
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { q: string; creatorId?: string; from?: string; to?: string; page: number; pageSize: number };
    res.json(await searchFiles(req.user!, q));
  })
);

export default router;
