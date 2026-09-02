// =============================================================================
// BLAKE3 内容哈希（B3SEG 并行方案）
//
// 方案说明（前后端必须完全一致）：
//   fileHash(file) = BLAKE3( BLAKE3(seg0) || BLAKE3(seg1) || ... )
//   - 每个分片 seg_i 为固定大小 HASH_SEGMENT_SIZE 的连续字节块（末片可能较短）
//   - 各分片 BLAKE3 由 worker_threads 多线程并行计算（服务端）/ Web Worker（浏览器端）
//   - 汇总：对"分片哈希拼接串"再算一次 BLAKE3，得到最终 64 位十六进制内容哈希
//   - 注意：该值为自定义分段树（保证确定性+可并行），不等于 b3sum 的标准整文件 BLAKE3
//
// 性能：单线程 ~365MB/s（hash-wasm wasm）；N 线程并行近线性加速（10GB 秒级）
// =============================================================================
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createBLAKE3, type IHasher } from 'hash-wasm';
import { getClient, bucket } from './minio.js';
import { logger } from './logger.js';
import { getSegData, setSegData, getAllSegHashes, setSegHash } from './segmentCache.js';

export const HASH_SEGMENT_SIZE = 8 * 1024 * 1024; // 8MB
export const HASH_ALGO = 'blake3-seg';

/** 并行哈希线程数（默认 CPU 核数减一，上限 8） */
export function hashWorkers(): number {
  return Math.min(Math.max(os.cpus().length - 1, 2), 8);
}

let singleHasher: Promise<IHasher> | null = null;
async function getSingleHasher(): Promise<IHasher> {
  if (!singleHasher) singleHasher = createBLAKE3();
  return singleHasher;
}

/** 单个缓冲区的 BLAKE3 十六进制 */
export async function hashBuffer(buf: Uint8Array): Promise<string> {
  const hasher = await getSingleHasher();
  hasher.init();
  hasher.update(buf);
  return hasher.digest('hex');
}

/** B3SEG 汇总：对分片哈希拼接串再算一次 BLAKE3 */
async function combineSegmentHashes(segmentHexes: string[]): Promise<string> {
  const concat = Buffer.concat(segmentHexes.map((h) => Buffer.from(h, 'hex')));
  const hasher = await getSingleHasher();
  hasher.init();
  hasher.update(new Uint8Array(concat));
  return hasher.digest('hex');
}

// ---------- 分片并行哈希（worker_threads 池） ----------

interface HashJob {
  id: number;
  buf: Uint8Array;
}
interface HashResult {
  id: number;
  hex: string;
}

const workerCount = hashWorkers();
const workers: Worker[] = [];
let workerReadyCount = 0;
let poolStarted = false;
let poolOk = false;
let poolBroken = false; // worker 死亡/出错后置 true：池永久不可用，此后一律主线程兜底
let poolReadyPromise: Promise<boolean> | null = null;

/** 初始化 worker 池；返回是否可用（就绪超时或异常时返回 false，调用方回退主线程哈希） */
function ensureWorkers(): Promise<boolean> {
  if (poolReadyPromise) return poolReadyPromise;
  if (poolStarted) return Promise.resolve(poolOk);
  poolStarted = true;

  poolReadyPromise = new Promise<boolean>((resolve) => {
    const workerFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'blake3.worker.js');
    const readyTimer = setTimeout(() => {
      // 就绪超时：放弃 worker，走主线程兜底
      logger.warn('blake3 worker pool ready timeout, fallback to main-thread hashing', { workerCount });
      poolOk = false;
      resolve(false);
    }, 10_000);

    const checkReady = (): void => {
      if (workerReadyCount >= workerCount) {
        clearTimeout(readyTimer);
        poolOk = true;
        resolve(true);
      }
    };

    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(workerFile);
      workers.push(w);
      w.on('message', (m: HashResult & { ready?: boolean }) => {
        if (m?.ready) {
          workerReadyCount++;
          checkReady();
        }
      });
      w.on('error', (e) => {
        logger.warn('blake3 worker error, fallback to main-thread hashing', { message: e.message });
        poolOk = false;
        poolBroken = true;
        resolve(false);
      });
      w.on('exit', (code) => {
        if (code !== 0) {
          logger.warn('blake3 worker exited, fallback to main-thread hashing', { code });
          poolOk = false;
          poolBroken = true;
          resolve(false);
        }
      });
      w.unref();
    }
  });
  return poolReadyPromise;
}

/** 主线程兜底：顺序哈希所有分片（正确性保证，单线程性能） */
async function hashSegmentsMainThread(bufs: Uint8Array[], outHexes?: string[]): Promise<string> {
  const hexes = new Array<string>(bufs.length);
  for (let i = 0; i < bufs.length; i++) {
    hexes[i] = await hashBuffer(bufs[i]);
    outHexes?.push(hexes[i]);
  }
  return combineSegmentHashes(hexes);
}

/**
 * 并行计算若干分片的 BLAKE3，返回 B3SEG 汇总哈希（含单分片路径，行为一致）
 * worker 不可用时自动回退主线程哈希
 */
export async function hashSegmentsParallel(bufs: Uint8Array[]): Promise<string> {
  return (await hashSegmentsDetailed(bufs)).final;
}

/**
 * 同 hashSegmentsParallel，但额外返回各分片的 BLAKE3（供段哈希缓存写入）
 */
export async function hashSegmentsDetailed(bufs: Uint8Array[]): Promise<{ final: string; segHexes: string[] }> {
  if (bufs.length === 0) {
    return { final: await hashBuffer(new Uint8Array(0)), segHexes: [] };
  }
  if (bufs.length === 1) {
    const h = await hashBuffer(bufs[0]);
    return { final: await combineSegmentHashes([h]), segHexes: [h] };
  }

  if (poolBroken) {
    const segHexes: string[] = [];
    return { final: await hashSegmentsMainThread(bufs, segHexes), segHexes };
  }
  const poolUsable = await ensureWorkers();
  if (!poolUsable || poolBroken) {
    const segHexes: string[] = [];
    return { final: await hashSegmentsMainThread(bufs, segHexes), segHexes };
  }
  // worker 池为共享模块级状态：并发调用会互相污染 results/pending 计数，故串行化池的使用；
  // 且每次调用挂载的监听器在结束后必须清理，避免长时间运行累积监听器（内存泄漏）
  return withPoolLock(() => runSegmentsOnPool(bufs));
}

// ---------- worker 池串行化（互斥锁） ----------
let poolQueue: Promise<void> = Promise.resolve();
function withPoolLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = poolQueue.then(fn);
  poolQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function runSegmentsOnPool(bufs: Uint8Array[]): Promise<{ final: string; segHexes: string[] }> {
  const results = new Array<string>(bufs.length);
  let next = 0;
  let pending = 0;
  let settled = false;

  return new Promise<{ final: string; segHexes: string[] }>((resolve, reject) => {
    // 本次调用挂载的监听器；结算（成功/失败）后必须清理，防止长时间运行累积泄漏
    const listeners: Array<{ w: Worker; type: 'message' | 'error' | 'exit'; fn: (...args: any[]) => void }> = [];
    const cleanup = (): void => {
      for (const { w, type, fn } of listeners) w.removeListener(type, fn);
    };
    const finish = (v: { final: string; segHexes: string[] }): void => { cleanup(); resolve(v); };
    const failOut = (e: unknown): void => { cleanup(); reject(e); };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      poolBroken = true; // worker 异常：池判废，后续调用直接主线程兜底
      // worker 异常：回退主线程
      const hexes: string[] = [];
      void hashSegmentsMainThread(bufs, hexes).then(
        (final) => finish({ final, segHexes: hexes }),
        failOut
      );
    };
    const tryFinish = (): void => {
      if (settled) return;
      if (pending !== 0 || next < bufs.length) return;
      settled = true;
      void combineSegmentHashes(results).then(
        (final) => finish({ final, segHexes: results.slice() }),
        failOut
      );
    };
    const dispatch = (): void => {
      while (pending < workers.length && next < bufs.length) {
        const id = next++;
        const worker = workers[pending];
        pending++;
        // 安全克隆后投递（不传输 ArrayBuffer，避免 Node Buffer 池导致的数据损坏/传输异常）
        const buf = new Uint8Array(bufs[id].length);
        buf.set(bufs[id]);
        worker.postMessage({ id, buf } as HashJob);
      }
    };
    for (const w of workers) {
      const onMsg = (m: HashResult): void => {
        if (m && typeof m.hex === 'string') {
          results[m.id] = m.hex;
          pending--;
          dispatch();
          tryFinish();
        }
      };
      const onError = (e: Error): void => fail(new Error(e.message || 'worker error'));
      const onExit = (code: number): void => {
        if (code !== 0) fail(new Error(`blake3 worker exited with code ${code}`));
      };
      w.on('message', onMsg);
      w.on('error', onError);
      w.on('exit', onExit);
      listeners.push(
        { w, type: 'message', fn: onMsg },
        { w, type: 'error', fn: onError },
        { w, type: 'exit', fn: onExit }
      );    }
    dispatch();
  });
}

// ---------- MinIO 对象并行哈希（分片 Range 读取 + 并行计算） ----------

async function readSegment(key: string, offset: number, length: number, segIdx: number): Promise<Uint8Array> {
  // 段数据缓存：同对象同进程内重复校验直接命中 RAM，绕过 MinIO 读取
  const cached = getSegData(bucket(), key, segIdx);
  if (cached) return cached;
  const stream = await getClient().getPartialObject(bucket(), key, offset, length);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const buf = new Uint8Array(Buffer.concat(chunks));
  setSegData(bucket(), key, segIdx, buf);
  return buf;
}

export interface ComputeHashOptions {
  /** 企业 ID：提供时启用段哈希缓存寻址（按内容哈希，与对象 key 无关） */
  orgId?: string;
  /** 期望的内容哈希（客户端声称值）：校验通过后写入段哈希缓存供复用 */
  expectedSha?: string;
}

/**
 * 并行计算 MinIO 对象的内容哈希（B3SEG）
 * @param key 对象 Key
 * @param size 对象字节数
 * @param opts 缓存选项（可选）：提供 orgId+expectedSha 时，若段哈希缓存全命中则纯 RAM 组合（GB/s）；
 *             计算通过后把各段 BLAKE3 写入缓存，后续对同内容（池拷贝等）校验免读 MinIO
 */
export async function computeObjectHash(key: string, size: number, opts?: ComputeHashOptions): Promise<string> {
  const { orgId, expectedSha } = opts || {};

  // 段哈希缓存命中：纯 RAM 组合（绕过 MinIO 读取路径瓶颈）
  if (orgId && expectedSha) {
    const cachedHexes = getAllSegHashes(orgId, expectedSha, size, HASH_SEGMENT_SIZE);
    if (cachedHexes) {
      const combined = await combineSegmentHashes(cachedHexes);
      if (combined === expectedSha) return combined;
      logger.warn('segHash cache mismatch, recompute', { key, size, expectedSha: expectedSha.slice(0, 12) });
    }
  }

  let finalHex: string;
  let segHexes: string[];
  if (size <= HASH_SEGMENT_SIZE) {
    const stream = await getClient().getObject(bucket(), key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const r = await hashSegmentsDetailed([new Uint8Array(Buffer.concat(chunks))]);
    finalHex = r.final;
    segHexes = r.segHexes;
  } else {
    const segmentCount = Math.ceil(size / HASH_SEGMENT_SIZE);
    const bufs: Uint8Array[] = new Array(segmentCount);
    let nextSeg = 0;
    // 读取并发：实测 4-8 路并发 Range 读 232-240 MB/s vs 单流 160 MB/s（容器内）。
    // 用 hashWorkers*2 提高吞吐（本机 4 核 -> 6 路），上限 8（>8 无增益，MinIO/磁盘饱和）
    const inFlight = Math.min(Math.max(hashWorkers() * 2, 4), 8);

    await new Promise<void>((resolve, reject) => {
      const runners = Array.from({ length: inFlight }, async () => {
        while (true) {
          const seg = nextSeg++;
          if (seg >= segmentCount) return;
          const offset = seg * HASH_SEGMENT_SIZE;
          const len = Math.min(HASH_SEGMENT_SIZE, size - offset);
          bufs[seg] = await readSegment(key, offset, len, seg);
        }
      });
      Promise.all(runners).then(() => resolve(), reject);
    });

    // 防御：填充可能缺失的分片（记录日志便于定位），防止哈希过程崩溃
    // 注意：不能用 bufs.map() —— map 会跳过稀疏数组的空洞，无法真正补洞；须用 Array.from
    const missing = bufs.filter((b) => !b).length;
    if (missing > 0) {
      logger.warn('computeObjectHash segments missing, filling empty', { key, size, segmentCount, missing });
    }
    const filled = Array.from(bufs, (b) => b ?? new Uint8Array(0));
    const t0 = Date.now();
    const r = await hashSegmentsDetailed(filled);
    finalHex = r.final;
    segHexes = r.segHexes;
    logger.debug('computeObjectHash', { key, size, segmentCount, workers: hashWorkers(), algo: HASH_ALGO, ms: Date.now() - t0 });
  }

  // 校验通过后写段哈希缓存：后续对同内容对象（如池拷贝）的校验直接纯 RAM 组合
  if (orgId && expectedSha && finalHex === expectedSha) {
    segHexes.forEach((hex, i) => setSegHash(orgId, expectedSha, i, hex));
    logger.debug('segHash cache written', { key, size, segCount: segHexes.length, expectedSha: expectedSha.slice(0, 12) });
  }
  return finalHex;
}
