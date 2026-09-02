#!/usr/bin/env bash
# =============================================================================
# 恢复脚本：从备份目录恢复 PostgreSQL + MinIO
# 用法: ./deploy/scripts/restore.sh /data/backups/netdisk/20250101_020000
# 注意: 恢复会覆盖当前数据，请在停服状态下执行！
# =============================================================================
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "用法: $0 <备份目录>"
  exit 1
fi
BACKUP_DIR="$1"
[ -d "${BACKUP_DIR}" ] || { echo "备份目录不存在: ${BACKUP_DIR}"; exit 1; }

if [ -f "$(dirname "$0")/../../.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$(dirname "$0")/../../.env"
  set +a
fi

POSTGRES_DB="${POSTGRES_DB:-netdisk}"
POSTGRES_USER="${POSTGRES_USER:-netdisk}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
MINIO_BUCKET="${MINIO_BUCKET:-netdisk-data}"

echo "!!! 恢复操作将覆盖当前全部数据，确认 3 秒后继续（Ctrl+C 取消）"
sleep 3

# 1) 恢复 PostgreSQL
echo "==> 1/2 恢复 PostgreSQL ..."
PGPASSWORD="${POSTGRES_PASSWORD}" pg_restore -h "${POSTGRES_HOST:-127.0.0.1}" -p "${POSTGRES_PORT:-5432}" \
  -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
  --clean --if-exists --no-owner --no-privileges \
  "${BACKUP_DIR}/postgres.dump"
echo "    done"

# 2) 恢复 MinIO（mc mirror 回写，保持对象 Key 与版本）
echo "==> 2/2 恢复 MinIO bucket (${MINIO_BUCKET}) ..."
MINIO_ENDPOINT="${MINIO_ENDPOINT:-127.0.0.1:9000}"
mc alias set netdisk-restore "${MINIO_ENDPOINT}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null 2>&1
mc mb --ignore-existing "netdisk-restore/${MINIO_BUCKET}" >/dev/null 2>&1 || true
mc mirror --overwrite --preserve "${BACKUP_DIR}/minio/" "netdisk-restore/${MINIO_BUCKET}"
echo "    done"

echo "==> 恢复完成。请重启业务后端: docker compose restart server"
