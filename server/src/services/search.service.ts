// 文件搜索：基于 PostgreSQL 元数据检索（文件名/类型/创建人/时间），不依赖对象存储全文检索
import { query } from '../db/pool.js';
import type { AuthedUser } from '../middleware/auth.js';
import type { FileListItem, FileRow, Paginated } from '../types/index.js';
import { accessibleDirIds } from './permission.service.js';
import { fileToDto } from './file.service.js';

export interface SearchInput {
  q: string;
  type?: 'file' | 'dir';
  creatorId?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

export async function searchFiles(user: AuthedUser, input: SearchInput): Promise<Paginated<FileListItem>> {
  const dirIds = await accessibleDirIds(user);
  if (dirIds.length === 0) {
    return { items: [], total: 0, page: input.page, pageSize: input.pageSize };
  }

  const where: string[] = ['f.org_id = $1', 'f.dir_id = ANY($2)', 'f.is_deleted = FALSE'];
  const params: unknown[] = [user.orgId, dirIds];

  if (input.q) {
    params.push(`%${input.q}%`);
    where.push(`f.name ILIKE $${params.length}`);
  }
  if (input.creatorId) {
    params.push(input.creatorId);
    where.push(`f.owner_id = $${params.length}`);
  }
  if (input.from) {
    params.push(input.from);
    where.push(`f.created_at >= $${params.length}`);
  }
  if (input.to) {
    params.push(input.to);
    where.push(`f.created_at < ($${params.length})::timestamptz + interval '1 day'`);
  }

  const whereSql = where.join(' AND ');
  const count = await query<{ total: string }>(
    `SELECT COUNT(*)::int AS total FROM files f WHERE ${whereSql}`,
    params
  );
  const offset = (input.page - 1) * input.pageSize;
  params.push(input.pageSize, offset);
  const res = await query<FileRow & { owner_name?: string }>(
    `SELECT f.*, u.display_name AS owner_name FROM files f
     LEFT JOIN users u ON u.id = f.owner_id
     WHERE ${whereSql}
     ORDER BY f.updated_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const items: FileListItem[] = res.rows.map((f) => {
    const dto = fileToDto(f);
    dto.ownerName = f.owner_name ?? '';
    return dto;
  });
  return { items, total: Number(count.rows[0]?.total ?? 0), page: input.page, pageSize: input.pageSize };
}
