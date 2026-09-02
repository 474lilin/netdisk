// =============================================================================
// 分段哈希缓存（内存 LRU，进程内版；接口可平滑替换为 Redis）
//
// 设计目的：让 BLAKE3 计算尽可能"从 RAM 读取"，绕过 MinIO 读取路径瓶颈
// （实测本环境 MinIO 读 ~100MB/s，远低于哈希本身的 GB/s 级吞吐）。
//
// 两级缓存：
//   1. 段数据缓存 segData: {bucket}/{key}#{segIdx} -> Uint8Array
//      对同一对象在同进程内的重复校验（如后台池校验与内联校验并发时，
//      互斥锁串行化后第二次读命中）直接命中 RAM。
//   2. 段哈希缓存 segHash: {org}/{sha256}#{segIdx} -> 64hex
//      按内容哈希寻址（与对象 key 无关）：completeUpload 校验上传对象时
//      计算出的各段 BLAKE3 被池注册校验复用——池校验无需再读 MinIO，
//      直接对段哈希拼接串做最后一次 BLAKE3（纯 RAM，GB/s）。
//
// 容量：段数据按字节预算（HASH_CACHE_MB，默认 512MB，LRU 逐出）；
//      段哈希为 32B/段，10GB 文件仅 40KB，无需预算（上限 100 万段）。
// =============================================================================

interface SegDataEntry {
  buf: Uint8Array;
  lastUsed: number;
}

interface SegHashEntry {
  hex: string;
  lastUsed: number;
}

class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // 触碰：删除后重插以维护 LRU 顺序
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      // 逐出最久未用（Map 迭代序 = 插入序）
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

// ---------- 配置 ----------
function cacheBudgetMB(): number {
  const v = Number(process.env.HASH_CACHE_MB);
  return Number.isFinite(v) && v > 0 ? v : 512;
}

const segDataLimit = Math.floor((cacheBudgetMB() * 1024 * 1024) / (8 * 1024 * 1024)) + 1; // 条目上限（按 8MB 段估算）
const segData = new LRUCache<string, SegDataEntry>(segDataLimit);
const segHash = new LRUCache<string, SegHashEntry>(1_000_000);

export function segDataKey(bucket: string, key: string, segIdx: number): string {
  return `${bucket}/${key}#${segIdx}`;
}

export function segHashKey(orgId: string, sha256: string, segIdx: number): string {
  return `${orgId}/${sha256}#${segIdx}`;
}

// ---------- 段数据缓存（MinIO 读取结果复用） ----------
export function getSegData(bucket: string, key: string, segIdx: number): Uint8Array | undefined {
  const e = segData.get(segDataKey(bucket, key, segIdx));
  return e ? e.buf : undefined;
}

export function setSegData(bucket: string, key: string, segIdx: number, buf: Uint8Array): void {
  const k = segDataKey(bucket, key, segIdx);
  const existing = segData.get(k);
  if (existing && existing.buf.length === buf.length) {
    existing.lastUsed = Date.now();
    return;
  }
  segData.set(k, { buf, lastUsed: Date.now() });
}

// ---------- 段哈希缓存（按内容寻址，池校验免读） ----------
export function getSegHash(orgId: string, sha256: string, segIdx: number): string | undefined {
  const e = segHash.get(segHashKey(orgId, sha256, segIdx));
  return e ? e.hex : undefined;
}

export function setSegHash(orgId: string, sha256: string, segIdx: number, hex: string): void {
  segHash.set(segHashKey(orgId, sha256, segIdx), { hex, lastUsed: Date.now() });
}

/** 命中全部段哈希时返回数组，供调用方纯 RAM 组合 B3SEG；未全命中返回 null */
export function getAllSegHashes(orgId: string, sha256: string, size: number, segmentSize: number): string[] | null {
  const segmentCount = Math.ceil(size / segmentSize);
  const hexes: string[] = new Array(segmentCount);
  for (let i = 0; i < segmentCount; i++) {
    const h = getSegHash(orgId, sha256, i);
    if (!h) return null;
    hexes[i] = h;
  }
  return hexes;
}

/** 统计（观测用） */
export function cacheStats(): { segData: number; segHash: number; budgetMB: number } {
  return { segData: segData.size, segHash: segHash.size, budgetMB: cacheBudgetMB() };
}
