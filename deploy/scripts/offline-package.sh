#!/usr/bin/env bash
# =============================================================================
# 离线交付包打包脚本：构建镜像 + docker save 全部镜像 + 打包源码
# 在【有网环境】执行，产物拷贝到内网服务器离线安装
# 用法: ./deploy/scripts/offline-package.sh [输出目录]
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${1:-${ROOT_DIR}/offline-package}"
STAMP="$(date +%Y%m%d)"
PKG_DIR="${OUT_DIR}/minio-netdisk-offline-${STAMP}"
mkdir -p "${PKG_DIR}/images"

cd "${ROOT_DIR}"
[ -f .env ] || cp .env.example .env

echo "==> 1/5 构建镜像 ..."
docker compose build

echo "==> 2/5 导出镜像（离线导入用 docker load）..."
docker save minio-netdisk/server:1.0.0 | gzip > "${PKG_DIR}/images/server.tar.gz"
docker save minio-netdisk/web:1.0.0 | gzip > "${PKG_DIR}/images/web.tar.gz"
docker save postgres:16-alpine | gzip > "${PKG_DIR}/images/postgres.tar.gz"
docker save minio/minio:RELEASE.2024-12-18T13-15-44Z | gzip > "${PKG_DIR}/images/minio.tar.gz"
docker save minio/mc:RELEASE.2024-11-21T17-21-54Z | gzip > "${PKG_DIR}/images/mc.tar.gz"

echo "==> 3/5 收集部署文件 ..."
mkdir -p "${PKG_DIR}/deploy"
cp -r docker-compose.yml docker-compose.distributed.yml .env.example README.md "${PKG_DIR}/"
cp -r deploy "${PKG_DIR}/"
cp -r docs "${PKG_DIR}/"

echo "==> 4/5 收集源码（不含 node_modules）..."
mkdir -p "${PKG_DIR}/source"
rsync -a --exclude node_modules --exclude dist --exclude .env \
  server web "${PKG_DIR}/source/"

echo "==> 5/5 生成安装说明 ..."
cat > "${PKG_DIR}/README-离线安装.md" <<'EOF'
# 离线安装步骤

1. 将本目录拷贝到内网服务器
2. 安装 Docker Engine + Docker Compose v2（离线 rpm/deb 包）
3. 导入镜像:
   cd images && for f in *.tar.gz; do docker load < "$f"; done
4. 初始化环境:
   cp .env.example .env
   # 编辑 .env：修改所有密码/密钥；MINIO_PUBLIC_ENDPOINT 填本机内网 IP
5. 启动:
   docker compose up -d
6. 访问 http://<IP>:8080，使用 .env 中 ADMIN_USERNAME/ADMIN_PASSWORD 登录
详见 docs/02-部署手册.md
EOF

echo "==> 完成: ${PKG_DIR}"
du -sh "${PKG_DIR}"
