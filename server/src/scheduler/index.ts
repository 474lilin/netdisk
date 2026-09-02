// 定时任务：回收站清理 / 过期分享清理 / 配额重算 / 审计日志清理 / 孤儿上传会话清理 / 去重池 GC / 监控自检
import cron from 'node-cron';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { cleanupExpiredShares } from '../services/share.service.js';
import { cleanupStaleUploadSessions, purgeExpiredAudit, purgeExpiredTrash } from '../services/trash.service.js';
import { recomputeQuota } from '../services/quota.service.js';
import { resumePendingPoolVerifications, gcOrphanPools } from '../services/file.service.js';
import { recordJobRun, runMonitorCheck } from '../services/monitor.service.js';
import { cleanupExpiredResetCodes } from '../services/password-reset.service.js';

/** 统一包装：执行任务 + 记录监控执行状态（成功/失败都记录，供任务停滞告警判定） */
async function runJob(jobName: string, fn: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  try {
    const result = await fn();
    await recordJobRun(jobName, true, result && typeof result === 'object' ? (result as Record<string, unknown>) : {}, Date.now() - started);
  } catch (err) {
    await recordJobRun(jobName, false, { error: (err as Error).message }, Date.now() - started);
    logger.error(`scheduler: ${jobName} failed`, { message: (err as Error).message });
  }
}

export function startScheduler(): void {
  // 每日恢复/推进未完成的去重池校验（兜底）
  cron.schedule('20 2 * * *', () => runJob('pool_resume', () => resumePendingPoolVerifications()));

  // 每日清理去重池孤儿记录（超过 POOL_GC_DAYS 且无引用的池 -> 回收存储）
  cron.schedule('40 2 * * *', () => runJob('pool_gc', () => gcOrphanPools()));

  // 每日凌晨 3 点清理超期回收站（TRASH_RETENTION_DAYS 天前放入回收站的文件/目录，
  // 逐个 MinIO 删除 + DB 硬删除 + 审计留痕；与配额重算同分钟，二者对 used_bytes 的
  // 写入在 READ COMMITTED 下互不阻塞，极端交叉由次日重算校正）
  cron.schedule('0 3 * * *', () => runJob('trash_purge', () => purgeExpiredTrash()));

  // 每小时清理过期分享链接
  cron.schedule('0 * * * *', () => runJob('share_cleanup', () => cleanupExpiredShares()));

  // 每日配额重算（兜底校正，cron 可配置）
  cron.schedule(config.quotaRecomputeCron, () => runJob('quota_recompute', () => recomputeQuota()));

  // 每日清理超期审计日志
  cron.schedule('0 4 * * *', () => runJob('audit_purge', () => purgeExpiredAudit()));

  // 每日清理孤儿上传会话
  cron.schedule('30 2 * * *', () => runJob('session_cleanup', () => cleanupStaleUploadSessions()));

  // 每小时清理过期的密码找回验证码（保留 7 天审计）
  cron.schedule('15 * * * *', () => runJob('reset_code_cleanup', () => cleanupExpiredResetCodes()));

  // 监控自检：Redis 内存 / 缓存命中率 / 清理任务执行状态（告警写 monitor_alerts）
  cron.schedule(config.monitorCheckCron, async () => {
    try {
      const r = await runMonitorCheck();
      if (r.raised > 0 || r.resolved > 0 || r.staleJobs.length > 0) {
        logger.info('monitor check', { raised: r.raised, resolved: r.resolved, staleJobs: r.staleJobs });
      }
    } catch (err) {
      logger.error('scheduler: monitor check failed', { message: (err as Error).message });
    }
  });

  logger.info('scheduler started');
}
