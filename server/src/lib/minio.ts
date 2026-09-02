// =============================================================================
// MinIO（S3 兼容）访问层：业务层的唯一入口，前端永远接触不到 bucket/密钥
// - internalClient: 容器内服务端操作（上传/拷贝/删除/列举）
// - publicClient:   仅用于签发浏览器可访问的临时签名 URL（指向公网端点）
// 对象 Key 规约：{orgId}/{fileId}（当前版本由 MinIO 版本控制维护）
//                {orgId}/_dedup/{sha256}（去重池）
// 说明：minio-js v8 的 listParts 为 protected，分片 ETag 由客户端在
//       PUT 响应头获取后随 complete 请求回传（MinIO 侧会校验 ETag 一致性）。
// =============================================================================
import { Client, CopySourceOptions, CopyDestinationOptions } from 'minio';
import { Readable } from 'node:stream';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

export function objectKey(orgId: string, fileId: string): string {
  return `${orgId}/${fileId}`;
}

export function dedupKey(orgId: string, sha256: string): string {
  return `${orgId}/_dedup/${sha256}`;
}

export function bucket(): string {
  return config.minio.bucket;
}

function buildClient(endpoint: string, port: number, useSSL: boolean): Client {
  return new Client({
    endPoint: endpoint,
    port,
    useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
    region: config.minio.region,
  });
}

const internalClient: Client = buildClient(config.minio.endpoint, config.minio.port, config.minio.useSSL);

// 公网签名端点（浏览器可访问）；未配置时退化为内部端点
const publicEndpoint = config.minio.publicEndpoint || config.minio.endpoint;
const publicPort = config.minio.publicEndpoint ? config.minio.publicPort : config.minio.port;
const publicUseSSL = config.minio.publicEndpoint ? config.minio.publicUseSSL : config.minio.useSSL;
const publicClient: Client = buildClient(publicEndpoint, publicPort, publicUseSSL);

export function getClient(): Client {
  return internalClient;
}

export function getPublicClient(): Client {
  return publicClient;
}

export async function pingMinio(): Promise<boolean> {
  try {
    await internalClient.bucketExists(bucket());
    return true;
  } catch {
    return false;
  }
}

// ---------- 签名 URL（全部走公网客户端） ----------

export async function presignPut(key: string, expiry: number = config.minio.presignExpiry): Promise<string> {
  return publicClient.presignedPutObject(bucket(), key, expiry);
}

export async function presignGet(key: string, expiry: number = config.minio.presignExpiry, respHeaders?: Record<string, string>): Promise<string> {
  return publicClient.presignedGetObject(bucket(), key, expiry, respHeaders);
}

// 分片上传：为指定 partNumber 签发 PUT 签名 URL（MinIO Multipart Upload）
export async function presignPartPut(key: string, uploadId: string, partNumber: number, expiry: number = config.minio.presignExpiry): Promise<string> {
  return publicClient.presignedUrl('PUT', bucket(), key, expiry, { partNumber: String(partNumber), uploadId });
}

// ---------- Multipart（服务端操作） ----------

export async function createMultipart(key: string, metaData: Record<string, string>): Promise<string> {
  // v8: initiateNewMultipartUpload 返回 uploadId
  return internalClient.initiateNewMultipartUpload(bucket(), key, metaData);
}

export interface PartInfo {
  partNumber: number;
  etag: string;
}

export async function completeMultipart(key: string, uploadId: string, parts: PartInfo[]): Promise<{ versionId: string; etag: string }> {
  const result = await internalClient.completeMultipartUpload(
    bucket(),
    key,
    uploadId,
    parts.map((p) => ({ part: p.partNumber, etag: p.etag }))
  );
  return { versionId: result.versionId || '', etag: result.etag };
}

export async function abortMultipart(key: string, uploadId: string): Promise<void> {
  try {
    await internalClient.abortMultipartUpload(bucket(), key, uploadId);
  } catch (err) {
    logger.warn('abort multipart failed', { key, message: (err as Error).message });
  }
}

// ---------- 对象操作 ----------

export interface ObjectStat {
  size: number;
  etag: string;
  versionId: string;
  metaData: Record<string, string>;
}

export async function statObject(key: string): Promise<ObjectStat> {
  const s = await internalClient.statObject(bucket(), key);
  return {
    size: s.size,
    etag: s.etag,
    versionId: (s.versionId as string) || '',
    metaData: (s.metaData as Record<string, string>) || {},
  };
}

// 拷贝对象（MinIO 内部为元数据级操作，不产生额外物理数据 —— 去重/回滚基础）
export async function copyObject(
  srcKey: string,
  dstKey: string,
  srcVersionId?: string
): Promise<{ versionId: string; etag: string }> {
  const source = new CopySourceOptions({
    Bucket: bucket(),
    Object: srcKey,
    VersionID: srcVersionId,
  });
  const dest = new CopyDestinationOptions({ Bucket: bucket(), Object: dstKey });
  const result = (await internalClient.copyObject(source, dest)) as unknown as { etag?: string; versionId?: string };
  return { versionId: result.versionId || '', etag: result.etag || '' };
}

// 彻底删除对象（含已知版本；未跟踪的旧版本由桶生命周期规则兜底清理）
export async function removeObjectAllVersions(key: string, versionIds: string[] = []): Promise<void> {
  for (const vid of versionIds) {
    if (vid && vid !== 'null') {
      try {
        await internalClient.removeObject(bucket(), key, { versionId: vid });
      } catch {
        /* 版本可能已被删除 */
      }
    }
  }
  // 删除当前版本/遗留删除标记
  try {
    await internalClient.removeObject(bucket(), key);
  } catch {
    /* ignore */
  }
}

// 读取对象流（服务端哈希校验用）
export function getObjectStream(key: string): Promise<Readable> {
  return internalClient.getObject(bucket(), key);
}

// 对象内容哈希（BLAKE3/B3SEG 并行）已迁移至 lib/blake3.ts 的 computeObjectHash(key, size)

// 批量删除对象（S3 DeleteObjects，单请求最多 1000 个 key）。
// purge 大目录/清空回收站提速：替代逐对象 removeObject（万级文件时网络调用次数从 N 降到 N/1000）。
// 注意：S3 批量删除不含版本控制下的历史版本/删除标记清理（由 removeObjectAllVersions 兜底），
// 这里仅删除当前版本；失败项返回（由调用方决定是否降级重试），不抛异常阻断。
export async function removeObjectsBulk(keys: string[]): Promise<string[]> {
  const failed: string[] = [];
  try {
    const chunk = keys.slice(0, 1000);
    const errors = await internalClient.removeObjects(bucket(), chunk);
    // removeObjects 返回错误流（ItemError[]），逐个收集失败 key
    for await (const err of errors) {
      failed.push((err as { key?: string }).key ?? (err as { Key?: string }).Key ?? '');
    }
    // 超过 1000 的剩余 key 无法单请求完成——调用方负责分批，此处仅兜底
  } catch (err) {
    logger.warn('removeObjectsBulk failed', { count: keys.length, message: (err as Error).message });
    return keys;
  }
  return failed;
}

export function objectExists(key: string): Promise<boolean> {
  return internalClient
    .statObject(bucket(), key)
    .then(() => true)
    .catch(() => false);
}
