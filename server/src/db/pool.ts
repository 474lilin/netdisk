// PostgreSQL 连接池
import pg from 'pg';
import cluster from 'node:cluster';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

if (!config.databaseUrl) {
  throw new Error('未配置 DATABASE_URL（本地开发请设置 server/.env）');
}

// cluster 多进程：每 worker 均分连接池（总连接 ≈ pgPoolMax，避免超 PG max_connections）
const perWorkerMax =
  cluster.isWorker && config.webConcurrency > 1
    ? Math.max(5, Math.floor(config.pgPoolMax / config.webConcurrency))
    : config.pgPoolMax;

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: perWorkerMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'minio-netdisk-server',
});

pool.on('error', (err) => {
  logger.error('pg pool error', { message: err.message });
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<T | null> {
  const r = await query<T>(text, params);
  return r.rows[0] ?? null;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function pingDb(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
