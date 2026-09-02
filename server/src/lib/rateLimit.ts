// 简易进程内滑动窗口限流（登录防爆破；生产多实例建议升级为 Redis）
import { ApiError } from './errors.js';

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  key: (ip: string, username?: string) => string;
}

export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max } = opts;
  return (req: { ip?: string; body?: { username?: string } }, _res: unknown, next: (err?: unknown) => void): void => {
    const ip = req.ip || 'unknown';
    const key = opts.key(ip, req.body?.username);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      buckets.set(key, bucket);
    }
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
    if (bucket.timestamps.length >= max) {
      next(ApiError.tooManyRequests());
      return;
    }
    bucket.timestamps.push(now);
    // 定期清理，防止内存膨胀
    if (buckets.size > 10000) {
      for (const [k, b] of buckets) {
        b.timestamps = b.timestamps.filter((t) => now - t < windowMs);
        if (b.timestamps.length === 0) buckets.delete(k);
      }
    }
    next();
  };
}
