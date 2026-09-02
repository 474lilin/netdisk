// BLAKE3 分片哈希 Web Worker（并行计算）
/// <reference lib="webworker" />
import { createBLAKE3 } from 'hash-wasm';

let hasherP: Promise<Awaited<ReturnType<typeof createBLAKE3>>> | null = null;
function getHasher(): Promise<Awaited<ReturnType<typeof createBLAKE3>>> {
  if (!hasherP) hasherP = createBLAKE3();
  return hasherP;
}

self.onmessage = async (e: MessageEvent<{ id: number; buf: ArrayBuffer }>) => {
  const { id, buf } = e.data;
  try {
    const h = await getHasher();
    h.init();
    h.update(new Uint8Array(buf));
    (self as unknown as Worker).postMessage({ id, hex: h.digest('hex') });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message });
  }
};
