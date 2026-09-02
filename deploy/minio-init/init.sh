#!/bin/sh
# =============================================================================
# MinIO 初始化：建桶 / 开启版本控制 / 配置 CORS（浏览器直传分片与预览需要）
# 由 minio-init 容器在 minio 健康后执行，幂等
# =============================================================================
set -e

MC=/usr/bin/mc
RETRY=60
INTERVAL=5

echo "[minio-init] waiting for minio ..."
i=0
until ${MC} alias set local "http://minio:9000" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -ge "$RETRY" ]; then
    echo "[minio-init] ERROR: cannot connect to minio after ${RETRY} tries"
    exit 1
  fi
  sleep "$INTERVAL"
done
echo "[minio-init] minio reachable"

BUCKET="${MINIO_BUCKET:-netdisk-data}"

# 1) 建桶（已存在则忽略）
${MC} mb --ignore-existing "local/${BUCKET}" >/dev/null 2>&1 || true
echo "[minio-init] bucket '${BUCKET}' ready"

# 2) 开启对象版本控制（文件版本管理/回滚依赖）
${MC} version enable "local/${BUCKET}" || echo "[minio-init] version may already enabled"

# 2.1) 生命周期规则：非当前版本 30 天后自动清理（兜底，防止历史版本无限占用空间）
${MC} ilm rule add --noncurrent-expire-days 30 "local/${BUCKET}" >/dev/null 2>&1 || echo "[minio-init] WARN: ilm rule add failed (skip)"

# 3) 桶 CORS：允许浏览器从任意来源 GET/PUT（分片直传、预览、下载均走签名 URL）
${MC} cors set "local/${BUCKET}" '{
  "CORSRules": [
    {
      "AllowedOrigins": ["*"],
      "AllowedMethods": ["GET", "PUT", "HEAD", "POST", "DELETE"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag", "x-amz-version-id"],
      "MaxAgeSeconds": 3600
    }
  ]
}' >/dev/null 2>&1 || echo "[minio-init] WARN: set cors failed (skip)"
${MC} cors get "local/${BUCKET}" || true

echo "[minio-init] done"
