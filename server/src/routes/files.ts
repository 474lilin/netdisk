// 文件路由：浏览 / 上传(单请求·分片) / 下载 / 预览 / 版本 / 回收站 / 移动复制 / ACL / 授权
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  abortUpload,
  addGrant,
  completeUpload,
  copyItems,
  deleteToTrash,
  getBreadcrumb,
  getDownloadUrl,
  getPreviewUrl,
  initUpload,
  listAcls,
  listDir,
  listGrants,
  listTrash,
  listVersions,
  mkdir,
  streamDirZip,
  moveItems,
  presignUploadParts,
  purgeItems,
  emptyTrash,
  removeAcl,
  removeGrant,
  renameItem,
  reportUploadedParts,
  getUploadedParts,
  restoreItems,
  rollbackVersion,
  upsertAcl,
  type TargetRef,
} from '../services/file.service.js';
import { config } from '../config/index.js';

const router = Router();
router.use(requireAuth);

const targetRefSchema = z.object({ type: z.enum(['file', 'dir']), id: z.string().uuid() });
const targetRefsBody = z.object({ targets: z.array(targetRefSchema).min(1).max(100) });
// purge（彻底删除/清空回收站）批量上限 1000：配合服务端批量删对象/删行，减少清空回收站的请求次数
const purgeRefsBody = z.object({ targets: z.array(targetRefSchema).min(1).max(1000) });

function parseTargets(body: unknown): TargetRef[] {
  return (body as { targets: TargetRef[] }).targets;
}

// ---------- 浏览 ----------

router.get(
  '/',
  validateQuery(
    z.object({
      dirId: z.string().uuid(),
      offset: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { dirId, offset, limit } = req.query as unknown as { dirId: string; offset?: number; limit?: number };
    res.json(await listDir(req.user!, dirId, { offset, limit }));
  })
);

router.get(
  '/breadcrumb',
  validateQuery(z.object({ dirId: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    const { dirId } = req.query as { dirId: string };
    res.json({ items: await getBreadcrumb(req.user!, dirId) });
  })
);

router.get(
  '/trash',
  asyncHandler(async (req, res) => {
    // 分页参数（offset/limit，默认 2000 兼容旧调用；清空回收站按页循环拉取）
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 2000));
    const { items, total } = await listTrash(req.user!, { offset, limit });
    res.json({ items, total, retentionDays: config.trashRetentionDays });
  })
);

// 清空回收站（高性能专用接口）：服务端一次拉取全部回收站项并批量删除
router.post(
  '/trash/empty',
  asyncHandler(async (req, res) => {
    const count = await emptyTrash(req.user!);
    await writeAudit(req, { action: 'purge', detail: { targets: [{ type: 'dir', id: 'trash-empty' }], count } });
    res.json({ ok: true, count });
  })
);

// ---------- 目录/文件操作 ----------

router.post(
  '/mkdir',
  validateBody(z.object({ parentId: z.string().uuid(), name: z.string().min(1).max(255) })),
  asyncHandler(async (req, res) => {
    const { parentId, name } = req.body as { parentId: string; name: string };
    const dto = await mkdir(req.user!, parentId, name);
    await writeAudit(req, { action: 'mkdir', targetType: 'dir', targetId: dto.id, detail: { name, parentId } });
    res.json(dto);
  })
);

router.post(
  '/rename',
  validateBody(z.object({ id: z.string().uuid(), type: z.enum(['file', 'dir']), name: z.string().min(1).max(255) })),
  asyncHandler(async (req, res) => {
    const { id, type, name } = req.body as { id: string; type: 'file' | 'dir'; name: string };
    await renameItem(req.user!, id, type, name);
    await writeAudit(req, { action: 'rename', targetType: type, targetId: id, detail: { name } });
    res.json({ ok: true });
  })
);

router.post(
  '/move',
  validateBody(targetRefsBody.extend({ targetDirId: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    const { targetDirId } = req.body as { targetDirId: string };
    await moveItems(req.user!, parseTargets(req.body), targetDirId);
    await writeAudit(req, { action: 'move', detail: { targets: parseTargets(req.body), targetDirId } });
    res.json({ ok: true });
  })
);

router.post(
  '/copy',
  validateBody(targetRefsBody.extend({ targetDirId: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    const { targetDirId } = req.body as { targetDirId: string };
    await copyItems(req.user!, parseTargets(req.body), targetDirId);
    await writeAudit(req, { action: 'copy', detail: { targets: parseTargets(req.body), targetDirId } });
    res.json({ ok: true });
  })
);

// ---------- 回收站 ----------

router.post(
  '/delete',
  validateBody(targetRefsBody),
  asyncHandler(async (req, res) => {
    const count = await deleteToTrash(req.user!, parseTargets(req.body));
    await writeAudit(req, { action: 'delete', detail: { targets: parseTargets(req.body), count } });
    res.json({ ok: true, count });
  })
);

router.post(
  '/restore',
  validateBody(targetRefsBody),
  asyncHandler(async (req, res) => {
    const count = await restoreItems(req.user!, parseTargets(req.body));
    await writeAudit(req, { action: 'restore', detail: { targets: parseTargets(req.body), count } });
    res.json({ ok: true, count });
  })
);

router.post(
  '/purge',
  validateBody(purgeRefsBody),
  asyncHandler(async (req, res) => {
    const count = await purgeItems(req.user!, parseTargets(req.body));
    await writeAudit(req, { action: 'purge', detail: { targets: parseTargets(req.body), count } });
    res.json({ ok: true, count });
  })
);

// ---------- 上传 ----------

router.post(
  '/upload/init',
  validateBody(
    z.object({
      dirId: z.string().uuid(),
      name: z.string().min(1).max(255),
      size: z.number().int().min(0),
      // 内容哈希（64 位十六进制，当前实现为 BLAKE3/B3SEG）；sha256 为兼容旧客户端别名
      hash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      mimeType: z.string().max(255).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const body = req.body as { dirId: string; name: string; size: number; hash?: string; sha256?: string; mimeType?: string };
    const input = { ...body, sha256: body.hash || body.sha256 };
    const result = await initUpload(req.user!, input);
    await writeAudit(req, {
      action: 'upload_init',
      detail: { name: input.name, size: input.size, dirId: input.dirId, dedup: result.dedup, mode: result.session?.mode },
    });
    res.json(result);
  })
);

router.post(
  '/upload/presign-parts',
  validateBody(z.object({ sessionId: z.string().uuid(), partNumbers: z.array(z.number().int().min(1).max(10000)).min(1).max(2000) })),
  asyncHandler(async (req, res) => {
    const { sessionId, partNumbers } = req.body as { sessionId: string; partNumbers: number[] };
    res.json({ parts: await presignUploadParts(req.user!, sessionId, partNumbers) });
  })
);

// 断点续传：上报已上传分片号（服务端登记 uploaded_parts）
router.post(
  '/upload/parts-report',
  validateBody(z.object({ sessionId: z.string().uuid(), partNumbers: z.array(z.number().int().min(1).max(10000)).min(1).max(100000) })),
  asyncHandler(async (req, res) => {
    const { sessionId, partNumbers } = req.body as { sessionId: string; partNumbers: number[] };
    res.json(await reportUploadedParts(req.user!, sessionId, partNumbers));
  })
);

// 断点续传：查询已上传分片号（跨设备/清 localStorage 后恢复）
router.get(
  '/upload/parts',
  validateQuery(z.object({ sessionId: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    const sessionId = req.query.sessionId as string;
    res.json(await getUploadedParts(req.user!, sessionId));
  })
);

router.post(
  '/upload/complete',
  validateBody(
    z.object({
      sessionId: z.string().uuid(),
      parts: z.array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1) })).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { sessionId, parts } = req.body as { sessionId: string; parts?: Array<{ partNumber: number; etag: string }> };
    const dto = await completeUpload(req.user!, sessionId, parts);
    await writeAudit(req, { action: 'upload_complete', targetType: 'file', targetId: dto.id, fileId: dto.id, detail: { name: dto.name, size: dto.size } });
    res.json(dto);
  })
);

router.post(
  '/upload/abort',
  validateBody(z.object({ sessionId: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    const { sessionId } = req.body as { sessionId: string };
    await abortUpload(req.user!, sessionId);
    res.json({ ok: true });
  })
);

// ---------- 下载 / 预览 ----------

router.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    const url = await getDownloadUrl(req.user!, id);
    await writeAudit(req, { action: 'download', targetType: 'file', targetId: id, fileId: id });
    res.json({ url });
  })
);

// 文件夹 zip 打包下载（流式）
router.get(
  '/:id/download-dir',
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    await streamDirZip(req.user!, id, res);
    await writeAudit(req, { action: 'download_dir', targetType: 'dir', targetId: id });
  })
);

router.get(
  '/:id/preview',
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    const result = await getPreviewUrl(req.user!, id);
    await writeAudit(req, { action: 'preview', targetType: 'file', targetId: id, fileId: id });
    res.json(result);
  })
);

// ---------- 版本 ----------

router.get(
  '/:id/versions',
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    res.json(await listVersions(req.user!, id));
  })
);

router.post(
  '/:id/versions/:versionId/rollback',
  asyncHandler(async (req, res) => {
    const { id, versionId } = req.params as { id: string; versionId: string };
    const file = await rollbackVersion(req.user!, id, versionId);
    await writeAudit(req, { action: 'version_rollback', targetType: 'file', targetId: id, fileId: id, detail: { versionId } });
    res.json(file);
  })
);

// ---------- 内部授权（share_grants） ----------

router.get(
  '/:id/grants',
  validateQuery(z.object({ type: z.enum(['file', 'dir']) })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    const { type } = req.query as { type: 'file' | 'dir' };
    res.json({ items: await listGrants(req.user!, id, type) });
  })
);

router.post(
  '/:id/grants',
  validateBody(
    z.object({
      type: z.enum(['file', 'dir']),
      targetType: z.number().int().min(1).max(3),
      targetId: z.string().uuid(),
      canWrite: z.boolean().optional(),
      canDelete: z.boolean().optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    const body = req.body as { type: 'file' | 'dir'; targetType: number; targetId: string; canWrite?: boolean; canDelete?: boolean };
    await addGrant(req.user!, {
      fileId: body.type === 'file' ? id : undefined,
      dirId: body.type === 'dir' ? id : undefined,
      targetType: body.targetType,
      targetId: body.targetId,
      canWrite: body.canWrite ?? false,
      canDelete: body.canDelete ?? false,
    });
    await writeAudit(req, { action: 'grant_add', targetType: body.type, targetId: id, detail: { targetType: body.targetType, targetId: body.targetId } });
    res.json({ ok: true });
  })
);

router.delete(
  '/grants/:grantId',
  asyncHandler(async (req, res) => {
    const { grantId } = req.params as { grantId: string };
    await removeGrant(req.user!, grantId);
    await writeAudit(req, { action: 'grant_remove', targetType: 'grant', targetId: grantId });
    res.json({ ok: true });
  })
);

// ---------- 目录 ACL ----------

router.get(
  '/:id/acl',
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    res.json({ items: await listAcls(req.user!, id) });
  })
);

router.post(
  '/:id/acl',
  validateBody(
    z.object({
      targetType: z.number().int().min(1).max(3),
      targetId: z.string().uuid(),
      canRead: z.boolean().optional(),
      canWrite: z.boolean().optional(),
      canDelete: z.boolean().optional(),
      canShare: z.boolean().optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    const body = req.body as { targetType: number; targetId: string; canRead?: boolean; canWrite?: boolean; canDelete?: boolean; canShare?: boolean };
    await upsertAcl(req.user!, {
      dirId: id,
      targetType: body.targetType,
      targetId: body.targetId,
      canRead: body.canRead ?? true,
      canWrite: body.canWrite ?? false,
      canDelete: body.canDelete ?? false,
      canShare: body.canShare ?? false,
    });
    await writeAudit(req, { action: 'acl_update', targetType: 'dir', targetId: id, detail: { targetType: body.targetType, targetId: body.targetId } });
    res.json({ ok: true });
  })
);

router.delete(
  '/acl/:aclId',
  asyncHandler(async (req, res) => {
    const { aclId } = req.params as { aclId: string };
    await removeAcl(req.user!, Number(aclId));
    await writeAudit(req, { action: 'acl_remove', targetType: 'acl', targetId: aclId });
    res.json({ ok: true });
  })
);

export default router;
