// 服务入口：cluster 多进程（主进程引导 + 定时任务；worker 进程 HTTP 服务）
// 压测实测：500 并发下单进程单核 CPU 饱和（255 RPS / P95 3.8s），cluster 多核可线性扩展吞吐
import cluster from 'node:cluster';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { pool, pingDb } from './db/pool.js';
import { ensureBootstrap } from './services/org.service.js';
import { resumePendingPoolVerifications } from './services/file.service.js';
import { pingMinio } from './lib/minio.js';
import { createApp } from './app.js';
import { startScheduler } from './scheduler/index.js';

const workerCount = config.webConcurrency;

/** 启动 HTTP worker（cluster worker 或单进程模式） */
async function runServer(): Promise<void> {
  if (!(await pingDb())) {
    throw new Error('PostgreSQL 连接失败，请检查 DATABASE_URL 与 postgres 服务状态');
  }
  if (!(await pingMinio())) {
    throw new Error('MinIO 连接或桶初始化失败，请检查 MINIO_* 配置与 minio-init 执行结果');
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`worker ${process.pid} listening on :${config.port}`);
  });

  const shutdown = (signal: string): void => {
    logger.info(`received ${signal}, shutting down (worker ${process.pid})`);
    server.close(() => {
      pool.end().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/** 主进程：引导 + 定时任务（单实例）+ 管理 worker */
async function runPrimary(): Promise<void> {
  // 1. 数据库连通性
  if (!(await pingDb())) {
    throw new Error('PostgreSQL 连接失败，请检查 DATABASE_URL 与 postgres 服务状态');
  }
  logger.info('database connected');

  // 2. MinIO 连通性（桶存在性检查）
  if (!(await pingMinio())) {
    throw new Error('MinIO 连接或桶初始化失败，请检查 MINIO_* 配置与 minio-init 执行结果');
  }
  logger.info('minio ready');

  // 3. 引导：默认企业 / 管理员 / 根目录（幂等）
  await ensureBootstrap();
  logger.info('bootstrap done');

  // 3.1 恢复未完成的去重池注册/校验（进程重启后继续）
  await resumePendingPoolVerifications().catch((err) =>
    logger.warn('resume pool verifications failed at startup', { message: (err as Error).message })
  );

  // 4. 定时任务（只在主进程执行，避免多 worker 重复触发）
  if (config.nodeEnv === 'production') {
    startScheduler();
  } else {
    logger.warn('dev 模式跳过定时任务（可手动调用）');
  }

  if (workerCount <= 1) {
    logger.info('单进程模式（WEB_CONCURRENCY=1）');
    await runServer();
    return;
  }

  // 5. 派生 worker（每 worker 独立 HTTP 监听共享端口，OS 负载均衡）
  logger.info(`cluster primary starting, forking ${workerCount} workers`);
  for (let i = 0; i < workerCount; i++) {
    cluster.fork();
  }
  cluster.on('exit', (worker, code, signal) => {
    logger.warn('worker exited, restarting', { pid: worker.process.pid, code, signal });
    cluster.fork(); // 崩溃自动拉起，保证服务可用性
  });

  // 主进程优雅退出：通知所有 worker 后结束
  const shutdown = (signal: string): void => {
    logger.info(`received ${signal}, shutting down cluster`);
    for (const id of Object.keys(cluster.workers ?? {})) {
      cluster.workers?.[id]?.kill('SIGTERM');
    }
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (cluster.isPrimary) {
  runPrimary().catch((err) => {
    logger.error('fatal startup error', { message: (err as Error).message, stack: (err as Error).stack });
    process.exit(1);
  });
} else {
  runServer().catch((err) => {
    logger.error('worker startup error', { message: (err as Error).message });
    process.exit(1);
  });
}
