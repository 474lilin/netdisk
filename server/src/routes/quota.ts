// 配额路由：个人用量查询 + 管理员设置（企业/部门/用户）
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { getUserQuotaInfo, setDeptQuota, setOrgQuota, setUserQuota } from '../services/quota.service.js';
import { quotaSummaryByDept } from '../services/trash.service.js';

const router = Router();
router.use(requireAuth);

// 我的用量
router.get(
  '/usage',
  asyncHandler(async (req, res) => {
    res.json(await getUserQuotaInfo(req.user!.id));
  })
);

// 管理员：部门用量汇总
router.get(
  '/departments',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json({ items: await quotaSummaryByDept(req.user!.orgId) });
  })
);

// 管理员：设置用户配额
router.put(
  '/user/:id',
  requireAdmin,
  validateBody(z.object({ quotaBytes: z.number().int().min(0) })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    const { quotaBytes } = req.body as { quotaBytes: number };
    await setUserQuota(id, quotaBytes);
    await writeAudit(req, { action: 'quota_update', targetType: 'user', targetId: id, detail: { quotaBytes } });
    res.json({ ok: true });
  })
);

// 管理员：设置部门配额
router.put(
  '/dept/:id',
  requireAdmin,
  validateBody(z.object({ quotaBytes: z.number().int().min(0) })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    const { quotaBytes } = req.body as { quotaBytes: number };
    await setDeptQuota(id, quotaBytes);
    await writeAudit(req, { action: 'quota_update', targetType: 'dept', targetId: id, detail: { quotaBytes } });
    res.json({ ok: true });
  })
);

// 管理员：设置企业配额
router.put(
  '/org',
  requireAdmin,
  validateBody(z.object({ quotaBytes: z.number().int().min(0) })),
  asyncHandler(async (req, res) => {
    const { quotaBytes } = req.body as { quotaBytes: number };
    await setOrgQuota(req.user!.orgId, quotaBytes);
    await writeAudit(req, { action: 'quota_update', targetType: 'org', targetId: req.user!.orgId, detail: { quotaBytes } });
    res.json({ ok: true });
  })
);

export default router;
