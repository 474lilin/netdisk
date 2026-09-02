// 组织架构路由（企业管理员）
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  createDepartment,
  deleteDepartment,
  getCandidates,
  getOrgTree,
  getRoots,
  updateDepartment,
} from '../services/org.service.js';

const router = Router();

router.use(requireAuth);

// 侧边栏根目录（个人空间/部门盘/企业公共盘）
router.get(
  '/roots',
  asyncHandler(async (req, res) => {
    res.json({ roots: await getRoots(req.user!) });
  })
);

// 权限候选对象（用户/部门）
router.get(
  '/candidates',
  asyncHandler(async (req, res) => {
    res.json(await getCandidates(req.user!.orgId));
  })
);

// 组织树（部门 + 用户）
router.get(
  '/tree',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await getOrgTree(req.user!.orgId));
  })
);

router.post(
  '/departments',
  requireAdmin,
  validateBody(
    z.object({
      name: z.string().min(1).max(100),
      parentId: z.string().uuid().nullable().optional(),
      quotaBytes: z.number().int().min(0).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { name, parentId, quotaBytes } = req.body as { name: string; parentId?: string | null; quotaBytes?: number };
    const result = await createDepartment(req.user!.orgId, name, parentId ?? null, quotaBytes ?? 0, req.user!.id);
    await writeAudit(req, { action: 'dept_create', targetType: 'department', targetId: result.id, detail: { name } });
    res.json(result);
  })
);

router.put(
  '/departments/:id',
  requireAdmin,
  validateBody(
    z.object({
      name: z.string().min(1).max(100).optional(),
      quotaBytes: z.number().int().min(0).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    await updateDepartment(id, req.body as { name?: string; quotaBytes?: number });
    await writeAudit(req, { action: 'dept_update', targetType: 'department', targetId: id });
    res.json({ ok: true });
  })
);

router.delete(
  '/departments/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    await deleteDepartment(id);
    await writeAudit(req, { action: 'dept_delete', targetType: 'department', targetId: id });
    res.json({ ok: true });
  })
);

export default router;
