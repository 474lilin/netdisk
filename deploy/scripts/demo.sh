#!/usr/bin/env bash
# 演示环境一键启动（Linux/macOS）
# 用途：售前演示 / 客户试用。清空旧数据 → 启动 → 初始化演示账号/目录/文件
# 用法：bash deploy/scripts/demo.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."

echo "==> [1/5] 停止并清理旧环境（保留代码与配置）"
docker compose down 2>/dev/null || true

echo "==> [2/5] 启动基础服务（postgres/redis/minio）"
docker compose up -d postgres redis minio
sleep 8
docker compose ps --format '{{.Name}} {{.Status}}' | grep -E 'postgres|redis|minio' || true

echo "==> [3/5] 构建并启动应用（server/web）"
docker compose up -d --build server web
# 等待 server 健康
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
    echo "    server 健康检查通过"
    break
  fi
  sleep 2
  [ "$i" = 30 ] && echo "    ! 等待超时，请检查 docker compose ps" 
done

echo "==> [4/5] 初始化演示数据"
# 用 e2e 种子脚本（走完整 API 链路，最可靠）
if command -v node >/dev/null 2>&1; then
  node e2e/_seed-demo.mjs http://127.0.0.1:8080
  echo "    演示数据已初始化"
else
  echo "    (提示：本机无 node，跳过种子数据；可手动创建演示目录/账号)"
fi

echo "==> [5/5] 完成"
echo ""
echo "======================================================"
echo "  ✅ 演示环境就绪"
echo "     前端    http://127.0.0.1:8080"
echo "     MinIO  http://127.0.0.1:9001"
echo "     管理员  见 .env 的 ADMIN_USERNAME / ADMIN_PASSWORD"
echo "     演示流程  docs/10-销售话术与演示脚本.md 第三节"
echo "======================================================"
