# 开机续接指南（RESUME）

> 更新：2026-09-17（v1.1.13 修复「刷新后失败任务点重试没反应」；
> **并排查出真正的上传失败根因：存储盘 N: 写满，MinIO 报 XMinioStorageFull**）。
> 下次继续开发/测试前先读本文。

## 0. ⚠️ 头号运维红线：存储盘写满 = 所有上传失败（2026-09-17 实测）

- MinIO 数据目录 = 宿主机 **`N:\minio-data-single`**（override 里 bind 到容器 `/data1`，
  启动参数 `minio server /data1`）。**N: 盘 200GB 写满（只剩 6MB）时**：
  - 服务端日志近 7 天 **2252 次** `XMinioStorageFull: Storage backend has reached its minimum
    free drive threshold`，全部发生在 `initUpload`（`POST /api/files/upload/init`）
  - 现象就是用户看到的「上传任务失败」——**和前端、网络都无关，是磁盘满了**
- **版本控制是开启的**（`mc version info nd/netdisk-data` → enabled）：
  「删除文件」只是打**删除标记**，**空间不释放**；历史版本会一直占盘。
  实测清理前：`137 GiB Used / 31634 Objects / 52687 Versions / 18322 Delete Markers`，
  而数据库存活文件只有 2587 个 —— 空间几乎全被历史版本与删除标记吃掉。
- **日常排查三连**（发现上传莫名失败先跑这个）：
  ```powershell
  [System.IO.DriveInfo]::new('N').AvailableFreeSpace/1GB          # 剩余空间（<10GB 就会拒写）
  docker exec netdisk-minio sh -c "df -h /data1"                   # 容器内视角
  docker logs netdisk-server --since 24h 2>&1 | Select-String XMinioStorageFull
  ```
- **回收空间（安全顺序）**：
  ```powershell
  $u=(Select-String -Path .env -Pattern '^MINIO_ROOT_USER=').Line -replace '^MINIO_ROOT_USER=',''
  $p=(Select-String -Path .env -Pattern '^MINIO_ROOT_PASSWORD=').Line -replace '^MINIO_ROOT_PASSWORD=',''
  .\mc.exe alias set nd http://127.0.0.1:9000 $u $p --api S3v4
  .\mc.exe rm --incomplete --recursive --force nd/netdisk-data            # 1) 未完成分片上传残留
  .\mc.exe rm --recursive --force --versions --non-current nd/netdisk-data # 2) 非当前版本+删除标记
  .\mc.exe admin info nd                                                   # 3) 复核 Used/Objects/Versions
  ```
  > 注意：清理前先 `pg_dump`（见 `docs/04-备份与恢复.md`），并确认**当前可见文件不受影响**
  > （`--non-current` 不动当前版本）；代价是失去「版本回滚/误删恢复」能力。
  > 另：`N:\minio-data-backup-20260826`（14.5GB 陈旧原始副本）已于 2026-09-17 移到 `E:\`，
  > 未删除；`.env`/override 未改动。

## 0. ⚠️ 事故记录与救援（2026-09-17）：整桶误删，正在反删除救援

### 发生了什么
执行「清理孤儿对象」时用了：
`mc rm --recursive --force --versions --stdin nd/netdisk-data < 清单文件>`
**在启用版本控制的桶上，该命令会忽略 stdin 清单，直接递归删除路径参数（整个桶）下的一切**。
实测复现：临时桶里只列 2 个 key，执行后 5 个对象全被删；换成非版本化桶则只删清单内的 2 个。
（此前只用"单个 key"试删过：那时路径参数恰好就是那个 key，所以看起来正确 —— 错误的推广。）
后果：`netdisk-data` 全部对象被物理删除（2587 个在线文件 67GB + 回收站 11GB + 去重池对象）。

### 现状
- **数据库完好**：文件/目录树、文件名、大小、**B3SEG 哈希**、`object_key`、owner、时间全在。
- MinIO：`/data1/netdisk-data` 仅剩约 700MB 元数据，对象不存在。
- N: 空闲 153GB；`vssadmin` 查 N: **无卷影副本**；`backups/` 只有 pg_dump（无对象）。
- `E:\minio-data-backup-20260826`（8/26 那份）是**8/27 已确认删除的老数据**，抽样 0/20 命中当前文件，救不了这次。
- 关键前提：下载接口 `presignGet(object_key)` **不锁 version_id**（按 key 取当前版本）
  → **只要把对象内容放回原 key，网盘无需改库即可恢复**（`version_id` 只影响历史版本回滚）。

### 救援步骤（已备好脚本，脚本已自测通过）
```powershell
# 1) 立刻止损：不要再往 N: 写任何东西（别上传、别拷文件进去），Docker 可保持运行
# 2) 用反删除工具把整棵目录按"保留路径"恢复到暂存目录（**绝不能恢复到 N:**）
#    目标路径：N:\minio-data-single\netdisk-data     推荐工具：DiskGenius / R-Studio / Recuva
#    纯签名恢复（PhotoRec 无路径）也行——脚本会按内容哈希自动匹配
#    暂存目录建议：E:\recover-stage （E: 需容纳 ~73GB）
# 3) 分析（只读，不动数据）
$env:STAGE='E:\recover-stage'; node e2e/_rescue-rebuild.mjs analyze
# 4) 回传（校验通过的对象才上传到原 key：mc cp 到 nd/netdisk-data/<原 key>）
$env:STAGE='E:\recover-stage'; node e2e/_rescue-rebuild.mjs restore
# 5) 复核
node e2e/_verify-storage-integrity.mjs
```
- 脚本判定依据（逐一验证，不猜）：文件对象用 `files.size_bytes` + `files.sha256`（B3SEG）；
  去重池对象用 `dedup_pool.size_bytes` + key 末尾的 sha256 段。
  支持单盘布局的 `part.1…part.N` 分片拼接与小对象"内联在 xl.meta 尾部"两种形态。
- 产物：`E:\netdisk-backups\recovery-plan.json`（回传计划）、`recovery-missing.csv`（救不回来的对象）、
  `lost-manifest.csv`（2587 个丢失文件的完整路径/大小，供对照本地原件重传）。
- 自测记录：`node e2e/tmp/_rescue-selftest.mjs` → 分片对象与内联对象均恢复、错误内容被拒、
  拼接结果与原始字节完全一致；`restore` 通道实测 2/2 上传成功。

### 永久禁令（写死在这里，避免重犯）
1. **禁止** `mc rm --recursive --force --versions --stdin <alias>/<bucket>` 这种"清单+递归"组合；
   版本化桶下删除**必须逐 key 指定完整路径**：`mc rm --recursive --force --versions nd/netdisk-data/<key>`。
2. 任何批量删除前必须先跑**数据库反查**（files / file_versions / upload_sessions / dedup_pool / sha256 派生
   六条通道全部 0 引用），并用 `--dry-run` 或临时桶验证**命令形式本身**，而不是只验证清单内容。
3. 大清理前先做 `pg_dump` + **对象镜像**（`mc mirror`），不要只备份元数据。

## 1. 当前状态快照（2026-09-17 核对）

- 5 容器：`netdisk-server` / `netdisk-web` / `netdisk-minio` / `netdisk-postgres` / `netdisk-redis`（全部 healthy）
- **MinIO 拓扑：单盘**（默认命名卷 `minio-data`；本地 override 单盘 bind 到 `N:\minio-data-single`；
  旧 4 盘纠删码数据在 `N:\minio-data\data1..4` 已不再读取，确认无需后可删除释放空间）
- **Redis 热点缓存**：目录列表（`dir:{orgId}:{userId}:{dirId}`，TTL 30s）+ 分享元信息（`share:{token}`，TTL 15s/到期精确）；写操作主动失效；权限实时校验不缓存
- **PostgreSQL 实际数据**（2026-09-17 备份前实测）：`files=2587`（活跃，67GB）、`directories=588`、
  回收站 152 项（11GB）、`dedup_pool=1496`（58GB）、`users=2`（admin 管理员 + demo 演示账号）
  - 注：2026-08-27 曾按用户确认清空全部数据（含 21k 测试目录），此后为新一轮真实上传数据
- **MinIO 侧对象**：`31634 Objects / 52687 Versions / 18322 Delete Markers`（清理前）
- **部署版本**：web/server 均为 **v1.1.13**（镜像构建 2026-09-17，代码与镜像一致已核对）
  - v1.1.11：修复「上传目标目录已删除」404 风暴（立即失败 + 整批清理 + 按目录暂停）
  - v1.1.12：全功能体检 33 项通过；修复任务面板 z-index 遮挡行内下拉菜单
  - v1.1.13：刷新后失败任务可「重新选择文件」断点续传；retryTask/批量重试解除队列暂停；
    小文件自动续传不再产生重复任务（详见 CHANGELOG）
- Docker VM：6GB / 4 核（`.wslconfig`）；镜像加速 `docker.m.daocloud.io`
- **代码仓库：已初始化 git 并推送 GitHub** —— https://github.com/474lilin/netdisk（Public）
  - 本地目录 `N:\奇思妙想\minio-netdisk`；远端 `origin`
  - `.gitignore` 已排除 `.env`/备份/测试残留/本机 override（.env 仅存本地，不入库）
  - 推送命令：`git add -A && git commit -m "..." && git push`
- 备份方式：`docs/04-备份与恢复.md`（pg_dump + mc mirror）；
  2026-09-17 清理前备份：`E:\netdisk-backups\nd-pre-cleanup-20260917-1305.dump`（7.1MB）

## 2. 开机重启步骤

```powershell
# 1) 启动 Docker Desktop，等待引擎就绪（托盘图标变绿）
# 2) 启动整套服务（代码无改动则无需 --build；有改动用 --build）
cd N:\奇思妙想\minio-netdisk
docker compose up -d
# 3) 等待健康（约 30-60s）
docker compose ps          # 全部 healthy 即可
curl http://127.0.0.1:8080/api/health   # {"ok":true,"db":true,"minio":true}
```

> 说明：`docker-compose.override.yml` 当前将 MinIO 数据 bind 到 N: 盘（10GB 实测用临时配置）。
> 若 C: 盘空间充足可删除该文件恢复默认命名卷（更快）；N: 盘剩余约 52GB。
> 重建 server 容器无需重启 web：nginx 已配置动态解析（resolver 127.0.0.11 + 变量 proxy_pass），
> 最长 10s 内自动恢复（见第 7 节"nginx 动态解析"）。

## 3. 开机后快速回归（按需）

```powershell
# 去重专项（A-E，约 5-6 分钟）
node deploy/scripts/smoke-dedup.mjs
# Redis 缓存专项（约 1 分钟）
node deploy/scripts/smoke-redis-cache.mjs
# 600MB 回归
node deploy/scripts/smoke-b3-600.mjs
# 上传/下载吞吐基线
node deploy/scripts/bench-io.mjs 512
# 10GB BLAKE3 基准
node deploy/scripts/bench-b3.mjs
# 浏览器 e2e
cd e2e && node browser-e2e.mjs
# 刷新后重试修复专项（v1.1.13：2×40MB + 6MB 上传中刷新 → 重选文件断点续传，约 2-4 分钟）
cd e2e && node _ui-retry-after-refresh.mjs
# 断点记录写入核查（IndexedDB；含"污染库自愈"场景）
cd e2e && node _probe-resume-idb.mjs
# 存储完整性核验（对照数据库核对每个存活文件的对象可读性 + 抽样 B3SEG 哈希，约 5-8 分钟）
#   前置：需先生成清单（见 docs/04-备份与恢复.md 或 CHANGELOG v1.1.13 说明）
cd e2e && node _verify-storage-integrity.mjs
# 回收站/文件页批量操作分批回归（造 105 目录→全选删除→全选彻底删除→清空，约 2 分钟）
cd e2e && node _trash-batch-full.mjs
# 体验断言回归（表单校验/按钮态/权限/协议弹窗/移动端，约 1 分钟）
cd e2e && node _ux-assert.mjs
# 分享页专项（面包屑导航/目录内下载/无效分享区分，约 1 分钟）
cd e2e && node _share-ux.mjs
# 全套 QA（约 40-60 分钟；T4 含 520 文件上传约 12-18 分钟）
node deploy/scripts/_qa-t1.mjs; node deploy/scripts/_qa-t2.mjs; node deploy/scripts/_qa-t3.mjs
cd e2e && node _qa-t4.mjs; cd ..; node deploy/scripts/_qa-t5.mjs
```

## 4. 已完成的开发内容（截至 Redis 缓存）

> 完整升级记录见根目录 **CHANGELOG.md**（每次发布的功能/修复/配置变更，按版本归档）；本文按功能归类。

1. **BLAKE3/B3SEG 全链路**：`server/src/lib/blake3.ts`（worker_threads 并行）+ `web/src/utils/hash.ts`
   （Web Worker）+ 测试参考 `deploy/scripts/lib/blake3seg.mjs`。方案：`BLAKE3(BLAKE3(seg0)||...)`，8MB 分片，**≠ b3sum**。
2. **两级内存缓存**：`server/src/lib/segmentCache.ts`（段数据 LRU + 段哈希缓存，`HASH_CACHE_MB`）。
3. **MinIO 单盘优化**：docker-compose 默认单盘命名卷（4 盘纠删码仅多块独立物理盘才有意义）。
4. **QA 全功能测试（73/73 全绿）**：详见 `docs/QA-测试报告.md`。
5. **数据库查询优化**：pg_trgm GIN 索引（`idx_files_name_trgm`，实测 5 万行 35ms→4ms，8-49x）
   + 目录 path 前缀 btree 索引（`idx_directories_path_pattern`），已固化到 `deploy/postgres/init/01-schema.sql`。
6. **Redis 热点缓存**（用户决策：上 Redis 容器 + 不做权限缓存）：
   - `server/src/lib/cache.ts`：ioredis 封装（TTL/前缀删除/静默降级——Redis 不可用时业务直接落库）
   - 目录列表：`listDir` 仅缓存 items（权限实时校验），键 `dir:{orgId}:{userId}:{dirId}`（**含 userId**：
     列表项携带按用户 ACL 解析的权限摘要，不可跨用户共享），TTL 30s
   - 写操作主动失效：mkdir / rename / move / copy / deleteToTrash / restore / purge / completeUpload
     （失效操作目录 + 父目录 + 子树）
   - 分享元信息：`getShareMeta` 缓存静态字段（密码/有效期上限/名称/所有者），键 `share:{token}`，
     TTL 15s（有到期时间则精确到到期时刻）；访问计数**不缓存**（实时查询，保证次数上限精确）；
     `revokeShare` 立即失效
7. **测试中发现并修复的 6 个问题（全部已部署验证）**：
   | # | 级别 | 问题 | 修复 |
   |---|---|---|---|
   | 1 | P1 | 前端上传任务 N² 膨胀（beforeUpload 传整批 fileList） | 逐文件入队（web 已重建） |
   | 2 | P1 | 并发同名 complete 竞态 500（PG 事务 aborted） | 冲突回滚→新事务重试 |
   | 3 | P2 | 孤儿池存储泄漏（真实上传池副本不清理，实测 1.65GB） | **缓存+GC 设计**：池保留 30 天（POOL_GC_DAYS）供删除后秒传，每日 GC 清理超期零引用池 |
   | 4 | P2 | 文件名 URL 编码穿越未拦截（%2F/%5C/%00/CRLF 注入） | decode 后二次校验（循环 3 轮）+ 控制字符拦截 |
   | 5 | P3 | 预览响应 Content-Type 依赖上传 mime（octet-stream 不当） | 按扩展名强制 response-content-type（PREVIEW_MIME） |
   | 6 | P3 | 大对象哈希读取并发不足（3 路） | 提升至 6 路（104→129 MB/s） |
8. **nginx 反代动态解析（根治 server 重建后 502）**：`/api/` 改 `resolver 127.0.0.11` + 变量
   `proxy_pass $backend`；实测强制 server 换 IP 后无需重启 web、≤10s 自动恢复（见第 7 节）。
9. **数据库索引补充（10 万行 files + 5 万行 dirs 实测）**：
   - 配额统计：新增 `idx_files_owner_size (owner_id, size_bytes)`（**不带谓词**——回收站文件仍占用
     配额，与"删除进回收站不扣减、彻底删除才扣减"语义一致），实测 Index Only Scan 26.7ms → 0.3ms（~88x）
   - files 目录列表：删除冗余 `idx_files_dir`（被 `uq_files_dir_name (dir_id,name) WHERE is_deleted=false`
     部分唯一索引完全覆盖：dir 等值 + name 排序 + 软删除过滤），实测 0.356ms → 0.185ms
   - ② 文件名搜索 `idx_files_name_trgm`（上轮已建）、③ 目录 path 前缀
     `idx_directories_path_pattern`（上轮已建）经 5 万行实测确认生效（btree pattern 0.91ms，
     前缀查询优于 GIN trgm——GIN 仅对中间匹配有效而路径查询全是前缀，**不建 GIN**）
   - 用户原稿修正：`files(parent_id,...)` 不存在该列（目录归属为 dir_id）；`size` 应为 `size_bytes`
10. **回收站自动清理完善**（`trash.service.ts` + `scheduler/index.ts`）：
   - 原已具备：每日清理 + 30 天（TRASH_RETENTION_DAYS）+ 逐个 MinIO 删除 + DB 硬删除 + 目录子树清理
   - 本次补齐：**审计留痕**（`writeSystemAudit`：系统级任务无 HTTP 上下文，直接 INSERT audit_logs；
     `trash_purge_file`/`trash_purge_dir`，detail 含 name/size/objectRemoved/retentionDays/subtreeFiles）
   - **时间从凌晨 2 点改为凌晨 3 点**（`'0 3 * * *'`，与配额重算同分钟；对 used_bytes 的写入在
     READ COMMITTED 下互不阻塞，极端交叉由次日重算校正）
   - 实测：31 天前文件/目录被清（DB 行 + MinIO 对象均消失、used_bytes 扣减、审计 5 条）、
     29 天前文件保留
11. **前端三块优化（首屏 / 上传进度 / 列表交互，浏览器实测）**：
   - 首屏：路由级 React.lazy + Suspense（8 个页面独立 chunk 0.3-10KB）；`FilePreview` 懒加载
     ——pdfjs/xlsx/docx（preview chunk 874KB + pdf.worker 1.3MB）不再进首屏；index.html 加 boot-splash
     占位。首屏 JS 约减 840KB+
   - 上传进度：`fileHash` 支持分片进度回调（大文件哈希阶段显示真实进度）；队列显示实时速率
     （interval 差分）；全部成功 2.5s 后自动收起
   - 列表交互：本地即时过滤（输入即筛，不调后端）；名称/大小/时间列排序（点击列头）；
     大目录（>400 项）自动启用 rc-table 虚拟滚动（scroll.y 必须为**数字**，字符串 calc 会致
     body 不渲染）；过滤后无效选择键自动剔除
   - 顺手修复：antd `destroyOnClose`→`destroyOnHidden`（7 处）、Spin tip nest 用法（消控制台警告）
   - 实测：500 文件目录 DOM 仅渲染 12 行、滚动到底可见 doc_0500；过滤 1 行命中；排序升/降序正确；
     哈希阶段标签出现；队列自动收起；无控制台错误
12. **监控告警（Redis 内存 / 缓存命中率 / 清理任务状态）**：
   - `monitor.service.ts`：`recordJobRun`（scheduler 每任务记录 monitor_job_runs）、
     `runMonitorCheck`（每 5 分钟，MONITOR_CHECK_CRON）：Redis INFO 采集内存/命中率、
     任务停滞评估（每日任务 26h / 每小时 2h 无成功即告警；持续失败也告警；表空 = 调度器未运行）
   - 告警持久化：`monitor_alerts`（同 metric 去重，恢复自动置 inactive；`scheduler_not_running` 全表判活）
   - 端点：`/api/health` 附加 monitor 摘要（读内存缓存，无高频 Redis 调用）；
     `/api/monitor/status`（登录）、`/api/monitor/check`（管理员手动触发）
   - 配置：MONITOR_REDIS_MEM_PCT(80)、MONITOR_HITRATE_MIN_SAMPLE(200)、MONITOR_CHECK_CRON
   - 实测：redis maxmemory 调至 1MB → critical 告警 → 恢复 256MB 自动解除；share_cleanup 记录
     改 3 天前 → job_stale critical → 恢复解除；pool_gc 持续失败 → 告警；健康状态下 0 告警
13. **告警通知渠道（钉钉 / 企业微信 / 邮件 / 通用 webhook）**：
   - `lib/notify.ts`：告警**首次触发**（raised）与**恢复**（resolved）时通知，持续告警不重复；
     渠道未配置即跳过、可多选同时发、失败仅记日志不影响主流程
   - 钉钉机器人（markdown，支持加签 secret）、企业微信机器人（markdown）、SMTP 邮件（nodemailer，
     新依赖）、通用 webhook（POST JSON 事件数组）
   - 配置：`ALERT_DINGTALK_WEBHOOK/SECRET`、`ALERT_WECOM_WEBHOOK`、`ALERT_WEBHOOK_URL`、
     `ALERT_SMTP_HOST/PORT/SECURE/USER/PASS`、`ALERT_MAIL_FROM/TO`
   - 实测（本地接收器端到端）：告警 + 恢复两方向 × 4 渠道全部送达，payload 格式符合各平台规范
     （钉钉/企微 markdown、webhook 事件数组、邮件 quoted-printable）
   - 注意：修改 .env 后重建前先 `docker compose config` 校验；.env 中"注释与赋值同行"是项目
     原有风格（赋值被注释、靠 compose 默认兜底），勿误改
14. **性能清单逐项核查与补齐（路由懒加载/gzip/进度条/虚拟滚动/分页/缩略图）**：
   - ✅ 路由懒加载（完成项 11）、✅ gzip（nginx 已配置，实测 Content-Encoding: gzip 生效）、
     ✅ 上传进度条（完成项 11）、✅ 虚拟滚动渲染（完成项 11）
   - ② 组件按需加载：补 ShareModal/PermissionModal/VersionModal/MoveModal/UploadQueue → React.lazy
     （FilePreview 已懒加载；弹窗局部 Suspense 避免整页 fallback）
   - ⑤ **服务端分页**（此前虚拟滚动只解决渲染、listDir 仍全量返回 10 万条）：listDir 加
     offset/limit（默认 500，上限 5000）+ total/hasMore；**缓存仅首页**（offset=0），写操作失效照旧；
     前端"加载更多"按钮（已显示 x / total）。实测 1200 文件目录：500/500/200 三页、hasMore 正确、
     排序稳定（pgfile_0001→0501→1001）
   - ⑥ **图片缩略图懒加载**（此前列表只有图标）：新增 ThumbImg 组件——图片文件（扩展名判断）
     在名称列显示缩略图，IntersectionObserver 进入视口才请求预览 URL（rootMargin 200px 预加载），
     URL 按文件缓存（55min TTL 防签名过期）；实测 canvas 生成 PNG 上传后列表渲染 <img>
     naturalWidth>0、preview API 200
   - 已知边界：分页后新上传文件若按 name 排在大目录首页之外，需"加载更多"/过滤查看（首页刷新）
   - 前端主包进一步缩小：弹窗组件移出（首屏 index chunk 约 76KB → 更小）
15. **分享页面独立（无登录态查看分享链接）**：
   - 架构本已支持：`/share/:token` 在 RequireAuth 之外独立路由；分享 API
     （meta/verify/download/list）在免 CSRF 公开组
   - 实测（无痕浏览器上下文，无任何 cookie/token）：单文件分享（打开/文件名/下载）、
     目录分享（打开/目录名/列表/文件可见）全部通过，无 401、无控制台错误
   - 修复一个边界：分享目录含图片文件时，列表复用的 FileTable 会渲染 ThumbImg →
     调用需登录的 preview API → 无登录 401 + 控制台噪音。新增 `showThumbs` 开关
     （默认 true），分享页传 false；分享页 document.title 设为分享名
   - 验证：修复后含图片的目录分享无 401、缩略图不再触发需登录请求
16. **移动端适配（响应式，375px 视口实测 14/14）**：
   - `useMediaQuery` hook（`useIsMobile` <768px）
   - MainLayout：Sider `breakpoint="md"` + `collapsedWidth={0}`（移动端自动折叠为浮层，
     汉堡按钮展开 + 点击菜单项自动收起 + 遮罩）；Header 搜索框全宽、用户名/角色移动端隐藏
   - FileTable：移动端隐藏"所有者/更新时间"列（保留名称+大小+操作），虚拟滚动列宽/scroll.x 动态
   - FileBrowserPage：过滤框移动端全宽；UploadQueue：Drawer 移动端全宽（100%）
   - ShareViewPage：卡片 `width:100% + maxWidth`；LoginPage：登录卡 `calc(100vw-32px)`
   - styles.css 加 `@media (max-width:768px)`（登录卡/内容 padding/队列紧凑）
   - 实测：登录卡 343px 不超视口、侧边栏折叠 1px、汉堡展开 220px、表格列精简、无横向滚动、
     上传队列全宽 375、分享卡片自适应、桌面 1440 回归（列保留）
17. **性能压测（k6，500 并发 × 30s）与 cluster 多进程优化**：
   - 脚本：`deploy/scripts/k6/{health,static,api-list}.js`（k6 容器 join 容器网络压测 nginx）
   - 实测基线（4 核 VM）：
     | 场景 | 单进程 | cluster 4 worker | 说明 |
     |---|---|---|---|
     | health（DB+MinIO 探测） | 577 RPS / P95 1.16s | 665 RPS / P95 1.02s | 外部依赖序列化，提升有限 |
     | 静态资源（nginx gzip） | 6774 RPS / P95 141ms | — | 最强，与 server 无关 |
     | 登录态列目录（JWT+DB+Redis） | 255 RPS / P95 3.78s | **351 RPS / P95 2.19s** | +38% / -42% |
     全部 0 失败（500 并发下无错误响应）
   - 瓶颈定位：docker stats 实测 server CPU 单进程 ~120%（单核饱和）、PG/Redis 低负载
     → **cluster 多进程**（`index.ts`：主进程引导 + scheduler 单实例 + 4 worker 共享端口，
     worker 崩溃自动拉起；`PG_POOL_MAX` 每 worker 均分；`WEB_CONCURRENCY` 可配，1 = 关闭）
   - cluster 后 worker CPU ~295%（3/4 核满）——瓶颈已到 4 核 VM CPU 上限；
     更高吞吐需更多核或减少每请求 CPU（JWT 验证 + JSON 序列化）
   - 回归：登录/列目录/上传/下载/删除全部通过；scheduler 仅主进程执行（无重复任务）
18. **忘记密码（邮箱 / 短信找回）**：
   - 后端 `password-reset.service.ts`：仅本地账号（LDAP 由域内管理）；6 位验证码 10 分钟有效、
     最多 5 次尝试、每账号 1 小时 5 次发送 + 60s 冷却、IP 限流；统一模糊响应（不泄露账号
     是否存在）；重置后吊销全部会话
   - 通道：邮箱（SMTP，RESET_MAIL_*）+ 短信（自建网关 webhook，RESET_SMS_WEBHOOK POST
     {phone, code}）；未配置通道时前端提示"联系管理员"
   - 表 `password_reset_codes`（索引 + 每日清理保留 7 天）；审计 `password_reset`
   - 前端：`/forgot-password` 独立页（三步：账号+通道 -> 验证码+新密码 -> 完成），登录页
     "忘记密码？"入口；通道可用性由 `/api/auth/password-reset/channels` 驱动
   - 实测端到端（本地 SMTP 接收器）：发码 -> 邮件收到 6 位码（base64 正文解码）-> 错误码 400 ->
     正确码重置 -> 新密码登录成功 -> 验证码一次性（复用 400）-> 原密码失效；admin 密码已恢复
   - 生产配置：.env 填 `RESET_MAIL_HOST/PORT/SECURE/USER/PASS/FROM`（或 `RESET_SMS_WEBHOOK`）后
     重建 server 即生效；用户需在管理台维护 email/phone 字段
19. **注册/登录安全增强（核心 8 项，端到端实测 41 项全绿）**：
   - **自助注册** `/register`：邮箱/手机验证码（`verification_codes` 表，限流 1h5 次+60s 冷却、
     一次性、5 次尝试）+ 算术 CAPTCHA（**Redis 存储**——cluster 多 worker 共享，进程内存会跨
     worker 失效）+ 密码强度（≥8 位含字母数字）+ 用户协议必选；重复注册/未同意协议被拒
   - **多方式登录**：账号/邮箱/手机号（`username OR email OR phone`）；LDAP 走域认证
   - **账号锁定**：连续 5 次失败锁定 30 分钟（`failed_attempts/locked_until`），到期自动解锁
   - **2FA（TOTP）**：speakeasy + qrcode（新依赖）；设置扫码绑定 → 登录密码后发挑战令牌
     （5 分钟 JWT）→ 校验动态码完成登录（`finishAuth` 需跳过 2FA 分支否则二次返回挑战——已修）；
     关闭需动态码+密码；`window:1` 容忍时钟偏差
   - **密码找回升级**：验证码 + **重置链接**（一次性、30 分钟、`reset-password?token=` 页）；
     重置后吊销全部会话强制重新登录
   - **密码历史**：`password_history` 表保留最近 5 条，改密/重置禁重复使用
   - **设备管理**：`/api/auth/sessions` 列表（含当前标记）+ 踢下线（吊销会话）
   - **异常登录检测**：登录时对比最近会话 IP/UA 变化 → `risk` 标记 + 前端提示
     （无 IP 地理库，用设备特征近似；异地地理库/数据导出/90 天强制改密后置）
   - 实测：安全测试 1（注册/多方式/锁定/设备）14 项、安全测试 2（2FA/重置链接/历史）16 项、
     前端渲染 11 项，全部通过
20. **批量操作分批修复（回收站全选一次性彻底删除）**：
   - 根因：批量接口 `targets` 单次上限 100（后端防滥用），回收站 >100 项全选一次性提交被 zod
     拒绝（400）→ 只能单个删除
   - 修复：前端**分批串行**（每批 ≤100）——`TrashPage` 恢复/彻底删除、`FileBrowserPage`
     删除/移动/复制（`chunked`/`chunkedTargets`）；批量 `onOk` 补 try/catch（失败提示 + 刷新
     列表，防确认弹窗卡死无反馈）
   - 实测（浏览器 e2e `e2e/_trash-batch-full.mjs`）：API 造 105 目录（>100）→ 文件页全选
     105 行 → Popconfirm+Modal 两级确认显示 105 → 分批删除 → 回收站 105 项 → 全选彻底删除
     （确认弹窗 105 项）→ 分批 purge → 清空，全程无控制台错误
21. **体验优化 v1.0.10（代码审查 32 项 + 浏览器实测整改）**：详见 CHANGELOG v1.0.10。
    - 核心：api 层统一 30s 超时 + 网络错误中文归一化（根因）；密码强度前端与后端完全一致
      （`web/src/utils/password.ts` 复用 4 处）；上传/新建按写权限禁用；批量删除单次确认；
      上传完成汇总通知；MoveModal/版本回滚/权限删除防重与容错
    - 分享页：目录分享面包屑（后端返回子树内祖先链，可点击返回上级）+ 目录内文件可下载
      （downloadShare 支持 fileId）+ 网络错误与"分享不存在"区分
    - 安全操作确认：关闭 2FA / 下线设备二次确认；注册页验证码 60s 倒计时、CAPTCHA 失败重试、
      协议链接 stopPropagation
    - 实测：`e2e/_ux-assert.mjs`（28 项）+ `e2e/_share-ux.mjs`（10 项）全绿
22. **上传性能优化 v1.0.11（用户实测 6 文件 2.4s/个 → 请求级剖析驱动）**：
   - 根因：上传请求本身仅 100-300ms/文件；浪费在 ① 前端每任务完成都刷新列表
     （6 文件 → 6 次 GET 对，~1.8s）② BLAKE3 WASM 首次加载（~100ms+）③ completeUpload
     重复 statObject（2 次 MinIO 往返）
   - 修复：上传完成刷新**防抖合并**（500ms 窗口一次）；`warmupHash()` 页面加载后预热 WASM；
     completeUpload 合并两次 statObject 为一次
   - 实测（6×2KB 全新内容）：请求阶段 ~1.3s 全部完成 + 列表刷新仅 1 次（原 6 次）；
     秒传场景 init <500ms
   - 注意：用户已上传真实数据（约 950 活跃文件，Python 项目目录树），**勿清理**；
     测试残留只允许清理 `耗时测量-*`/`fresh-*`/`perf-*`/`浏览器上传耗时.bin` 类命名
23. **大文件夹上传实测与优化 v1.0.12（21k 文件/1.37GB 实测驱动）**：
   - 实测：`E:\python\Projectpython_N\history_lottery`（21380 文件/3195 目录/1.37GB，含 711MB 大文件）
   - 瓶颈定位（浏览器请求级 + 页内 fetch 对照）：上传请求本身快（页内 fetch 27.9 文件/s、
     node 17.5/s），慢在 ① 目录逐组串行 mkdir ② 文件夹一次性 addFiles 只启动 1 并发
     ③ 上传队列全量渲染 + 每任务状态变化触发 O(n) React 重渲染（**主因**：21k 任务时
     主线程被渲染饥饿，500 文件 136s 只完成 26 个）④ zustand 数组 map O(n) 更新
   - 修复：目录**按深度分层并行 mkdir**（限流 12）；addFiles **循环填满并发槽**（小文件 6/大文件 2）；
     队列**渲染裁剪**（仅 200 条）+ **1s 轮询快照**（根治：500 文件 41s 全完成，~12 文件/s）；
     tasks 改 **Map 存储 O(1) 更新** + FIFO 调度 + 并发上限缓存
   - 最终实测：500 文件 41s（12/s）；**21380 文件全量实测完成：21363 落库（99.9%），
     3196 目录 3s 建齐，0 失败，总耗时约 100 分钟（~4.3 文件/s 稳定）**；
     17 个未落库为 3 小时 token 过期前尾段中断（前端无跨会话断点续传）
   - 已知边界：刷新页面/长会话 token 过期会中断前端驱动的上传（后续可做服务端断点续传）
24. **Token 过期治理 v1.0.13（21k 实测 17 文件静默丢失 → 零静默失败）**：
   - 第一轮主动续期：`utils/token-refresh.ts` 解码 JWT exp + 60s 定时器（≤10min 阈值主动刷新，
     覆盖 30 分钟 access_token 有效期）+ 并发锁 + 5s 刷新超时 + 指数退避（1s/2s/4s/8s 防 429）
     + 60s 最小间隔（401 纠错 force 无视间隔）；`hooks/useVisibilityCheck.ts` 切前台检测
   - 第二轮 401 纠错：`api/client.ts` 刷新失败不跳登录，改**暂停队列**；`store/upload.ts`
     状态机加 `auth-failed`（pauseForAuth/resumeAuth，恢复不重置已传进度）；
     `components/UploadResumeButton.tsx` 恢复入口；LoginPage 登录后自动恢复；
     `utils/metrics.ts` 埋点 interrupt_reason
   - E2E `e2e/_token-e2e.mjs`：TC-01 刷新重试 / TC-02 暂停状态机 / TC-03 恢复 / TC-05 429 退避 全绿
   - 第三轮断点续传（IndexedDB + 服务端分片查询）为 v1.1.x 规划，未实施
25. **完整断点续传 v1.1.0（第三轮落地）**：
   - IndexedDB 持久化（`utils/resume-store.ts`）：sessionId/partsEtag + 小文件 File 引用
   - 服务端分片登记：`POST /upload/parts-report` + `GET /upload/parts`
     （upload_sessions.uploaded_parts 列激活）
   - 自动恢复（`hooks/useAutoResume.ts`）：刷新后小文件自动入队续传；大文件重选续传
   - 实测：20MB 分片中断 → 记录保留 → 重选续传完成；服务端 uploaded_parts {1,2} ✅
   - 测试脚本：`e2e/_resume-e2e.mjs`、`e2e/_resume-real.mjs`
   - **v1.1.1 审查加固**：IndexedDB 不可用降级 localStorage（Safari 私有模式）；批量写合并
     （500ms，防高频事务）；服务端上报改增量（防数组膨胀）；恢复分批（防极端阻塞）；
     服务端清理周期确认每日 02:30
   - **v1.1.2 漏传根治**：21k 上传 9 文件漏传（anyio 子树）定位为 **pump FIFO 陈旧快照竞态**
     （任务被跳过从未执行，无 init 记录；v1.0.12 同样漏 17 个）。永久修正：
     ① pump 内层循环每次重新 getState ② `verifyAndBackfill` 上传完成校验+自动补传。
     验证：anyio 重传 87 文件 100%、模拟删除→自动补传、21k 对比 0 漏传 0 多余
   - **v1.1.3 回收站清空数据丢失：根因 + 全量恢复 + purge 防御加固 + 清空性能优化**：15:35 用户网页全选
     删除 62 目标（42799 项含 21k 上传）→ 清空回收站 → files/directories 全清空。
     恢复：MinIO 版本控制保留历史 PUT 数据 → 撤销 19879 个删除标记 → 对象全恢复；
     audit_logs 重建目录树（39519）+ 文件（70955，83.7GB）→ 抽查下载字节一致。
     修复：`purgeItems` 目录/文件分支补 `is_deleted` 校验（活跃目标 purge 返回 count=0 拒绝）。
     性能：`listTrash` 分页 + total；新增 `POST /api/files/trash/empty` 清空回收站专用接口
     （服务端批量删对象 removeObjects + 批量删行 ANY 数组 + 聚合 quota）；前端「清空回收站」按钮。
     实测清空 1200 项 7.7s（此前 844 批 × 2s ≈ 28 分钟）。用户确认删除恢复数据并清空，
     孤儿残留一并清理 → 干净状态（2 根目录、0 文件、回收站 0）；去重池 4523 条 + MinIO
     池对象 21629 个按用户指令全部删除（后续上传重新注册池）。
     恢复工具：`e2e/_recover-*.mjs`；MinIO 数据卷备份：`N:\minio-data-backup-20260826`
   - 测试脚本：`e2e/_big-folder-upload.mjs`（21k 全量）、`_perf500.mjs`、`_inpage-fetch.mjs`、
     `_server-throughput.mjs`、`_folder-conc.mjs`、`_single-timing.mjs`
   - **v1.1.4 产品化**：售前/交付/演示文档（docs/08-10）+ README 产品首页 + 一键演示脚本
   - **v1.1.5 上传体验修复（用户反馈）**：偶发「请求失败，请稍后重试」→ 瞬时故障自愈；
     暂停/继续（单任务 + 全选批量 + 全部暂停/一键全部继续）；上传面板改为不遮挡页面的悬浮卡片。
     详见 `CHANGELOG.md` v1.1.5 与 `docs/upload-architecture.md` 第 5 节。
     验证：`node --import ./e2e/ts-register.mjs e2e/_upload-resilience.ts` → 25/25 通过
     （受限环境无法跑 esbuild/tsx 与 Docker，故用 Node 原生 TS 剥离 + 伪造 XHR/fetch 做逻辑验证）
     顺带修复 3 个隐性缺陷：迟到进度覆盖已结算状态（运行令牌）、迟到回调复活死会话（recordWrites）、
     暂停后立刻继续读不到断点（flushResumeWrites）
   - **v1.1.6/v1.1.7 上传任务列表常驻**：不再自动隐藏 + 顶栏固定入口；桌面端改为**右侧占位常驻栏**
     （不覆盖文件列表，可收起为 48px 细栏），移动端保持底部面板
   - **v1.1.8 上传可靠性根因修复（真实浏览器复现 + 服务端日志定位）**：
     ① **并发哈希串号（P0）**：客户端 BLAKE3 worker 池用「分片序号」当请求 ID，多文件并发哈希时
        互相 resolve → 上报错误哈希 → 服务端 400「文件哈希校验失败」→ 界面「请求失败，点重试又能成功」
        （≤8MB 走主线程原子哈希，故只在大文件出现）。修复：请求 ID 全局唯一。
     ② **暂停后「全部继续」卡死**：暂停未中断 JSON 接口 → 服务端已完成落库、客户端丢弃结果 →
        再次 complete 撞 MinIO NoSuchUpload(500) → 永久「上传中」。修复三层：
        接口 AbortSignal + 服务端 complete 幂等自愈 + 客户端 init 校验自愈 + store 先判成功。
     ③ 常驻栏宽度自适应（900px 窗口文件列表 256px → 356px）
     测试套件（真实浏览器 Playwright + 本机 Edge，需 danger-full-access 才能 spawn 浏览器）：
     `_ui-hash-check.mjs`（并发哈希 vs 串行基准）、`_ui-upload-flow.mjs`（4 场景，抓全部 4xx/5xx）、
     `_ui-dock-check.mjs`（布局几何+命中测试+4 种窗口宽度）、`_cleanup-tests.mjs`（软删→purge 清理测试数据）
     运行前先 `docker compose up -d`，脚本依赖 `127.0.0.1:8080` 与 `.env` 中的 admin 凭据
   - **v1.1.9/v1.1.10/v1.1.11 交互与数据面修复**：取消 Esc 收起、收起态改带文字紧凑面板；
     任务列表默认**悬浮浮层**（永不消失，支持上传+下载任务、刷新后仍在 localStorage 还原）；
     上传目标目录被删时**立即失败不重试**并按目录整批清理（实测把 291 次 404 风暴降到 14）
   - **v1.1.12 功能体检套件**：`e2e/_ui-smoke.mjs` 端到端跑核心功能（登录/建目录/上传/预览/
     重命名/搜索/分享/下载文件+文件夹/删除→回收站→恢复/各页面与接口），**33/33 通过**；
     体检中发现并修复：任务面板 z-index(1200) 高于 antd 弹层(1050) → 盖住行内「更多」下拉菜单，
     导致重命名/分享/下载/删除等行内操作失效（现已降为 900）
     全部套件：`_ui-smoke` 33/33 · `_upload-resilience` 30/30 · `_ui-hash-check` ·
     `_ui-float-download` · `_ui-dir-gone` · `_ui-upload-flow` · `_ui-dock-check` 均通过
     注意：后台任务不继承提权，跑 Playwright 套件需前台 + danger-full-access

## 5. 实测基线（2026-08-24）

| 指标 | 数值 |
|---|---|
| 上传（512MB multipart 8 并发，单盘） | 33.6 MB/s |
| 600MB 首传 / 池注册 | 16.3s / 51.9s |
| 容器内下载（空闲单流 / 并发 / 争用期） | 156 / 232-288 / 193 MB/s |
| 宿主下载（Docker 端口转发限制） | 38.6-54.8 MB/s |
| computeObjectHash（300MB，并发 6 路） | 129 MB/s（原 104） |
| 秒传（删除后重传 / 缓存命中） | 46ms / 44ms |
| 520 文件浏览器上传 | 新增恰 520/520，队列 0 失败（~700s） |
| BLAKE3 10GB 并行哈希 | 16.5s（620 MB/s） |
| Redis 目录列表缓存 | 实测 3 连读 = 1 miss + 2 hit（keyspace_hits 增量验证），TTL 30s 生效 |
| Redis 分享 meta 缓存 | 二次访问命中；revoke 后立即失效（smoke-redis-cache 15/15 全绿） |
| 配额重算（10 万行 files，owner 聚合 SUM） | 全表扫 26.7ms / 3226 buffers → Index Only Scan 0.30ms / 9 buffers（~88x） |
| files 目录列表（50 行/目录） | idx_files_dir 0.356ms → uq_files_dir_name 0.185ms（免冗余索引） |
| 目录列表（5 万行目录表、1500 子目录） | idx_directories_parent + Sort 1.75ms（Sort 开销可忽略，未另建索引） |
| 路径前缀查询（5 万行目录） | idx_directories_path_pattern Bitmap 0.91ms；GIN trgm 2.15ms（前缀 btree 更优，未建 GIN） |

## 6. 待办 / 下一步

- [x] ~~全量 21k 文件目录上传回归~~（v1.0.12 实测完成：21363 落库 / 0 失败）
- [x] ~~v1.1.x 第三轮：完整断点续传~~（v1.1.0 已实施：IndexedDB + 服务端分片查询 + 自动恢复）
- [ ] 浏览器下载经 Docker 端口转发仅 38-55 MB/s——如需更高可配置 host 网络/原生网络模式（部署层）
- [ ] 浏览器端文件夹拖拽上传测试（Playwright 对 webkitdirectory 支持有限，可用 DataTransfer 模拟）
- [ ] 命名卷 vs N: bind 对比复测（本机走 N: bind，纯命名卷更快）
- [ ] 可选：Redis 版段缓存（当前进程内实现）
- [ ] 可选：下载改经后端流式（需评估 Docker 端口转发是否仍是瓶颈）

## 7. 已知坑（开发时注意）

- **PowerShell 内联 node**：含正则/引号转义出错，一律写文件脚本再 `node xxx.mjs`。
- **容器内探针**：容器以 `node` 用户运行（/app 只读，日志写 /tmp）；探针持 unref'd worker 时
  await 不 settle 会以退出码 13 结束（事件循环空转），加 `setInterval` 保活。
- **登录限流**：5 次/分钟/IP+账号，测试脚本串行跑、间隔 60s+。
- **预览交互**：单击**文件名单元格**触发预览（行双击仅目录有效）；UI 下载 = window.open 预签名 URL
  （attachment 响应浏览器直接下载、不导航新页签）。
- **nginx 动态解析（已根治 502）**：`deploy/nginx/nginx.conf` 的 `/api/` location 用
  `resolver 127.0.0.11 valid=10s ipv6=off` + `set $backend http://server:3000` + `proxy_pass $backend`
  动态解析 server 域名（Docker 内置 DNS）。实测强制 server IP 变更后 **不重启 web，≤10s 自动恢复**。
  注意：改 nginx.conf 需重建 web 镜像（配置构建期拷入）；修配置勿回退为静态 `proxy_pass http://server:3000`。
- **Redis 缓存键含 userId**：ACL 权限摘要是按用户解析的，勿去掉 userId 共享缓存。
- **ioredis v6**：用 `import { Redis } from 'ioredis'`（默认导出在 NodeNext 下类型异常）。
- **N: 盘是慢速数据盘**（直读 620MB/s），bind mount 进一步降速——性能结论以第 5 节为准。
- **.wslconfig**：`memory=6GB processors=4 swap=2GB localhostForwarding=true`（备份 `.wslconfig.bak`）。

## 8. 关机/恢复命令速查

```powershell
# 优雅停服（关机前）
cd N:\奇思妙想\minio-netdisk
docker compose stop        # 保留容器与数据卷，开机后 up 即恢复
# 开机恢复
docker compose up -d
```
