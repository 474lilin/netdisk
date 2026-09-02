// =============================================================================
// Redis 热点缓存封装（目录列表 / 分享元信息）
// - 容错：Redis 不可用/超时/异常时静默降级为"无缓存"（业务不受影响，直接落库）
// - 键规范：dir:{orgId}:{dirId} / share:{token} / ...
// - 配置：REDIS_ENABLED（默认 true）、REDIS_URL（默认 redis://redis:6379）
// =============================================================================
import { Redis } from 'ioredis';
import { logger } from './logger.js';

const enabled = process.env.REDIS_ENABLED !== 'false';
const url = process.env.REDIS_URL || 'redis://redis:6379';

let client: Redis | null = null;
let broken = false;

function getClient(): Redis | null {
  if (!enabled || broken) return null;
  if (client) return client;
  try {
    client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    });
    client.on('error', (e) => {
      // 连接失败/中断：标记降级，避免每次操作都抛错
      if (!broken) {
        broken = true;
        logger.warn('redis cache disabled (connection error)', { message: e.message });
      }
    });
    client.on('ready', () => {
      broken = false;
      logger.info('redis cache ready');
    });
    return client;
  } catch (e) {
    broken = true;
    logger.warn('redis cache init failed', { message: (e as Error).message });
    return null;
  }
}

/** 读缓存；未命中/异常返回 null */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const c = getClient();
  if (!c) return null;
  try {
    const raw = await c.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 写缓存（TTL 秒） */
export async function cacheSet(key: string, value: unknown, ttlSec: number): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.set(key, JSON.stringify(value), 'EX', ttlSec);
  } catch {
    /* 静默降级 */
  }
}

/** 删除缓存键 */
export async function cacheDel(...keys: string[]): Promise<void> {
  const c = getClient();
  if (!c || keys.length === 0) return;
  try {
    await c.del(...keys);
  } catch {
    /* 静默降级 */
  }
}

/** 按前缀删除（SCAN 匹配，如 dir:{org}:*） */
export async function cacheDelPrefix(prefix: string): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await c.scan(cursor, 'MATCH', prefix + '*', 'COUNT', 100);
      if (keys.length > 0) await c.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  } catch {
    /* 静默降级 */
  }
}

/** 缓存是否可用（观测用） */
export function cacheEnabled(): boolean {
  return enabled && !broken && !!client;
}

/** Redis 运行指标（监控用）：内存用量 + 命中率；Redis 不可用时返回 null（静默降级） */
export interface RedisMetrics {
  usedMemoryBytes: number;
  maxMemoryBytes: number;
  memoryPct: number; // 0-100
  keyspaceHits: number;
  keyspaceMisses: number;
  totalCommands: number;
  uptimeSeconds: number;
  hitRate: number | null; // 0-1；无足够流量时为 null
}

export async function cacheInfo(): Promise<RedisMetrics | null> {
  const c = getClient();
  if (!c) return null;
  try {
    const info = await c.info('stats');
    const mem = await c.info('memory');
    const stats: Record<string, string> = {};
    for (const line of info.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) stats[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    const memStats: Record<string, string> = {};
    for (const line of mem.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) memStats[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    const used = Number(memStats.used_memory ?? 0);
    const max = Number(memStats.maxmemory ?? 0);
    const hits = Number(stats.keyspace_hits ?? 0);
    const misses = Number(stats.keyspace_misses ?? 0);
    const total = hits + misses;
    return {
      usedMemoryBytes: used,
      maxMemoryBytes: max,
      memoryPct: max > 0 ? Math.round((used / max) * 10000) / 100 : 0,
      keyspaceHits: hits,
      keyspaceMisses: misses,
      totalCommands: Number(stats.total_commands_processed ?? 0),
      uptimeSeconds: Number(stats.uptime_in_seconds ?? 0),
      hitRate: total > 0 ? hits / total : null,
    };
  } catch {
    return null;
  }
}
