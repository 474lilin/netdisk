// 审计日志：全部文件/权限/登录操作留痕（企业合规），写入 PostgreSQL
import type { Request } from 'express';
import { query } from '../db/pool.js';
import type { AuditLogRow } from '../types/index.js';

export interface AuditFields {
  action: string;
  targetType?: string;
  targetId?: string;
  fileId?: string;
  detail?: Record<string, unknown>;
}

export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
  return req.ip || '';
}

export async function writeAudit(req: Request, fields: AuditFields): Promise<void> {
  const user = (req as Request & { user?: { id: string; orgId: string } }).user;
  try {
    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, target_type, target_id, file_id, detail, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        user?.orgId ?? null,
        user?.id ?? null,
        fields.action,
        fields.targetType ?? '',
        fields.targetId ?? null,
        fields.fileId ?? null,
        JSON.stringify(fields.detail ?? {}),
        clientIp(req),
        String(req.headers['user-agent'] || '').slice(0, 512),
      ]
    );
  } catch (err) {
    // 审计失败不应阻断主流程，但记录日志
    // eslint-disable-next-line no-console
    console.error('[audit] write failed', err);
  }
}

export async function queryAudit(opts: {
  orgId: string;
  userId?: string;
  action?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}): Promise<{ items: AuditLogRow[]; total: number }> {
  const where: string[] = ['a.org_id = $1'];
  const params: unknown[] = [opts.orgId];
  if (opts.userId) {
    params.push(opts.userId);
    where.push(`a.user_id = $${params.length}`);
  }
  if (opts.action) {
    params.push(opts.action);
    where.push(`a.action = $${params.length}`);
  }
  if (opts.from) {
    params.push(opts.from);
    where.push(`a.created_at >= $${params.length}`);
  }
  if (opts.to) {
    params.push(opts.to);
    where.push(`a.created_at < ($${params.length})::timestamptz + interval '1 day'`);
  }
  const whereSql = where.join(' AND ');
  const offset = (opts.page - 1) * opts.pageSize;
  params.push(opts.pageSize, offset);

  const countRes = await query<{ total: string }>(`SELECT COUNT(*)::int AS total FROM audit_logs a WHERE ${whereSql}`, params.slice(0, -2));
  const itemsRes = await query<AuditLogRow>(
    `SELECT a.*, u.display_name AS user_name FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE ${whereSql}
     ORDER BY a.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: itemsRes.rows, total: Number(countRes.rows[0]?.total ?? 0) };
}
