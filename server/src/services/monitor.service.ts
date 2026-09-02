// =============================================================================
// 监控告警：Redis 内存 / 缓存命中率 / 定时清理任务执行状态
// - 采集：Redis INFO（内存、keyspace 命中率）+ scheduler 任务执行记录（monitor_job_runs）
// - 评估：runMonitorCheck 每 5 分钟跑一次，超阈值写 monitor_alerts（同 metric 去重，恢复自动关闭）
// - 暴露：/api/health 读内存缓存摘要（轻量）；/api/monitor/status 读完整状态（需登录）
// 告警通道（离线部署）：logger + DB + 状态端点；如需外部通知可在 upsertAlert 处扩展 webhook
// =============================================================================
import { query, queryOne } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { cacheInfo, type RedisMetrics } from '../lib/cache.js';
import { config } from '../config/index.js';
import { notifyAlerts, type AlertEvent } from '../lib/notify.js';

// 各定时任务期望执行间隔（小时）：超过该间隔无成功执行记录 -> 任务停滞告警
const DAILY_JOBS: Record<string, number> = {
  trash_purge: 26, // 每日 3:00 回收站清理
  quota_recompute: 26, // 每日 3:00 配额重算
  audit_purge: 26, // 每日 4:00 审计清理
  pool_gc: 26, // 每日 2:40 去重池 GC
  pool_resume: 26, // 每日 2:20 池校验恢复
  session_cleanup: 26, // 每日 2:30 孤儿上传会话
};
const HOURLY_JOBS: Record<string, number> = {
  share_cleanup: 2, // 每小时 过期分享
};
const JOB_MAX_GAP_HOURS: Record<string, number> = { ...DAILY_JOBS, ...HOURLY_JOBS };

export interface MonitorSnapshot {
  ts: string;
  redis: {
    available: boolean;
    usedBytes: number;
    maxBytes: number;
    memPct: number;
    hitRate: number | null;
    totalRequests: number;
  } | null;
  activeAlerts: number;
  staleJobs: string[];
}

let lastSnapshot: MonitorSnapshot | null = null;

// ---------- 任务执行记录（scheduler 调用） ----------

export async function recordJobRun(jobName: string, ok: boolean, detail: Record<string, unknown> = {}, durationMs = 0): Promise<void> {
  try {
    await query(
      `INSERT INTO monitor_job_runs (job_name, ok, started_at, finished_at, duration_ms, detail)
       VALUES ($1, $2, now() - ($3 * interval '1 millisecond'), now(), $3, $4)`,
      [jobName, ok, durationMs, JSON.stringify(detail)]
    );
    // 保留最近 2000 条/任务，防无限增长
    await query(
      `DELETE FROM monitor_job_runs
       WHERE id IN (SELECT id FROM monitor_job_runs WHERE job_name = $1 ORDER BY id DESC OFFSET 2000)`,
      [jobName]
    );
  } catch (err) {
    logger.warn('recordJobRun failed', { jobName, message: (err as Error).message });
  }
}

// ---------- 告警持久化（去重 + 恢复） ----------

/** 返回 true = 新告警（需要触发通知）；false = 已存在告警仅刷新 last_seen */
async function upsertAlert(level: 'warn' | 'critical', metric: string, message: string): Promise<boolean> {
  try {
    const existing = await queryOne('SELECT id FROM monitor_alerts WHERE metric = $1 AND active = TRUE', [metric]);
    if (existing) {
      await query(`UPDATE monitor_alerts SET last_seen = now(), message = $2 WHERE id = $1`, [existing.id, message]);
      return false;
    }
    await query(
      `INSERT INTO monitor_alerts (level, metric, message) VALUES ($1, $2, $3)`,
      [level, metric, message]
    );
    logger.warn('monitor alert raised', { level, metric, message });
    return true;
  } catch (err) {
    logger.warn('upsertAlert failed', { metric, message: (err as Error).message });
    return false;
  }
}

async function resolveAlert(metric: string): Promise<boolean> {
  try {
    const r = await query(
      `UPDATE monitor_alerts SET active = FALSE WHERE metric = $1 AND active = TRUE`,
      [metric]
    );
    if ((r.rowCount ?? 0) > 0) {
      logger.info('monitor alert resolved', { metric });
      return true;
    }
  } catch (err) {
    logger.warn('resolveAlert failed', { metric, message: (err as Error).message });
  }
  return false;
}

// ---------- 指标评估 ----------

export interface CheckResult {
  redisMemoryAlert: boolean;
  hitRateAlert: boolean;
  staleJobs: string[];
  resolved: number;
  raised: number;
}

export async function runMonitorCheck(): Promise<CheckResult> {
  const metrics = await cacheInfo();
  let redisMemoryAlert = false;
  let hitRateAlert = false;
  const staleJobs: string[] = [];
  let raised = 0;
  let resolved = 0;
  // 通知事件：新告警（raised）与恢复（resolved），检查结束后统一发送
  const events: AlertEvent[] = [];

  // 1) Redis 内存使用率
  if (metrics && metrics.maxMemoryBytes > 0) {
    const pct = metrics.memoryPct;
    if (pct >= config.monitorRedisMemPct) {
      redisMemoryAlert = true;
      const msg = `Redis 内存使用率 ${pct}% 超过阈值 ${config.monitorRedisMemPct}%（${Math.round(metrics.usedMemoryBytes / 1048576)}MB / ${Math.round(metrics.maxMemoryBytes / 1048576)}MB）`;
      if (await upsertAlert('critical', 'redis_memory', msg)) {
        events.push({ type: 'raised', level: 'critical', metric: 'redis_memory', message: msg });
      }
      raised += 1;
    } else if (await resolveAlert('redis_memory')) {
      resolved += 1;
      events.push({ type: 'resolved', level: 'critical', metric: 'redis_memory', message: 'Redis 内存使用率已恢复正常' });
    }
  }

  // 2) 缓存命中率（需足够流量采样，避免冷启动误报；采样量 = keyspace hits+misses）
  if (metrics && metrics.hitRate !== null) {
    const sample = metrics.keyspaceHits + metrics.keyspaceMisses;
    if (sample >= config.monitorHitRateMinSample) {
      const ratePct = Math.round(metrics.hitRate * 100);
      if (metrics.hitRate < config.monitorHitRateMin) {
        hitRateAlert = true;
        const msg = `缓存命中率 ${ratePct}% 低于阈值 ${Math.round(config.monitorHitRateMin * 100)}%（hits=${metrics.keyspaceHits}, misses=${metrics.keyspaceMisses}）`;
        if (await upsertAlert('warn', 'cache_hit_rate', msg)) {
          events.push({ type: 'raised', level: 'warn', metric: 'cache_hit_rate', message: msg });
        }
        raised += 1;
      } else if (await resolveAlert('cache_hit_rate')) {
        resolved += 1;
        events.push({ type: 'resolved', level: 'warn', metric: 'cache_hit_rate', message: '缓存命中率已恢复正常' });
      }
    }
  }

  // 3) 定时清理任务执行状态（最近成功执行时间是否超期）
  //    调度器存活判定：job 表有任意记录即认为调度器在跑（hourly 任务 2h 内必留痕）；
  //    整表为空才告警"scheduler 未运行"，避免每日任务未到点造成首次部署噪音
  const anyRun = await queryOne<{ c: string }>(`SELECT COUNT(*)::text AS c FROM monitor_job_runs`);
  const schedulerHasRuns = Number(anyRun?.c ?? 0) > 0;
  if (!schedulerHasRuns) {
    const msg = 'monitor_job_runs 无任何任务执行记录：调度器可能未启动或启动即崩溃';
    if (await upsertAlert('critical', 'scheduler_not_running', msg)) {
      events.push({ type: 'raised', level: 'critical', metric: 'scheduler_not_running', message: msg });
    }
    raised += 1;
  } else if (await resolveAlert('scheduler_not_running')) {
    resolved += 1;
    events.push({ type: 'resolved', level: 'critical', metric: 'scheduler_not_running', message: '调度器已恢复任务执行' });
  }

  for (const [job, maxGapHours] of Object.entries(JOB_MAX_GAP_HOURS)) {
    const metric = `job_stale:${job}`;
    if (!schedulerHasRuns) continue; // 已由 scheduler_not_running 覆盖
    const lastOk = await queryOne<{ finished_at: Date | null }>(
      `SELECT finished_at FROM monitor_job_runs WHERE job_name = $1 AND ok = TRUE ORDER BY id DESC LIMIT 1`,
      [job]
    );
    if (!lastOk?.finished_at) {
      // 无成功记录：若存在失败记录 -> 任务持续失败；否则该每日任务尚未到点，跳过不误报
      const lastFail = await queryOne<{ finished_at: Date | null }>(
        `SELECT finished_at FROM monitor_job_runs WHERE job_name = $1 AND ok = FALSE ORDER BY id DESC LIMIT 1`,
        [job]
      );
      if (lastFail?.finished_at) {
        staleJobs.push(job);
        const msg = `定时任务 ${job} 持续失败（最近一次失败于 ${lastFail.finished_at.toISOString()}），请检查日志`;
        if (await upsertAlert('critical', metric, msg)) {
          events.push({ type: 'raised', level: 'critical', metric, message: msg });
        }
        raised += 1;
      }
      continue;
    }
    const ageHours = (Date.now() - new Date(lastOk.finished_at).getTime()) / 3600_000;
    if (ageHours > maxGapHours) {
      staleJobs.push(job);
      const msg = `定时任务 ${job} 已 ${Math.round(ageHours)} 小时无成功执行（阈值 ${maxGapHours}h），调度器可能异常`;
      if (await upsertAlert('critical', metric, msg)) {
        events.push({ type: 'raised', level: 'critical', metric, message: msg });
      }
      raised += 1;
    } else if (await resolveAlert(metric)) {
      resolved += 1;
      events.push({ type: 'resolved', level: 'critical', metric, message: `定时任务 ${job} 已恢复正常执行` });
    }
  }

  // 发送通知（新告警 + 恢复；持续告警不重复通知）
  if (events.length > 0) {
    await notifyAlerts(events).catch((err) => logger.warn('notifyAlerts failed', { message: (err as Error).message }));
  }

  // 刷新快照（health 端点读取，避免高频 Redis 调用）
  const activeAlerts = await getActiveAlertCount();
  lastSnapshot = {
    ts: new Date().toISOString(),
    redis: metrics
      ? {
          available: true,
          usedBytes: metrics.usedMemoryBytes,
          maxBytes: metrics.maxMemoryBytes,
          memPct: metrics.memoryPct,
          hitRate: metrics.hitRate,
          totalRequests: metrics.keyspaceHits + metrics.keyspaceMisses,
        }
      : null,
    activeAlerts,
    staleJobs,
  };
  return { redisMemoryAlert, hitRateAlert, staleJobs, raised, resolved };
}

export async function getActiveAlertCount(): Promise<number> {
  try {
    const r = await queryOne<{ c: string }>(`SELECT COUNT(*)::text AS c FROM monitor_alerts WHERE active = TRUE`);
    return Number(r?.c ?? 0);
  } catch {
    return 0;
  }
}

/** 轻量快照（health 用，读内存缓存） */
export function getMonitorSnapshot(): MonitorSnapshot | null {
  return lastSnapshot;
}

/** 完整状态（monitor 端点用）：指标 + 最近任务执行 + 活动告警 */
export async function getMonitorStatus(): Promise<{
  snapshot: MonitorSnapshot | null;
  jobs: Array<{ job_name: string; ok: boolean; started_at: string; finished_at: string; duration_ms: number; detail: unknown }>;
  alerts: Array<{ level: string; metric: string; message: string; first_seen: string; last_seen: string }>;
}> {
  const jobs = await query<{ job_name: string; ok: boolean; started_at: Date; finished_at: Date; duration_ms: number; detail: unknown }>(
    `SELECT job_name, ok, started_at, finished_at, duration_ms, detail FROM monitor_job_runs ORDER BY id DESC LIMIT 30`
  );
  const alerts = await query<{ level: string; metric: string; message: string; first_seen: Date; last_seen: Date }>(
    `SELECT level, metric, message, first_seen, last_seen FROM monitor_alerts WHERE active = TRUE ORDER BY last_seen DESC`
  );
  return {
    snapshot: lastSnapshot,
    jobs: jobs.rows.map((r) => ({
      job_name: r.job_name,
      ok: r.ok,
      started_at: r.started_at.toISOString(),
      finished_at: r.finished_at.toISOString(),
      duration_ms: r.duration_ms,
      detail: r.detail,
    })),
    alerts: alerts.rows.map((r) => ({
      level: r.level,
      metric: r.metric,
      message: r.message,
      first_seen: r.first_seen.toISOString(),
      last_seen: r.last_seen.toISOString(),
    })),
  };
}
