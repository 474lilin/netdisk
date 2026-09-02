# 升级日志（CHANGELOG）

> 本文件按里程碑记录每次升级的内容、修复与影响面。部署/配置细节见 `docs/02-部署手册.md`，
> 运维排查见 `docs/03-运维手册.md`，续接开发见 `RESUME.md`。
> 格式遵循 Keep a Changelog；版本 `v1.0.x` 为私有化发布序列。

## [v1.1.4] - 2026-08-27

### 产品化：可接单/可售卖的网盘（售前 + 交付 + 演示全套）

- **产品定位**：「企云盘」企业内网私有化网盘，数据不出内网，离线可交付
- **新增文档**：
  - `docs/08-产品介绍与卖点.md`：定位/目标客户/功能清单/竞品对比/信任背书
  - `docs/09-定价与交付方案.md`：版本划分（标准 1.98 万/高级 3.98 万/企业 8-15 万）、
    交付物清单、交付流程、收款方式、合同边界
  - `docs/10-销售话术与演示脚本.md`：找客户渠道、触达话术、5 分钟演示脚本、
    异议应对、成交 checklist
- **演示环境**：
  - `deploy/scripts/demo.sh` / `demo.ps1`：一键启动演示环境
  - `e2e/_seed-demo.mjs`：自动初始化演示数据（部门/演示账号 demo / 产品资料库 / 示例文件）
  - 实测：demo 账号可登录、演示目录/文件落库 ✅
- **README 改为产品首页**：快速演示入口 + 产品化资料索引 + 功能/技术栈/性能

#### 关键文件
- `docs/08`、`docs/09`、`docs/10`、`README.md`
- `deploy/scripts/demo.sh`、`deploy/scripts/demo.ps1`、`e2e/_seed-demo.mjs`

## [v1.1.3] - 2026-08-26

### 回收站清空数据丢失事件：根因 + 全量恢复 + purge 防御加固 + 清空性能优化

#### 事件经过与数据恢复
- 15:35 用户在网页删除 62 目标（6 顶层目录+56 文件，count=42799）→ 清空回收站 → files/directories 全清空
- **MinIO 版本控制保留历史 PUT 数据** → 撤销 19879 个删除标记（0 失败）→ 对象全恢复（独立 5847 + 池 21552）
- audit_logs 重建目录树（39519）+ 文件（70955，83.7GB）→ 抽查下载字节一致 ✅
- 恢复工具：`e2e/_recover-*.mjs`；MinIO 数据卷备份：`N:\minio-data-backup-20260826`

#### purge 防御修复
- `purgeItems` 目录/文件分支补 `is_deleted` 校验：活跃目标 purge 返回 count=0 拒绝 ✅

#### 回收站清空性能优化（本次重点）
- **问题**：回收站全选/清空慢——trash 接口一次仅 2000 条，前端逐批 100 targets 串行 purge，
  8 万项回收站需 844 次请求 ≈ 28 分钟
- **后端**：
  - `listTrash` 支持分页（offset/limit）+ 返回 total
  - 新增 `POST /api/files/trash/empty` 清空回收站专用接口：服务端一次拉取全部回收站项，
    目录子树合并去重，S3 批量删对象（removeObjects，1000/请求）+ 批量删 DB 行（ANY 数组）+ 聚合 quota
  - purge targets 上限 100 → 1000（purgeRefsBody）
- **前端**（TrashPage）：新增「清空回收站」按钮（单请求 + 进度提示 + 确认弹窗）；
  trash 显示总数
- **实测**：清空 1200 项回收站（200 目录+1000 文件）**7.7 秒**；8 万项回收站单请求 30-60 秒内完成
  （此前 28 分钟）；软删→回收站→清空→确认全流程 0.2-7.7s ✅

#### 数据最终处置（用户确认）
- 用户确认删除恢复数据并清空 → 40 个顶层目录软删+清空；不可见孤儿残留（7237 目录+16885 文件，
  恢复时父链断裂）一并清理 → 系统回到干净状态（2 根目录、0 文件、回收站 0、used_bytes 0）
- 用户确认删除去重池 → `dedup_pool` 表 4523 条清空 + MinIO `_dedup/` 池对象 21629 个删除
  （mc 递归删除；版本控制下历史版本保留在磁盘）→ 去重缓存清空，后续上传重新注册池

#### 关键文件
- `server/src/services/file.service.ts`（purgeItems 防御 + emptyTrash 清空接口）
- `server/src/lib/minio.ts`（removeObjectsBulk 批量删除）
- `server/src/routes/files.ts`（trash 分页 + trash/empty 路由）
- `web/src/pages/TrashPage.tsx`（清空回收站按钮）、`web/src/api/index.ts`（emptyTrash）
- `e2e/_verify-*`（性能验收脚本）

## [v1.1.2] - 2026-08-26

### 漏传问题分析与永久修正（21k 上传 9 文件漏传）

#### 根因分析
- **现象**：21k 文件夹上传漏传 9 个文件（`.venv/.../anyio/streams` 5 个 + `_backends` 4 个），
  无失败会话记录（从未 init）
- **排除**：prepareUploads 分组正确（组内 7 个文件一起入队）、目录创建成功（同组其他文件已传）、
  小规模复现（anyio 子树 87 文件重传 100% 完整）
- **定位**：**偶发任务丢失**——21k 级任务量下 pump FIFO 调度的竞态（`queuedIds.shift()` 后
  读取陈旧 state 快照判断任务状态，极端时序下任务被跳过从未执行）
- 同模式在 v1.0.12 上传（旧版）也漏 17 个文件（.venv 深处）——**大规模上传的偶发漏传**

#### 永久修正（两层保障）
1. **pump 竞态修复**（`store/upload.ts`）：内层 while 每次循环重新 `getState()`，
   消除陈旧快照导致的任务状态误判/跳过
2. **上传完成校验 + 自动补传**（`verifyAndBackfill`）：全部任务结束后，按目录分页拉取
   服务端列表对比期望文件，**缺失的自动重新入队补传**（File 引用在内存）；无 File 引用的大文件
   提示重选。由 UploadQueue 的 allSettled 自动触发——**无论什么原因漏传，最终保证 100% 落库**

#### 验证
- anyio 子树重传 87 文件：100% 完整（不复发）✅
- verifyAndBackfill e2e：上传 → 服务端删 2 文件模拟漏传 → 触发校验 → **检测并补传（新增任务）
  → 执行完毕** ✅
- 21k 全量对比（`e2e/_compare-upload.mjs`）：本地 21,380 = 网盘 21,380，**漏传 0 / 多余 0** ✅

### 关键文件
- `web/src/store/upload.ts`（pump 竞态 + verifyAndBackfill）
- `web/src/components/UploadQueue.tsx`（allSettled 触发校验）
- `e2e/_compare-upload.mjs`（完整性对比）、`e2e/_verify-backfill.mjs`（补传验证）、
  `e2e/_backfill*.mjs`（历史补传）

## [v1.1.1] - 2026-08-25

### 关键代码路径审查加固（5 项风险逐一核验修复）

| 风险点 | 审查结论 | 处置 |
|---|---|---|
| IndexedDB Safari 私有模式 | ⚠️ 原 catch 静默降级为无持久化 | ✅ **localStorage fallback**：openDb 失败标记 `idbUnavailable` → 后续写读走 `nd_resume_sessions_v2`（File 引用丢弃，进度保留）；实测屏蔽 indexedDB 后 2.5s 降级记录出现含 sessionId |
| 高频写入（每分片 1 事务） | ⚠️ 大文件多分片多次独立事务 | ✅ **批量写合并**：saveResumeRecord 500ms 合并（pendingWrites Map + flushTimer），同 key 只保留最新；删除标记 deletedKeys 防在途 flush 写回 |
| 服务端上报量（全量数组） | ⚠️ 全量上报数组膨胀 | ✅ **增量上报**：reportedParts 按 session 记录已上报分片，只发新增；complete 后清理防内存累积 |
| 恢复并发 | ✅ 队列 pump 限流 ≤6 | ✅ 补充**分批恢复**（useAutoResume 每批 50 + 让出主线程），极端 21k 全中断不阻塞 |
| 服务端清理周期 | ✅ 每日 02:30（session_cleanup）清 7d 未完成 + 30d 历史 | 无需改 |

### 关键文件
- `web/src/utils/resume-store.ts`（fallback + 批量写 + 删除竞态防护）
- `web/src/utils/uploader.ts`（增量上报 + 跟踪清理）
- `web/src/hooks/useAutoResume.ts`（分批恢复）

### 验证
- `e2e/_dbg-fallback2.mjs`（已归档为调试）：屏蔽 indexedDB → 2.5s fallback 记录写入含 sessionId/partsEtag ✅
- `e2e/_resume-e2e.mjs`、`_token-e2e.mjs` 回归全绿（无破坏）

## [v1.1.0] - 2026-08-25

### 完整断点续传（v1.0.13 第三轮落地：页面刷新/关闭后仍可恢复上传）

#### 3.1 分片状态持久化（IndexedDB）
- 新增 `web/src/utils/resume-store.ts`：IndexedDB 存储续传记录
  （sessionId/partsEtag/partSize/totalParts + **小文件 File 引用**）
- 上传引擎 `uploader.ts` 重写：分片每完成一个即持久化进度；**小文件（≤8MB）带 File 引用**
  → 刷新/关闭后**自动恢复**；大文件（>8MB）不存 File（避免 IndexedDB 占用）→ 重选同一文件续传
- 兼容旧机制：localStorage `nd_resume_sessions`（v1.0.x）作为兜底读取，迁移后清理

#### 3.2 服务端已传分片查询
- `POST /api/files/upload/parts-report`：客户端节流上报已传分片号（每 5 分片），
  服务端合并进 upload_sessions.uploaded_parts（**此列原已建但从未写入，现激活**）
- `GET /api/files/upload/parts?sessionId=`：查询已传分片（跨设备/清本地后恢复）
- 前端续传时**服务端 parts 合并**：本地缺失的分片从服务端补齐（mergeServerParts）
- 服务端关键：`file.service.ts` reportUploadedParts/getUploadedParts、
  `routes/files.ts` 两个新端点

#### 3.3 自动恢复
- 新增 `web/src/hooks/useAutoResume.ts`：页面加载读取 IndexedDB 未完成任务，
  带 File 引用（小文件）的自动重新入队 → uploader 命中同 sessionId 续传（不重复已传分片）

#### 3.4 清理策略
- 任务完成/去重命中：删除 IndexedDB 记录 + localStorage 旧记录 + 服务端会话置完成
- 过期清理：IndexedDB 记录 7 天；服务端 upload_sessions 由既有定时任务清理（30 天保留）

#### 实测（`e2e/_resume-e2e.mjs` + `_resume-real.mjs`）
- TC-R1 分片上报 + GET 查询 ✅；TC-R2 小文件完成记录清理 ✅
- TC-R2b 刷新自动恢复入队（注入记录）✅
- **真实验证**：20MB 分片上传（complete 挂起捕获中间态）→ IndexedDB 记录 1 条
  （parts=2 已持久化）→ 刷新中断 → 记录保留 → 重选同一文件续传完成 ✅
- 服务端 uploaded_parts 实测：20MB→{1,2}、40MB→{1,2,3}、9MB→{1} ✅

### 关键文件
- 新增：`web/src/utils/resume-store.ts`、`hooks/useAutoResume.ts`
- 修改：`web/src/utils/uploader.ts`（三级续传：IndexedDB→服务端→localStorage）、
  `pages/FileBrowserPage.tsx`（挂载 useAutoResume）
- 服务端：`services/file.service.ts`、`routes/files.ts`

## [v1.0.13] - 2026-08-25

### 长耗时上传 Token 过期治理（21k 实测 17 文件静默丢失 → 零静默失败）

#### 第一轮：过期前主动续期（源头减少 401 命中）
- `web/src/utils/token-refresh.ts`（新）：解码 JWT exp 记录 tokenExpireAt；60s 定时器检查，
  距过期 ≤10min 主动刷新（access_token 30 分钟有效期 → 每 ~20 分钟自动续期一次，3 小时上传
  无需用户干预）；刷新并发锁（多任务共享单次刷新）；刷新 5s 超时 + 指数退避（1s/2s/4s/8s
  最多 4 次）防 429
- `web/src/hooks/useVisibilityCheck.ts`（新）：切回前台立即检查 Token（后台定时器被节流，不依赖精度）
- `MainLayout` 登录态挂载定时器 + 可见性检测

#### 第二轮：401 纠错 + 队列暂停恢复（Token 过期不丢任务）
- `api/client.ts`：401 → 走新刷新核心；刷新失败不再直接跳登录，改为**暂停上传队列** +
  抛结构化错误 `AUTH_FAILED`
- `store/upload.ts`：任务状态机新增 **`auth-failed`**；`pauseForAuth()` 暂停队列并标记全部
  未完成任务（保留 progress/bytesDone）；`resumeAuth()` 恢复入队（不重置已传进度，
  uploader 断点续传复用已传分片）
- `components/UploadResumeButton.tsx`（新）：登录过期横幅「N 个文件等待继续上传」+
  重新登录/继续上传；登录成功后自动恢复（LoginPage afterLogin 检查 nd_resume_upload）
- `components/UploadQueue.tsx`：auth-failed 显示「登录过期」状态标签；暂停时不自动收起队列
- `utils/metrics.ts`（新）：上传中断埋点 `interrupt_reason=token_expired`（localStorage 持久化）

#### 风险治理（对应方案 R1-R7）
- **R1 双 Token 死锁已排除**：后端 `/api/auth/refresh` 在免鉴权白名单（appRoutes），
  用 httpOnly cookie 的 refresh_token（30 天）验证，不依赖旧 access_token
- R2 429：刷新指数退避 + 60s 最小间隔
- R3 恢复并发：复用并发槽机制（小文件 6/大文件 2），恢复严格限流
- R4 后台节流：切前台主动检测
- R5 渲染卡顿：复用 v1.0.12 渲染裁剪 + 轮询
- R6 关页丢失：本轮接受（UI 提示勿关页），第三轮断点续传解决
- R7 刷新超时独立 5s，不影响上传分片 30s

### 关键文件
- 新增：`web/src/utils/token-refresh.ts`、`utils/metrics.ts`、`hooks/useVisibilityCheck.ts`、
  `components/UploadResumeButton.tsx`
- 修改：`web/src/api/client.ts`、`store/upload.ts`、`components/UploadQueue.tsx`、
  `components/Layout/MainLayout.tsx`、`pages/FileBrowserPage.tsx`、`pages/LoginPage.tsx`

### E2E 验证（`e2e/_token-e2e.mjs`，TC-01/02/03/05 全绿）
- TC-01 401 自动刷新重试：过期 token 触发刷新 → 新 token 写入 → 请求重试 ✅
- TC-02 暂停状态机：pauseForAuth 标记 auth-failed + 暂停 + resumeAuth 恢复调度 ✅
- TC-03 真实上传恢复：登录后上传 2 文件完成 ✅
- TC-05 429 指数退避：首次 429 → 退避重试 → 成功 ✅
- TC-04 切前台检测（代码实现 `useVisibilityCheck`，e2e 通过 `checkTokenOnVisible` 触发验证）
- TC-06 21k 长耗压测（v1.0.12 已实测 3 小时场景，治理后由主动续期覆盖）

## [v1.0.12] - 2026-08-25

### 大文件夹上传性能优化（21380 文件 / 1.37GB 实测驱动）
- **背景**：上传 `E:\python\Projectpython_N\history_lottery`（21k 文件/1.37GB/3195 目录）实测，
  初始速率仅 2.2 文件/s（预计 2.7 小时），多轮剖析定位 4 个瓶颈并修复
- **修复**：
  1. **目录并行创建**：文件夹上传时 3195 个目录从逐组串行 mkdir 改为**按深度分层并行**（限流 12），
     目录准备从数分钟降至 ~3s
  2. **并发槽填满**：文件夹上传一次性 addFiles 上万文件时，只调一次调度泵只会启动 1 个任务；
     改为循环调用填满并发上限（小文件 6 / 大文件 2 动态）
  3. **上传队列渲染裁剪 + 低频轮询**（根治）：此前队列 List 全量渲染 + 每任务状态变化触发
     React 重渲染（万级任务时 O(n) 计算拖垮主线程，上传被渲染饥饿）；改为仅渲染 200 条
     （进行中/失败优先）+ 1s 轮询快照，主线程解放——**500 文件实测 136s(未完成) → 41s(全完成)**
  4. **任务存储 O(1) + FIFO 队列**：zustand tasks 从数组改 Map（更新 O(1)），调度用 FIFO 索引
     避免每次 Object.values 全量扫描；并发上限缓存
  5. 上传完成刷新防抖（500ms 合并，6 文件场景 6 次 GET → 1 次）
- **实测**：500 文件（25 目录）41s 全完成（~12 文件/s）；**21380 文件全量实测：21363 落库
  （99.9%）、3196 目录 3s 建齐、0 失败、约 100 分钟（~4.3 文件/s 稳定）**；
  17 个未落库为 3 小时 token 过期前尾段中断
- 关键文件：`web/src/store/upload.ts`（重构：Map 存储/FIFO 泵/轮询）、`UploadQueue.tsx`（裁剪+轮询）、
  `FileBrowserPage.tsx`（目录并行/刷新轮询）
- 性能脚本：`e2e/_big-folder-upload.mjs`、`e2e/_perf500.mjs`、`e2e/_inpage-fetch.mjs`、
  `e2e/_server-throughput.mjs`、`e2e/_folder-conc.mjs`
- 已知边界：21k 级任务仍有调度开销（~4/s，规模效应）；刷新页面会中断前端驱动的上传（后续可做
  服务端续传）

## [v1.0.11] - 2026-08-25

### 上传性能优化（实测驱动）
- **背景**：用户上传 6 个小文件（2KB 级），审计 init→complete 各 2-2.5s，明显偏慢
- **剖析定位**（浏览器请求级计时）：上传请求本身仅 ~100-300ms/文件；真正浪费在
  ① 前端每个任务完成都触发一次列表刷新（6 文件 → 6 次 GET list+breadcrumb，占 ~1.8s）
  ② BLAKE3 WASM 首次加载 ~100ms+（`createBLAKE3()` 懒初始化）
  ③ completeUpload 内 `statObject` 调用两次（多余 1 次 MinIO 往返）
- **修复**：
  1. 上传完成刷新**防抖合并**（500ms 窗口内多个任务完成只刷一次）→ 6 次刷新降为 1 次
  2. **BLAKE3 WASM 预热**：文件页加载 500ms 后空闲预热 `createBLAKE3()`，首个文件上传不再等待初始化
  3. completeUpload **合并两次 statObject** 为一次（size/etag/versionId 一次取回）
- **实测**（6×2KB 全新内容，浏览器整链路）：请求阶段 ~1.3s 全部完成，列表刷新仅 1 次
  （优化前 6 次）；去重秒传场景 6 文件 init 全部 <500ms + 1 次刷新
- 关键文件：`web/src/pages/FileBrowserPage.tsx`、`web/src/utils/hash.ts`（warmupHash 新增）、
  `server/src/services/file.service.ts`
- 性能脚本：`e2e/_upload-multi-perf.mjs`（多文件请求级时间线）、`e2e/_upload-browser-perf.mjs`（单文件整链路）

## [v1.0.10] - 2026-08-25

### 体验优化（浏览器实测 + 代码审查 32 项整改）

#### API 层（根因修复）
- `api/client.ts`：请求统一 30s 超时（AbortController）+ 网络错误归一化为中文
  （断网/代理错误不再抛英文 `Failed to fetch`）；服务端无 message 时 500 映射为
  "服务暂时不可用"；登录过期跳转前提示"登录已过期，请重新登录"
- 上传/分片失败文案友好化（"上传失败（HTTP xxx），请稍后重试"等）

#### 交互与反馈
- 单文件下载补 try/catch（此前失败静默无提示）；文件下载按钮按选中态动态禁用
  （仅单个文件可下载，选中目录/多选时禁用并 Tooltip 说明）
- 批量删除去掉双重确认（Popconfirm + Modal.confirm → 仅一次确认，可恢复操作）
- 上传队列全部完成后弹**汇总通知**（N 成功/M 失败，失败项保留可重试）
- 文件夹上传时目录创建失败不再静默丢文件：提示"该组文件未加入队列"
- 批量操作 `onOk` 统一 try/catch（失败提示 + 刷新列表）
- MoveModal 执行中按钮 loading + 防重入；树加载失败提示
- 版本回滚加 loading/防重；权限弹窗删除授权补 try/catch
- 回收站保留天数从后端读取（`/trash` 返回 `retentionDays`，不再前端硬编码 30）

#### 权限与校验一致性
- 上传/新建文件夹按钮按目录写权限禁用（此前只读用户点击后才报错）；
  行内菜单 `copy/move` 按 `canWrite` 过滤
- 密码强度校验前端与后端完全一致（≥8 位且字母/数字/符号至少两类）：
  注册/改密/找回 4 处统一复用 `utils/password.ts`
- 新建文件夹输入 `maxLength=255` + trim + autoFocus（超长不再触发后端 400）

#### 注册 / 安全页
- 注册页：验证码按钮 60s 冷却倒计时；CAPTCHA 加载失败显示"点击重试"；
  用户协议链接 `stopPropagation`（打开协议不再误勾选/取消勾选复选框）
- 个人中心：关闭 2FA、下线设备加二次确认；2FA 动态码输入改普通 Input（非密码掩码）
  且限 6 位数字；登录源中文映射（LDAP→LDAP 域账号）；配额不限制时隐藏 0% 进度条
- 忘记密码页：通道加载失败提示 + 重试；加载中禁用发送按钮

#### 分享页（无登录）
- **目录分享面包屑**：后端返回祖先链（仅分享子树内），每级可点击返回上级
  （此前进入子目录后无法返回）
- **目录分享内文件可下载**：`downloadShare` 支持 fileId（校验在分享子树内）
- 网络/服务错误与"分享不存在"区分展示（断网显示"网络连接失败"+ 重试按钮）
- 单文件分享验密按钮 loading

#### 预览
- PDF 渲染显示页数进度；文本/表格预览限 1MB（超出提示下载查看，防大文件卡死）；
  预览下载补 try/catch

### 关键文件
- `web/src/api/client.ts`、`utils/password.ts`（新）、`utils/uploader.ts`
- `web/src/pages/{FileBrowserPage,TrashPage,RegisterPage,LoginPage,ProfilePage,ForgotPasswordPage,ShareViewPage,ResetPasswordPage}.tsx`
- `web/src/components/{UploadQueue,MoveModal,VersionModal,PermissionModal,FilePreview,FileTable}.tsx`
- `server/src/routes/{files,share}.ts`、`services/share.service.ts`

### 实测
- `e2e/_ux-assert.mjs`（体验断言 28 项）+ `e2e/_share-ux.mjs`（分享专项 10 项）全绿
- 回归：回收站批量 105 项、分享目录导航、移动端 375px 无横向滚动

## [v1.0.9] - 2026-08-25

### 安全（注册 / 登录 / 找回 / 会话）
- 新增：自助注册 `/register`（邮箱/手机验证码防恶意注册、算术 CAPTCHA、密码强度、用户协议必选）
- 新增：多方式登录（账号 / 邮箱 / 手机号）
- 新增：账号锁定（连续 5 次登录失败锁定 30 分钟，到期自动解锁）
- 新增：双重认证 2FA（TOTP 扫码绑定，Google/Microsoft Authenticator；登录两步验证）
- 新增：密码找回重置链接（一次性、30 分钟时效、`/reset-password?token=`），重置后吊销全部会话
- 新增：密码历史（最近 5 条不可重复使用）
- 新增：设备管理（会话列表 + 踢下线）与异常登录检测（IP/UA 变化提示）
- 新增依赖：`speakeasy`、`qrcode`（2FA）
- 关键文件：`server/src/services/security.service.ts`、`verification.service.ts`、`captcha.ts`（Redis 化）、
  `auth.service.ts`、`routes/auth.ts`、`password-reset.service.ts`；前端 `RegisterPage/ResetPasswordPage/LoginPage/ProfilePage`

### 修复
- 注册页"用户协议"：点击不再弹一次性 message 提示，改为**受控 Modal 用户协议阅读界面**
  （含完整条款全文）；Modal 打开时遮罩拦截背景链接，连点多次也不会堆叠多个弹窗
- 关键文件：`web/src/pages/RegisterPage.tsx`
- **回收站批量彻底删除失败**：后端批量接口单次上限 100（防滥用），回收站 >100 项全选时
  一次性提交被 zod 拒绝（400）→ 只能单个删除。修复：前端**分批串行执行**（每批 ≤100），
  回收站任意数量可一次"彻底删除"；文件页批量删除/移动/复制同样分批（`chunkedTargets`）
- 批量操作失败容错：`onOk` 补 try/catch（失败提示 + 刷新列表），避免确认弹窗卡死无反馈
- 实测：造 105 个目录（>100 上限）→ 文件页全选删除 → 回收站 105 项全选彻底删除 → 清空 ✅
- 关键文件：`web/src/pages/TrashPage.tsx`、`web/src/pages/FileBrowserPage.tsx`

### 新增（文件夹打包下载）
- 目录操作菜单支持**文件夹 zip 打包下载**（`GET /files/:id/download-dir`，流式打包）：
  保留目录结构（zip 内顶层为文件夹名，物化 path 的 id 链转换为名字链）、空目录保留、
  文件数上限 10000；前端 fetch Blob 保存
- 新增依赖：`archiver`（容器内为对象导出 `{ZipArchive}` 新 API，非旧版函数）
- 实测：完整用户流程（登录→单/多文件/文件夹上传→列表验证→文件下载内容哈希一致→
  文件夹 zip 解压结构与内容一致）18 项全绿

### 数据库
- `users` 新增 `failed_attempts/locked_until/twofa_secret/twofa_enabled/password_updated_at`
- 新增表 `verification_codes`（注册验证码）、`password_history`（密码历史）
- `password_reset_codes` 新增 `link_token`（重置链接）

## [v1.0.8] - 2026-08-24

### 新增
- 忘记密码：邮箱/短信验证码找回（`RESET_MAIL_*` / `RESET_SMS_WEBHOOK` 配置，QQ 邮箱实测）

## [v1.0.7] - 2026-08-24

### 性能
- k6 500 并发压测：健康检查 577→665 RPS、登录态列目录 255→**351 RPS**（P95 3.78→2.19s）
- 新增 **cluster 多进程**（`WEB_CONCURRENCY` 默认 min(4,CPU)；主进程引导+定时任务单实例，worker 崩溃自动拉起）
- `PG_POOL_MAX` 连接池可配（cluster 下每 worker 均分）
- 压测脚本：`deploy/scripts/k6/{health,static,api-list}.js`

## [v1.0.6] - 2026-08-24

### 移动端适配（375px 实测 14/14）
- `useIsMobile` 响应式：侧边栏折叠浮层+汉堡、表格精简列（隐藏所有者/时间）、上传队列全宽、
  登录/分享卡片自适应、过滤框全宽

## [v1.0.5] - 2026-08-24

### 修复
- 分享页无登录访问含图片目录时 ThumbImg 触发需登录 preview API → 401；新增 `showThumbs` 开关，
  分享页关闭（无痕浏览器实测无 401）

## [v1.0.4] - 2026-08-24

### 新增 / 优化
- 监控告警：Redis 内存 / 缓存命中率 / 定时任务执行状态（`monitor_job_runs`/`monitor_alerts` 表，
  每 5 分钟自检；`/api/health` 附摘要、`/api/monitor/*` 端点）
- 告警通知渠道：钉钉 / 企业微信 / 通用 webhook / SMTP 邮件（`ALERT_*` 配置；本地接收器端到端验证）
- 前端：首屏路由懒加载 + 弹窗/预览按需加载（首屏 JS 减 840KB+）、上传哈希进度/速率/自动收起、
  列表本地过滤/排序/大目录虚拟滚动、**服务端分页**（10 万文件目录）、图片缩略图懒加载（ThumbImg）
- 回收站自动清理完善：审计日志留痕（`trash_purge_file/dir`）、执行时间调整为凌晨 3 点
- nginx 反代动态解析（resolver+变量），根治 server 重建后 502
- Redis 热点缓存：目录列表（`dir:{org}:{user}:{dir}`，TTL 30s、写操作失效）+ 分享元信息
- 数据库查询优化：pg_trgm GIN（文件名模糊搜索 8-49x）、配额 `idx_files_owner_size`（88x）、
  删冗余 `idx_files_dir`
- 性能压测首轮（单进程基线）：health 577 / 静态 6774 / 列目录 255 RPS

## [v1.0.3] - 2026-08-23

### 修复（QA 全功能测试 73/73，docs/QA-测试报告.md）
- P1 前端上传任务 N² 膨胀 → 逐文件入队
- P1 并发同名 complete 竞态 500 → 事务回滚重试
- P2 孤儿池存储泄漏 → 缓存+GC 设计（池保留 30 天）
- P2 文件名 URL 编码穿越（%2F/%5C/%00/CRLF）→ 二次校验 + 控制字符拦截
- P3 预览 Content-Type 依赖上传 mime → 按扩展名强制
- P3 大对象哈希读取并发 3→6 路（104→129 MB/s）

## [v1.0.2] - 2026-08-22

### 优化
- MinIO 单盘部署（4 盘纠删码仅多块独立物理盘有意义）
- 两级段缓存（`segmentCache`：段数据 LRU + 段哈希缓存，`HASH_CACHE_MB`）

## [v1.0.1] - 2026-08-21

### 新增
- BLAKE3/B3SEG 内容哈希全链路（前后端/测试三端一致）：`BLAKE3(BLAKE3(seg0)||...)`，8MB 分片
- 去重秒传（不限大小）：共享引用 + 后台验证缓存 + 池注册/GC

## [v1.0.0] - 2026-08-20

### 初始版本
- 企业多租户网盘：组织/部门/用户、RBAC 目录权限、个人空间/部门文件夹/公共盘
- 大文件分片断点续传、版本管理、回收站、元数据搜索、内网分享（密码/有效期/次数）
- 三级存储配额、全量审计日志、CSRF/双令牌会话、LDAP 占位
- docker-compose 一键部署 + 离线交付支持

---

## 配置变更速查（新增环境变量）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `WEB_CONCURRENCY` | min(4,CPU) | cluster 进程数，1=单进程 |
| `PG_POOL_MAX` | 60 | PostgreSQL 连接池上限 |
| `MONITOR_REDIS_MEM_PCT` | 80 | Redis 内存告警阈值（%） |
| `MONITOR_HITRATE_MIN_SAMPLE` | 200 | 命中率评估最小采样量 |
| `MONITOR_CHECK_CRON` | `*/5 * * * *` | 监控自检频率 |
| `ALERT_DINGTALK_WEBHOOK/SECRET` | 空 | 钉钉告警机器人 |
| `ALERT_WECOM_WEBHOOK` | 空 | 企业微信告警机器人 |
| `ALERT_WEBHOOK_URL` | 空 | 通用告警 webhook |
| `ALERT_SMTP_*` / `ALERT_MAIL_FROM/TO` | 空 | 告警邮件 |
| `RESET_MAIL_HOST/PORT/SECURE/USER/PASS/FROM` | 空 | 密码找回邮箱通道 |
| `RESET_SMS_WEBHOOK` | 空 | 密码找回短信网关 |

> 注意：新依赖 `nodemailer`/`speakeasy`/`qrcode` 已进入 `server/package-lock.json`，
> 离线交付打包请重新执行 `deploy/scripts/offline-package.*`（见 docs/05-离线交付指南.md）。
