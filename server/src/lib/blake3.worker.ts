// BLAKE3 哈希 worker_threads（分片并行计算）
import { parentPort } from 'node:worker_threads';
import { createBLAKE3 } from 'hash-wasm';

let hasher: Awaited<ReturnType<typeof createBLAKE3>> | null = null;

async function ensureHasher(): Promise<Awaited<ReturnType<typeof createBLAKE3>>> {
  if (!hasher) hasher = await createBLAKE3();
  return hasher;
}

if (parentPort) {
  // 就绪信号（等待 wasm 加载完成）
  void ensureHasher().then(() => parentPort!.postMessage({ ready: true }));

  parentPort.on('message', async (msg: { id: number; buf: Uint8Array }) => {
    const h = await ensureHasher();
    h.init();
    h.update(msg.buf);
    parentPort!.postMessage({ id: msg.id, hex: h.digest('hex') });
  });
}
