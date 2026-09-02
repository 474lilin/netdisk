# 离线交付包打包脚本（Windows PowerShell 版）
# 在【有网环境】执行，产物拷贝到内网服务器离线安装
# 用法: powershell -ExecutionPolicy Bypass -File deploy\scripts\offline-package.ps1 [输出目录]
param([string]$OutDir = "")

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $OutDir) { $OutDir = Join-Path $Root "offline-package" }
$Stamp = Get-Date -Format "yyyyMMdd"
$PkgDir = Join-Path $OutDir "minio-netdisk-offline-$Stamp"
New-Item -ItemType Directory -Force -Path (Join-Path $PkgDir "images") | Out-Null
Set-Location $Root

if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }

Write-Host "==> 1/5 构建镜像 ..."
docker compose build

Write-Host "==> 2/5 导出镜像（需要 gzip，Windows 可用 7-Zip 或 WSL gzip）..."
cmd /c "docker save minio-netdisk/server:1.0.0 | gzip > `"$PkgDir\images\server.tar.gz`""
cmd /c "docker save minio-netdisk/web:1.0.0 | gzip > `"$PkgDir\images\web.tar.gz`""
cmd /c "docker save postgres:16-alpine | gzip > `"$PkgDir\images\postgres.tar.gz`""
cmd /c "docker save minio/minio:RELEASE.2024-12-18T13-15-44Z | gzip > `"$PkgDir\images\minio.tar.gz`""
cmd /c "docker save minio/mc:RELEASE.2024-11-21T17-21-54Z | gzip > `"$PkgDir\images\mc.tar.gz`""

Write-Host "==> 3/5 收集部署文件 ..."
Copy-Item "docker-compose.yml", "docker-compose.distributed.yml", ".env.example", "README.md" -Destination $PkgDir
Copy-Item -Recurse "deploy" -Destination $PkgDir
Copy-Item -Recurse "docs" -Destination $PkgDir

Write-Host "==> 4/5 收集源码（不含 node_modules）..."
$src = Join-Path $PkgDir "source"
New-Item -ItemType Directory -Force -Path $src | Out-Null
foreach ($d in @("server", "web")) {
  robocopy (Join-Path $Root $d) (Join-Path $src $d) /E /XD node_modules dist .git /NFL /NDL /NJH /NJS > $null
}

Write-Host "==> 完成: $PkgDir"
