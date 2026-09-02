// 本地开发用：将 deploy/postgres/init/01-schema.sql 应用到 DATABASE_URL
// 用法: cd server && npm run db:init
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, '../../deploy/postgres/init/01-schema.sql');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少环境变量 DATABASE_URL，示例:');
  console.error('  DATABASE_URL=postgres://netdisk:pass@127.0.0.1:5432/netdisk npm run db:init');
  process.exit(1);
}

const sql = await readFile(schemaPath, 'utf8');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(sql);
  console.log('[db:init] schema applied OK');
} catch (err) {
  console.error('[db:init] failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
