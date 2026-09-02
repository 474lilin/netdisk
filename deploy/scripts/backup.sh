#!/usr/bin/env bash
# =============================================================================
# 备份脚本：PostgreSQL 元数据全量导出 + MinIO 数据镜像（mc mirror）
# 用法: 在部署机执行  ./deploy/scripts/backup.sh [备份目录]  (默认 ./backups/日期)
# 建议: 配置 crontab 每日执行，如:
#   30 2 * * * /opt/minio-netdisk/deploy/scripts/backup.sh /data/backups/netdisk >> /var/log/netdisk-backup.log 2>&1
# =============================================================================
set -euo pipefail

# ---- 从 .env 读取（若存在） ----
if [ -f "$(dirname "$0")/../../.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$(dirname "$0")/../../.env"
  set +a
fi

BACKUP_ROOT="${1:-./backups}"
STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="${BACKUP_ROOT}/${STAMP}"
mkdir -p "${BACKUP_DIR}"

POSTGRES_DB="${POSTGRES_DB:-netdisk}"
POSTGRES_USER="${POSTGRES_USER:-netdisk}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
MINIO_BUCKET="${MINIO_BUCKET:-netdisk-data}"

echo "==> 备份目录: ${BACKUP_DIR}"

# 1) PostgreSQL 元数据（文件列表/用户/权限/审计全部在库里，必须备份）
echo "==> 1/2 备份 PostgreSQL (${POSTGRES_DB}) ..."
PGPASSWORD="${POSTGRES_PASSWORD}" pg_dump -h "${POSTGRES_HOST:-127.0.0.1}" -p "${POSTGRES_PORT:-5432}" \
  -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
  --format=custom --no-owner --no-privileges \
  -f "${BACKUP_DIR}/postgres.dump"
echo "    done: ${BACKUP_DIR}/postgres.dump"

# 2) MinIO 对象数据（文件实体，含版本）
echo "==> 2/2 备份 MinIO bucket (${MINIO_BUCKET}) ..."
MINIO_ENDPOINT="${MINIO_ENDPOINT:-127.0.0.1:9000}"
mc alias set netdisk-backup "${MINIO_ENDPOINT}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null 2>&1
mc mirror --overwrite "netdisk-backup/${MINIO_BUCKET}" "${BACKUP_DIR}/minio/"
echo "    done: ${BACKUP_DIR}/minio/"

echo "==> 备份完成: ${BACKUP_DIR}"
du -sh "${BACKUP_DIR}"
