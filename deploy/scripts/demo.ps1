# 演示环境一键启动（Windows PowerShell）
# 用途：售前演示 / 客户试用。清空旧数据 → 启动 → 初始化演示账号/目录/文件
# 用法：powershell -ExecutionPolicy Bypass -File deploy/scripts/demo.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

Write-Host "==> [1/5] 停止并清理旧环境（保留代码与配置）"
docker compose down 2>$null | Out-Null

Write-Host "==> [2/5] 启动基础服务（postgres/redis/minio）"
docker compose up -d postgres redis minio | Out-Null
Start-Sleep 8

Write-Host "==> [3/5] 构建并启动应用（server/web）"
docker compose up -d --build server web | Out-Null
$ok = $false
for ($i = 1; $i -le 30; $i++) {
  try {
    $null = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -TimeoutSec 5
    Write-Host "    server 健康检查通过"
    $ok = $true
    break
  } catch { Start-Sleep 2 }
}
if (-not $ok) { Write-Host "    ! 等待超时，请检查 docker compose ps" }

Write-Host "==> [4/5] 初始化演示数据"
# 用 e2e 种子脚本（走完整 API 链路，最可靠）
node e2e/_seed-demo.mjs http://127.0.0.1:8080
Write-Host "    演示数据已初始化"

Write-Host "==> [5/5] 完成"
Write-Host ""
Write-Host "======================================================"
Write-Host "  ✅ 演示环境就绪"
Write-Host "     前端    http://127.0.0.1:8080"
Write-Host "     MinIO  http://127.0.0.1:9001"
Write-Host "     管理员  见 .env 的 ADMIN_USERNAME / ADMIN_PASSWORD"
Write-Host "     演示流程  docs/10-销售话术与演示脚本.md 第三节"
Write-Host "======================================================"
