// 轻量结构化日志（生产 JSON，开发可读）
import { config } from '../config/index.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[config.isProd ? 'info' : 'debug'];

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < current) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const line = config.isProd ? JSON.stringify(entry) : `${entry.ts} [${level.toUpperCase()}] ${msg} ${fields ? JSON.stringify(fields) : ''}`;
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
