// 简易算术验证码（防机器人注册/高频操作）：算式存 Redis（cluster 多 worker 共享）、一次性校验
// 离线部署无 reCAPTCHA 依赖，用算术题 + 短时效 + 限流组合防自动化
import crypto from 'node:crypto';
import { cacheSet, cacheGet, cacheDel } from './cache.js';

const TTL_SEC = 5 * 60;

export interface Captcha {
  id: string;
  question: string;
}

export async function generateCaptcha(): Promise<Captcha> {
  const a = crypto.randomInt(2, 20);
  const b = crypto.randomInt(2, 20);
  const op = crypto.randomInt(0, 3);
  let answer: number;
  let question: string;
  if (op === 0) {
    answer = a + b;
    question = `${a} + ${b} = ?`;
  } else if (op === 1) {
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    answer = hi - lo;
    question = `${hi} - ${lo} = ?`;
  } else {
    answer = a * b;
    question = `${a} × ${b} = ?`;
  }
  const id = crypto.randomUUID();
  // Redis 存储：cluster 多 worker 共享（进程内存无法跨 worker）
  await cacheSet(`captcha:${id}`, { answer }, TTL_SEC);
  return { id, question };
}

export async function verifyCaptcha(id: string, answerInput: unknown): Promise<boolean> {
  if (typeof answerInput !== 'number' || !Number.isFinite(answerInput)) return false;
  const item = await cacheGet<{ answer: number }>(`captcha:${id}`);
  if (!item) return false;
  await cacheDel(`captcha:${id}`); // 一次性
  return item.answer === Math.round(answerInput);
}
