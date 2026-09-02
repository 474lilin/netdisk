// 用户管理路由（企业管理员）
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { createUser, deleteUser, listUsers, resetUserPassword, updateUser } from '../services/user.service.js';

const router = Router();

router.use(requireAuth, requireAdmin);

router.get(
  '/',
  validateQuery(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      q: z.string().max(100).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { page, pageSize, q } = req.query as unknown as { page: number; pageSize: number; q?: string };
    res.json(await listUsers(req.user!.orgId, { page, pageSize, q }));
  })
);

router.post(
  '/',
  validateBody(
    z.object({
      username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/, '登录名仅允许字母数字._-'),
      displayName: z.string().min(1).max(100),
      email: z.string().max(255).optional(),
      phone: z.string().max(32).optional(),
      role: z.number().int().min(1).max(3),
      deptId: z.string().uuid().nullable().optional(),
      quotaBytes: z.number().int().min(0).optional(),
      initialPassword: z.string().min(8).max(128).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const user = await createUser(req.user!.orgId, req.body as never, req.user!.id);
    await writeAudit(req, { action: 'user_create', targetType: 'user', targetId: user.id, detail: { username: user.username } });
    res.json({ id: user.id });
  })
);

router.put(
  '/:id',
  validateBody(
    z.object({
      displayName: z.string().min(1).max(100).optional(),
      email: z.string().max(255).optional(),
      phone: z.string().max(32).optional(),
      role: z.number().int().min(1).max(3).optional(),
      deptId: z.string().uuid().nullable().optional(),
      status: z.number().int().min(0).max(1).optional(),
      quotaBytes: z.number().int().min(0).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    await updateUser(req.user!.orgId, id, req.body as never, req.user!.id);
    await writeAudit(req, { action: 'user_update', targetType: 'user', targetId: id });
    res.json({ ok: true });
  })
);

router.post(
  '/:id/reset-password',
  validateBody(z.object({ newPassword: z.string().min(8).max(128) })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    const { newPassword } = req.body as { newPassword: string };
    await resetUserPassword(id, newPassword);
    await writeAudit(req, { action: 'user_reset_password', targetType: 'user', targetId: id });
    res.json({ ok: true });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    await deleteUser(req.user!.orgId, id, req.user!.id);
    await writeAudit(req, { action: 'user_delete', targetType: 'user', targetId: id });
    res.json({ ok: true });
  })
);

export default router;
