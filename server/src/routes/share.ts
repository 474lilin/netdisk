// 分享路由：我的分享管理（需登录+CSRF） + 公开 token 访问（内网链接，免 CSRF）
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  createShare,
  downloadShare,
  getShareMeta,
  listMyShares,
  listShareDir,
  revokeShare,
} from '../services/share.service.js';

// ---------- 公开访问（凭 token，无需登录/CSRF；私有化内网链接） ----------
export const publicShareRouter: Router = Router();

publicShareRouter.get(
  '/:token/meta',
  asyncHandler(async (req, res) => {
    const { token } = req.params as { token: string };
    res.json(await getShareMeta(token));
  })
);

publicShareRouter.post(
  '/:token/verify',
  validateBody(z.object({ password: z.string().max(64).optional() })),
  asyncHandler(async (req, res) => {
    const { token } = req.params as { token: string };
    const meta = await getShareMeta(token);
    res.json({ ok: meta.valid, meta });
  })
);

publicShareRouter.post(
  '/:token/download',
  validateBody(z.object({ password: z.string().max(64).optional(), fileId: z.string().uuid().optional() })),
  asyncHandler(async (req, res) => {
    const { token } = req.params as { token: string };
    const { password, fileId } = req.body as { password?: string; fileId?: string };
    const result = await downloadShare(token, password, fileId);
    await writeAudit(req, { action: 'share_download', targetType: 'share', targetId: token, detail: { name: result.name } });
    res.json(result);
  })
);

publicShareRouter.get(
  '/:token/list',
  asyncHandler(async (req, res) => {
    const { token } = req.params as { token: string };
    const dirId = typeof req.query.dirId === 'string' ? req.query.dirId : undefined;
    const password = typeof req.query.password === 'string' ? req.query.password : undefined;
    res.json(await listShareDir(token, password, dirId));
  })
);

// ---------- 已登录：分享管理（/links，需要 CSRF） ----------
const router = Router();
router.use(requireAuth);

router.get(
  '/links',
  asyncHandler(async (req, res) => {
    res.json({ items: await listMyShares(req.user!) });
  })
);

router.post(
  '/links',
  validateBody(
    z.object({
      fileId: z.string().uuid().optional(),
      dirId: z.string().uuid().optional(),
      password: z.string().max(64).optional(),
      expiresAt: z.string().datetime().nullable().optional(),
      maxAccessCount: z.number().int().min(0).optional(),
      allowDownload: z.boolean().optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const share = await createShare(req.user!, req.body as never);
    await writeAudit(req, {
      action: 'share_create',
      targetType: share.isDir ? 'dir' : 'file',
      targetId: share.token,
      detail: { name: share.targetName, hasPassword: share.hasPassword, expiresAt: share.expiresAt },
    });
    res.json(share);
  })
);

router.delete(
  '/links/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    await revokeShare(req.user!, id);
    await writeAudit(req, { action: 'share_revoke', targetType: 'share', targetId: id });
    res.json({ ok: true });
  })
);

export default router;
