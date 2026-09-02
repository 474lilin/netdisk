// B3SEG 哈希 worker（基准测试用，与服务端 blake3.worker.js 同构）
import { parentPort } from 'node:worker_threads';
import { createBLAKE3 } from '../../../server/node_modules/hash-wasm/dist/index.esm.js';

let hasher = null;
async function ensureHasher() {
  if (!hasher) hasher = await createBLAKE3();
  return hasher;
}

if (parentPort) {
  void ensureHasher().then(() => parentPort.postMessage({ ready: true }));
  parentPort.on('message', async (msg) => {
    const h = await ensureHasher();
    h.init();
    h.update(new Uint8Array(msg.buf));
    parentPort.postMessage({ id: msg.id, hex: h.digest('hex') });
  });
}
