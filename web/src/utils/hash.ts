// BLAKE3 内容哈希（B3SEG 并行方案）——与服务端 lib/blake3.ts 完全一致
//   fileHash(file) = BLAKE3( BLAKE3(seg0) || BLAKE3(seg1) || ... )
// 多线程：分片经 Web Worker 池并行计算（内存占用 O(并发×8MB)）
/// <reference lib="webworker" />
import { createBLAKE3 } from 'hash-wasm';

export const HASH_SEGMENT_SIZE = 8 * 1024 * 1024; // 8MB，与服务端一致
export const HASH_ALGO = 'blake3-seg';

export function shouldComputeHash(size: number): boolean {
  return size > 0; // 去重不限大小（前端哈希支持秒传判断；小文件哈希开销已由预热+并发摊薄）
}

let singleHasherP: Promise<Awaited<ReturnType<typeof createBLAKE3>>> | null = null;
function getSingleHasher(): Promise<Awaited<ReturnType<typeof createBLAKE3>>> {
  if (!singleHasherP) singleHasherP = createBLAKE3();
  return singleHasherP;
}

/**
 * 预热 BLAKE3 哈希引擎（WASM 首次加载/编译较慢，~100-800ms）。
 * 页面加载后空闲时调用一次，避免首个文件上传/哈希时等待初始化。
 */
export function warmupHash(): void {
  void getSingleHasher().catch(() => {
    /* 初始化失败：下次使用时重试 */
    singleHasherP = null;
  });
}

async function hashBuffer(buf: Uint8Array): Promise<string> {
  const h = await getSingleHasher();
  h.init();
  h.update(buf);
  return h.digest('hex');
}

/** B3SEG 汇总：对分片哈希拼接串再算一次 BLAKE3 */
async function combine(hexes: string[]): Promise<string> {
  const parts = new Uint8Array(hexes.length * 32);
  hexes.forEach((hex, i) => {
    for (let j = 0; j < 32; j++) parts[i * 32 + j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16);
  });
  const h = await getSingleHasher();
  h.init();
  h.update(parts);
  return h.digest('hex');
}

// ---------- Web Worker 池（分片并行哈希） ----------

interface WorkerMsg {
  id: number;
  buf: ArrayBuffer;
}

let pool: Worker[] = [];
let poolConcurrency = 0;

function getPool(concurrency: number): Worker[] {
  if (pool.length !== concurrency) {
    pool.forEach((w) => w.terminate());
    pool = Array.from({ length: concurrency }, () => {
      const w = new Worker(new URL('./blake3.worker.ts', import.meta.url), { type: 'module' });
      return w;
    });
    poolConcurrency = concurrency;
  }
  return pool;
}

function hashViaWorker(worker: Worker, id: number, buf: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<{ id: number; hex: string }>): void => {
      if (e.data.id === id) {
        worker.removeEventListener('message', onMsg);
        worker.removeEventListener('error', onErr);
        resolve(e.data.hex);
      }
    };
    const onErr = (e: ErrorEvent): void => {
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
      reject(new Error(e.message || 'worker error'));
    };
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);
    worker.postMessage({ id, buf: buf.slice() }); // 安全克隆投递（不传输，避免数据损坏）
  });
}

/**
 * 流式 + 多线程计算文件 BLAKE3 内容哈希（B3SEG）
 * 内存占用 O(并发 × 8MB)；大文件（GB/TB 级）同样适用
 * onProgress: 按已哈希分片数回报进度（大文件哈希耗时，用于 UI 进度条）
 */
export async function fileHash(file: File, onProgress?: (segDone: number, segTotal: number) => void): Promise<string> {
  const total = file.size;
  if (total <= HASH_SEGMENT_SIZE) {
    onProgress?.(1, 1);
    const buf = new Uint8Array(await file.arrayBuffer());
    return combine([await hashBuffer(buf)]);
  }
  const segCount = Math.ceil(total / HASH_SEGMENT_SIZE);
  const hexes = new Array<string>(segCount);
  const concurrency = Math.min(4, navigator.hardwareConcurrency || 4);
  const workers = getPool(concurrency);
  let nextSeg = 0;
  let doneSeg = 0;

  await new Promise<void>((resolve, reject) => {
    const run = async (): Promise<void> => {
      while (true) {
        const seg = nextSeg++;
        if (seg >= segCount) return;
        const start = seg * HASH_SEGMENT_SIZE;
        const len = Math.min(HASH_SEGMENT_SIZE, total - start);
        const buf = new Uint8Array(await file.slice(start, start + len).arrayBuffer());
        hexes[seg] = await hashViaWorker(workers[seg % workers.length], seg, buf);
        doneSeg += 1;
        onProgress?.(doneSeg, segCount);
      }
    };
    Promise.all(Array.from({ length: concurrency }, () => run())).then(() => resolve(), reject);
  });
  return combine(hexes);
}
