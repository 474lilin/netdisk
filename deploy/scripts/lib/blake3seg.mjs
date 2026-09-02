// =============================================================================
// B3SEG（BLAKE3 分段并行）参考实现 —— 供冒烟测试与内部工具使用
// 与 server/src/lib/blake3.ts、web/src/utils/hash.ts 算法完全一致：
//   fileHash = BLAKE3( BLAKE3(seg0) || BLAKE3(seg1) || ... )，seg 固定 8MB
// 依赖: hash-wasm（server/node_modules 已安装）
// =============================================================================
import { createBLAKE3 } from '../../../server/node_modules/hash-wasm/dist/index.esm.js';
import fs from 'node:fs';

export const HASH_SEGMENT_SIZE = 8 * 1024 * 1024;
export const HASH_ALGO = 'blake3-seg';

let hasherP = null;
async function getHasher() {
  if (!hasherP) hasherP = createBLAKE3();
  return hasherP;
}

async function hashBuf(buf) {
  const h = await getHasher();
  h.init();
  h.update(new Uint8Array(buf));
  return h.digest('hex');
}

async function combine(hexes) {
  const parts = new Uint8Array(hexes.length * 32);
  hexes.forEach((hex, i) => {
    for (let j = 0; j < 32; j++) parts[i * 32 + j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16);
  });
  const h = await getHasher();
  h.init();
  h.update(parts);
  return h.digest('hex');
}

/** 内存 Buffer 的 B3SEG 哈希 */
export async function blake3SegBuffer(buf) {
  const total = buf.length;
  const hexes = [];
  for (let off = 0; off < total; off += HASH_SEGMENT_SIZE) {
    hexes.push(await hashBuf(buf.subarray(off, Math.min(off + HASH_SEGMENT_SIZE, total))));
  }
  return combine(hexes);
}

/** 文件（磁盘）的 B3SEG 哈希，流式读取，内存 O(8MB) */
export async function blake3SegFile(filePath) {
  const size = fs.statSync(filePath).size;
  const hexes = [];
  const fd = fs.openSync(filePath, 'r');
  try {
    let off = 0;
    while (off < size) {
      const len = Math.min(HASH_SEGMENT_SIZE, size - off);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, off);
      hexes.push(await hashBuf(buf));
      off += len;
    }
  } finally {
    fs.closeSync(fd);
  }
  return combine(hexes);
}
