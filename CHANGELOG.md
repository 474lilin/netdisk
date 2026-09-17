# 升级日志（CHANGELOG）

> 本文件按里程碑记录每次升级的内容、修复与影响面。部署/配置细节见 `docs/02-部署手册.md`，
> 运维排查见 `docs/03-运维手册.md`，续接开发见 `RESUME.md`。
> 格式遵循 Keep a Changelog；版本 `v1.0.x` 为私有化发布序列。

## [v1.1.15] - 2026-09-17

### 新增「清除失败」按钮：一键清掉全部失败任务记录

#### 现场（用户提问：「删除 284 个上传失败的任务及上传到网盘的文件」）
面板上原本只有「重试失败」和「清除已完成」，**没有"清除失败"**——用户面对 284 条失败记录（其中多数是
"目标目录已不存在"与刷新后还原的 `needsFile` 任务）只能一条条点右侧「移除」。
而任务列表本身持久化在浏览器 localStorage（`nd_task_list_v1`），刷新后还会回来，服务端无法代删。

#### 改动
- `web/src/store/upload.ts`：新增 `clearFailed()`，一次移除 `error` / `auth-failed` / `canceled` 三类
  "已结束且未成功"的任务，返回移除条数；持久化订阅自动同步 localStorage（刷新不再复活）。
- `web/src/components/UploadQueue.tsx`：面板顶部新增**「清除失败」**按钮（danger 样式，无条件禁用逻辑：
  `totalFailed + totalCanceled === 0` 时禁用）；紧凑面板里新增块状按钮**「清除失败（N）」**；
  清除后提示"已清除 N 条失败任务记录（网盘里已上传的文件不受影响）"。
  注：清除只影响**任务记录**，不会删除网盘里已上传的文件（避免误删数据）。

#### 验证
`e2e/_test-clear-failed.mjs`（新增，真实浏览器）：注入 **284 条**失败/取消任务 + 3 条已完成任务 →
刷新还原 → 断言失败计数 284 → 点「清除失败」→ **失败清零、已完成 3 条保留、localStorage 同步为 3 条** →
再刷新确认不复活、无 JS 异常。**全部通过 ✅**

## [v1.1.13] - 2026-09-17

### 修复「刷新浏览器后，失败的上传任务点重试没反应」

#### 现场（用户提问：「上传失败的任务还是需要不断地点击重试？刷新浏览器后失败任务不能重新上传，
点『重试』和『重试失败』两个按钮均没有反应」）
用户描述的是**两个独立问题叠加**，实测把两者都定位到了：

**问题一（用户没提，但是真凶）：存储盘写满，MinIO 拒绝一切写入**
- `N:` 盘 200GB **100% 占满**（仅剩 6MB）；而 MinIO 的数据目录正是宿主机 bind mount
  `N:\minio-data-single` → 容器 `/data1`（`minio server /data1`）。
- 服务端日志近 7 天 **2252 次** `XMinioStorageFull: Storage backend has reached its minimum
  free drive threshold`，全部发生在 `initUpload`（`POST /api/files/upload/init`）。
  → **任何上传都会在第一步就被存储后端拒绝**，这才是「上传任务失败了一部分」的根因。
- MinIO 侧统计：`137 GiB Used / 31634 Objects / 52687 Versions / 18322 Delete Markers`，
  而数据库里存活文件只有 2587 个（67GB，其中 58GB 在去重池）——
  空间主要被**历史版本 + 删除标记**占据（版本控制自 8/26 数据恢复起一直开着）。
- 处置（经用户确认）：把 14.5GB 陈旧备份目录 `N:\minio-data-backup-20260826` 移到 `E:`（不删除）+
  清理 MinIO 未完成分片上传、非当前版本与删除标记；清理前已 `pg_dump` 备份到 `E:\netdisk-backups\`。

**问题二（用户点的那两个按钮）：刷新后重试是「静默空操作」**
- 任务列表持久化在 localStorage（`nd_task_list_v1`），刷新后由 `hydrateTaskList()` 还原；
  但 **File 对象无法持久化** → 还原出来的上传任务 `file` 为 `undefined`。
- 旧实现点「重试」/「重试失败」会把这些任务重新置为 `queued` 并 `pump()`：
  `runUploadTask` 第一行 `resumeKey(dirId, file.name, file.size)` 读 `file.name` **抛 TypeError**，
  被 catch 后立刻写回 `error` —— 几十毫秒内状态来回跳一次，
  用户看到的就是「点了没反应」（旧文案还错误地宣称「≤8MB 的小文件会自动续传」）。
- 另一个隐性死路：若队列处于 `paused`（登录过期/目录失效自动暂停），`retryTask` 完全不解除暂停，
  任务被置为 `queued` 后永远不启动，同样是「没反应」。

#### 修复内容
1. **缺文件的任务不再假装重试**：`UploadTask.needsFile` 标记 + `NEEDS_FILE_MSG` 文案；
   `pump()` 增加防御（无本地 File 的上传任务绝不下发给执行体）；
   任务行上的「重试」按钮换成 **「重新选择文件」**（文件夹图标）。
2. **选回文件 → 真断点续传**：新增 `attachFile(id, file)`，
   校验**文件名 + 大小**（续传记录按「目录+文件名+大小」索引，不一致无法续传）并给出明确错误；
   同时持久化 `lastModified`，修改时间不一致时提示"内容若已改动请移除后重传"。
   选回后上传引擎命中 IndexedDB/服务端分片，**只补缺失分片**（实测复用刷新前的同一个 sessionId）。
3. **「重试失败」批量按钮**：先弹文件选择框（多选），按 名称+大小 自动配对；
   剩余没配上的用 message 列名提示，再去重试那些"有本地文件"的普通失败任务。
4. **`retryTask` / `retryAllFailed` 解除队列暂停**（登录过期 `token_expired` 除外，需先重新登录），
   不再出现"置为排队但永不启动"。
5. **小文件（≤8MB）自动续传不再产生重复任务**：`hydrateTaskList` 会用 IndexedDB 里保存的 File
   直接续传原任务；`useAutoResume` 跳过任务列表里已存在的同一文件（旧实现会额外新建一条重复任务）。

#### 顺带修掉的「断点续传静默失效」缺陷（测试中实测发现）
`web/src/utils/resume-store.ts`（IndexedDB 断点记录）有两处真实缺陷，会让整个续传能力
**静默降级到 localStorage**（File 引用无法序列化 → 刷新后小文件不再自动续传、断点信息不完整）：
1. **固定版本号打开数据库**：历史实现一律 `indexedDB.open('nd-resume-db', 1)`；
   一旦库版本被升过（自愈/其它工具），之后每次打开都会 `VersionError` → 永久降级。
   修复：改为**不带版本号**打开（沿用现有版本），仅在自愈升版本时才显式指定版本。
2. **库存在但缺少对象存储时无法自愈**：同名库若被其它工具创建过（无 `sessions` 存储），
   只靠 `onupgradeneeded` 永远补不上（事务一直 `NotFoundError`）。
   修复：检测到存储缺失时**升一个版本重开**强制重建（最多 3 次），并打印 `[resume]` 告警。
3. 新增调试钩子 `window.__resumeDebug()`（与 `window.__uploadStore` 同风格）：
   现场排查"刷新后为什么不续传"时可直接看 `idbUnavailable / dbVersion / pendingWrites`。

实测（`e2e/_probe-resume-idb.mjs`）：先注入「v1 且无 sessions 存储」的污染库，再上传 24MB；
修复前 `idbUnavailable=true`、记录写进 localStorage（`ls=1`）；
修复后 `dbVersion=2 / idbUnavailable=false`，分片断点记录正常写入 IndexedDB（`ls=0`），完成时自动清理。

#### 验证
- `e2e/_ui-retry-after-refresh.mjs`（新增，真实浏览器 + 真实刷新）：
  2 个 40MB + 1 个 6MB 文件上传中刷新页面 → 大文件标记「需要重新选择文件」→
  直接调 `retryTask` 不再排队（回归断言）→ 点任务上的「重新选择文件」选回同一文件续传完成 →
  点「重试失败」弹框选回文件续传完成 → 小文件自动续传且只有一条任务 → 服务端落库大小一致。
- `e2e/_probe-resume-idb.mjs`（新增）：断点记录写入 IndexedDB 的时间线（含污染库自愈场景）。
- `e2e/_verify-storage-integrity.mjs`（新增）：清理 MinIO 历史版本后的**存储完整性核验**——
  2587 个存活文件逐个校验对象可读（2586 通过，1 个是测试脚本 BOM 造成的接口 500，与数据无关）、
  抽样 20 个完整下载并按 **B3SEG** 复核哈希与大小（20/20 一致，含 369MB 视频）。
  注意：数据库里名为 `sha256` 的列实际存的是 **B3SEG 内容哈希**（`BLAKE3(BLAKE3(seg0)||...)`），
  用标准 SHA-256 复核会得出"全都不一致"的错误结论。
- 关键文件：`web/src/store/upload.ts`、`web/src/components/UploadQueue.tsx`、
  `web/src/utils/filePicker.ts`（新增）、`web/src/utils/resume-store.ts`（加固）、
  `web/src/hooks/useAutoResume.ts`

#### 运维教训（已写入 `RESUME.md`）
MinIO **版本控制开着**时，「删除文件」只是打删除标记，空间不会释放；
`mc rm --recursive --force --versions --non-current` 才能回收。
存储盘剩余空间低于 MinIO 的 `minimum free drive threshold`（默认 5%）后，
**所有上传都会失败**（`XMinioStorageFull`），必须优先看磁盘。

## [v1.1.12] - 2026-09-14

### 网盘功能全面体检 + 修复「任务面板盖住行内下拉菜单」

#### 体检方式
新增 `e2e/_ui-smoke.mjs`：真实浏览器（Playwright + 本机 Edge）+ 真实后端，端到端跑核心功能，
只操作自建测试目录，结束自动清理（删目录 + 撤销分享链接）。**结果：33 项全部通过 ✅**

| 模块 | 结果 |
|---|---|
| 登录 / 首屏列表 / 面包屑 / 左侧空间导航 | ✅ |
| 新建文件夹（UI + `Modal.confirm`） | ✅ |
| 上传（小文件直传 + 20MB 分片，任务列表可见） | ✅ 2/2 完成 |
| 文本预览（内容一致） | ✅ |
| 重命名 | ✅ |
| 顶栏搜索（跳转结果页命中） | ✅ |
| 分享链接（生成 + `/api/shares/links`） | ✅ |
| 下载：文件（落盘 43B）/ 文件夹 zip（落盘） | ✅ 均进入任务列表并完成 |
| 删除 → 回收站可见 → 恢复 → 回到列表 | ✅ |
| 接口：健康 / 配额 / 组织树 / 用户 / 审计 | ✅ 全 200 |
| 页面：回收站 / 我的分享 / 管理台 / 个人中心 | ✅ 均正常渲染 |
| 前端：无 pageerror、无 console error、刷新后任务列表仍在 | ✅ |

#### 体检中发现并修复的真实 bug
- **悬浮任务面板的 z-index 高于 antd 弹层**（1200 > dropdown 1050）：任务列表显示时，
  它会盖住文件行的「更多」下拉菜单——点菜单项实际点到了面板上，导致**重命名/分享/下载/删除等
  行内操作失效**（体检中重命名弹窗打不开即此因；当时页面无任务所以此前测试未暴露）。
  修复：面板/胶囊 z-index 降为 **900**（低于 modal 1000 / dropdown 1050 / tooltip 1070，
  高于页面内容），弹层不再被遮挡。

#### 回归（全部通过）
`_upload-resilience.ts` 30/30 · `_ui-hash-check.mjs` · `_ui-float-download.mjs` ·
`_ui-dir-gone.mjs` · `_ui-upload-flow.mjs` · `_ui-dock-check.mjs`

#### 关键文件
- `web/src/styles.css`（任务面板/胶囊 z-index 修正）
- `e2e/_ui-smoke.mjs`（新增：网盘功能全量体检脚本）

## [v1.1.11] - 2026-09-14

### 「上传目标目录已被删除」导致 404 风暴：立即失败 + 整批清理

#### 现场（用户提问「我的网盘上传出现了什么状况？是没有 Ctrl+F5 缘故吗？」）
用 nginx 访问日志 + 审计 + MinIO 对账定位，**不是 Ctrl+F5 的问题**：

| 证据 | 结论 |
|---|---|
| 2 分钟内 **291 次** `POST /api/files/upload/init → 404`，且 **0 次 mkdir** | 客户端在往**已不存在的目录**上传 |
| 那 9 个 dirId 现在全部 `NOT_FOUND: 目录不存在` | 目标目录确实已被删除 |
| 回收站 1013 条，含 `0554.王道训练营C++62期`、`资料`、`day05/day07` | 有一份课程目录树被删除/清空 |
| `我的空间/0554.王道训练营C++62期` 仍在（8 个子目录） | 现存的那份是好的，上传本身没坏 |

根因：目录被删后，队列里（含 IndexedDB 自动恢复的）任务仍指向旧 dirId；
而旧实现把 404 归类为「可重试」→ **每个任务重试 4 次**，于是 291 次无效请求。

#### 修复
- **目录失效立即失败**：`upload/init` 返回 404「目录不存在」/403「无权限」时不再重试，
  提示「目标目录已不存在（可能已被删除或移动）：请重新选择目录后再上传」，
  并**清理该文件的断点记录**（否则下次页面加载自动恢复又会白试一遍）
- **只对瞬时故障重试**（`isTransientError`）：init / complete / presign 的重试只针对
  网络、超时、429、5xx；404/403 不再重试
- **按目录计数自动暂停**：同一目录连续 3 次失效 → 该目录下**所有排队任务直接标记失败**
  （不再发请求）+ 队列暂停，并在面板给出告警：
  「上传目标目录已不存在，队列已暂停」+「仍然继续」/「清除这些失败任务」
- **整批清除**（`dismissDirMissing`）：一键移除该目录下的排队/在传/失败任务并解除暂停——
  否则清除失败项后，同目录的排队任务会再次失败并重新触发暂停（循环）
- 顺带修复：任务被移除后，迟到的进度/结果回调会**用 patch 重建出"幽灵任务"**（update 增加存在性校验）

#### 验证（真实浏览器 + 逻辑层）
- `e2e/_ui-dir-gone.mjs`（新增，端到端复现该场景）：40 个文件上传中删除目标目录 →
  识别 dir_missing ✅ / 队列自动暂停 ✅ / 提示明确 ✅ / **init 请求 291 → 14** ✅ /
  告警与「清除这些失败任务」可用且清完队列恢复、列表随任务数正确显隐 ✅ / 无 pageerror ✅
- `e2e/_upload-resilience.ts`：新增用例「目标目录不存在」→ **30/30 通过**
  （校验：只尝试 1 次、不可重试、提示可读、断点已清理）
- 回归：`e2e/_ui-float-download.mjs`（悬浮列表 + 上传/下载 + 刷新持久化）全部通过 ✅

#### 关键文件
- `web/src/utils/retry.ts`（`isTransientError` / `isDirGoneError`）
- `web/src/utils/uploader.ts`（目录失效快速失败 + 清断点；init/complete/presign 仅瞬时重试）
- `web/src/store/upload.ts`（按目录计数暂停、`dismissDirMissing`、幽灵任务防护）
- `web/src/components/UploadQueue.tsx`（目录失效告警与整批清理入口）

## [v1.1.10] - 2026-09-14

### 任务列表改为「悬浮在网盘之上 + 永不消失」；同列表支持上传与下载

#### 用户反馈
「点了一下网盘界面，上传列表又消失了？我要上传下载任务列表悬浮在网盘界面，
不会因为我操作网盘这个任务列表就不显示」

#### 定位到的两个真实原因（真实浏览器 + 逐步操作复现）
1. **整页重载会清空内存队列**：点击后若发生文档级导航（浏览器刷新/前进后退），
   SPA 内存里的任务列表被整体丢弃 → 列表"凭空消失"（旧实现无任何持久化）
2. **升级后浏览器仍在跑旧包**：`deploy/nginx/nginx.conf` 只给带 hash 的静态资源设了 7 天缓存，
   **index.html 没有缓存头** → 用户看到的是旧版本行为（"修复没生效"的假象）

#### 修复与新增
- **默认形态改为「悬浮浮层」**（用户诉求）：`position: fixed` 浮在网盘界面之上，
  可拖动标题栏移动（位置持久化），可最小化为浮层胶囊；
  **不响应任何"点击外部/失焦/Esc"事件**，操作网盘、切目录、开预览、切页面都不会消失
- **任务列表持久化**（`localStorage: nd_task_list_v1`，节流 500ms 写）：
  刷新/前进后退后列表仍在；传输中被重载打断的条目标记为「已中断」并给出可执行提示：
  - 下载：可用持久化的 `fileId/isDir` 重建执行体，**一键「重新下载」**
  - 上传：提示重新选择文件（≤8MB 小文件仍由 IndexedDB 自动续传）
- **同一列表管理上传 + 下载任务**：新增 `kind='upload' | 'download'`；
  下载走 `utils/downloader.ts` 流式读取（带实时进度、可取消、可重试、成功后落盘），
  并发上限 2，与上传队列互不影响（暂停/继续只作用于上传）；
  单文件下载走 MinIO 预签名直连，文件夹走 `/download-dir` zip 流；
  >1.5GB 自动交还浏览器原生下载（避免把 GB 级内容读进内存）
- **形态可切换**：面板标题栏一键在「悬浮 / 停靠右侧（占位，不遮挡列表）」之间切换并持久化
- **nginx 缓存修正**：`index.html` 设为 `no-store, no-cache, must-revalidate` + `expires -1`，
  带 hash 的资源仍长期缓存 → 以后升级不会再被浏览器缓存"卡住"

#### 验证（真实浏览器 Playwright + 本机 Edge）
`e2e/_ui-float-download.mjs`：**全部通过**
- 上传中/完成后，8 步操作（表头/空白/面包屑/搜索框/Esc/切目录/切页面/浮层外多点）列表始终存在
- 完成后等 3.5s 列表仍在（不再自动隐藏）
- **整页刷新（F5）后列表仍在**，任务条目被还原
- 真实 UI 路径下载文件 → 出现「下载中」任务 → 完成 → **30MB 落盘**（浏览器下载事件）
- **下载中途刷新 → 条目仍在 → 点「重新下载」成功落盘**
- 下载文件夹 zip 进列表并落盘；悬浮 ⇄ 停靠 切换正常；无 pageerror
- 线上资源标记：v1.1.5 / v1.1.6 / v1.1.7 / v1.1.9 / v1.1.10 全部命中 ✅

#### 关键文件
- `web/src/components/UploadQueue.tsx`（悬浮浮层/胶囊、下载行、形态切换、常驻保证）
- `web/src/store/upload.ts`（下载任务与调度、任务列表持久化 hydrateTaskList、panelMode）
- `web/src/utils/downloader.ts`（新增：流式下载 + 进度 + 落盘 + 超大文件直连）
- `web/src/pages/FileBrowserPage.tsx`（文件/文件夹下载接入任务列表）
- `web/src/components/Layout/MainLayout.tsx`（挂载时还原任务列表）
- `deploy/nginx/nginx.conf`（index.html no-store）
- `e2e/_ui-float-download.mjs`（新增验证脚本）

## [v1.1.9] - 2026-09-14

### 修复「点一下网盘界面，上传就隐藏/暂停了，暂停按钮也找不到」

#### 现象与真实原因（真实浏览器逐步复现）
用户反馈：点一下网盘界面，上传面板消失且上传像被暂停，暂停/继续按钮也找不到。

逐步实验（上传中依次点击表头/空白/面包屑/侧边栏/文件夹/文件行/搜索框）：

| 操作 | 结果 |
|---|---|
| 各类**点击** | 任务照常 uploading、面板照常 360px —— 点击本身**不会**隐藏或暂停 ❌非因点击 |
| **按 Esc**（例如关闭预览/弹窗） | 面板立刻收成 48px 图标细栏 → 用户看到「上传隐藏了」 |
| 随后在右边缘随手一点 | 极易命中细栏里**没有文字的小图标**（⏸）→ 真的触发 `pauseAll` → 「上传暂停了」 |

即：**Esc 收起 + 图标细栏（按钮无文字、命中区小）** 共同造成「自己没按过暂停却暂停了」。

#### 修复
- **取消 Esc 收起**：不再监听全局 Escape（原来按 Esc 关预览时会把上传栏一起收起）；收起只由显式按钮触发
- **收起态改为 196px 带文字的紧凑面板**（替代 48px 图标细栏）：
  - 显示「已完成 n/n · 百分比」+ 进度条
  - 「全部暂停」「全部继续」**常驻文字按钮**（无可操作任务时置灰而非消失），另有「重试失败」「清除已完成」
  - 位置与命中区更大，不会再误触
- **暂停/继续带明确反馈**：点「全部暂停」弹出提示「已暂停 N 个上传任务（已传分片保留）。点『全部继续』或顶栏『上传任务』可恢复。」——不再出现"静默暂停"
- 顶栏「上传任务」入口（`n/n · 百分比`）继续作为任意页面的固定开关

#### 验证
- `e2e/_ui-dock-interaction.mjs`（新增，逐步点击路径排查）：Esc 不再收起 ✅；收起态可见「全部暂停（1） / 全部继续」文字按钮 ✅；
  点击后确实暂停并弹出提示 ✅；收起态可一键继续 ✅
- `e2e/_ui-dock-check.mjs`：收起态宽度/文字按钮断言更新为 196px 紧凑面板 ✅
- `tsc --noEmit` 通过；已重建 web 镜像并核实线上标记 ✅

#### 关键文件
- `web/src/components/UploadQueue.tsx`（移除 Esc 收起、紧凑面板、暂停/继续提示）
- `web/src/styles.css`（`.upload-dock__mini` 样式）

## [v1.1.8] - 2026-09-14

### 「上传偶发失败、点重试又能成功」根因修复：并发哈希串号（P0 数据正确性）

#### 根因（真实浏览器复现 + 服务端日志佐证）
- 现象：并发上传多个 **>8MB** 文件时偶发 `400 文件哈希校验失败，已终止上传`（界面显示「请求失败，请稍后重试」），
  单独重试同一个文件又能成功 —— 与用户最初反馈完全一致
- 定位：客户端 BLAKE3 Worker 池（`web/src/utils/hash.ts`）用「**分片序号**」当请求关联 ID：
  - 多个文件并发哈希时共用同一个 worker 池，且同一 worker 上注册的消息监听器会收到**每一条**回复
  - 于是文件 A 的 seg0 回复，会把同样在等 seg0 的文件 B 一并 resolve → **两个文件的哈希互相串号**
  - 客户端用错误哈希 init/complete → 服务端 `completeUpload` 重算真实 BLAKE3(B3SEG) 不一致 → 400 终止
  - 为什么只有大文件：≤8MB 走主线程单例哈希（`init/update/digest` 无 await，原子）；
    >8MB 才走 worker 池 → 失败必然出现在大文件（含用户之前 152–219MB 的视频）
- 修复：请求 ID 改为**全局单调递增**（与分片序号解耦，严格一问一答）；
  新增测试钩子 `window.__ndFileHash` 供并发哈希正确性回归
- 防御层：complete 报「哈希校验失败」也按**可重试**处理（重试会重新计算哈希并重开会话上传）

#### 暂停后「全部继续」卡死（永久停在「上传中」）
- 根因：暂停只中断了分片 PUT（XHR），**没有中断 init/presign/complete 等 JSON 接口** →
  服务端其实已完成合并并落库，客户端却因任务被标记为 suspended/paused 而丢弃「已完成」结果 →
  恢复后再次 complete 撞 MinIO `NoSuchUpload`（500）→ 任务永久卡住
- 修复（三层）：
  1. `api()` 与 `uploadInit/presignParts/completeUpload` 支持 `AbortSignal`：暂停同步中断接口调用
  2. 服务端 complete **幂等自愈**：`NoSuchUpload` 且对象已存在且大小与声明一致 → 视为已完成继续落库（不再 500）
  3. 客户端 complete 失败自愈：用 `init` 校验内容是否已落库（命中去重即成功）；
     队列改为「**先判成功、再判暂停**」——真实完成的结果不再被暂停标记吞掉
- 附带修复：`complete` 缺少分片清单时**不再 abortMultipart**（避免销毁仍可恢复的分片）；
  服务端占位分片（`'server'`，无 ETag）改为**必须真实重传**（旧实现把它们当已完成 → complete 空清单/永久卡死）

#### 右侧常驻栏自适应宽度
- 小窗口（≤1280px）下 360px 常驻栏把文件列表挤到 256px → 宽度改为
  `min(360, max(240, 视口宽 - 220 左导航 - 420 文件区))`：900px 窗口下列表由 256px → 356px

#### 验证（真实浏览器 Playwright + 本机 Edge）
| 测试 | 结果 |
|---|---|
| `e2e/_ui-hash-check.mjs`（并发哈希 vs 串行基准，3 文件 + 8 文件压力） | ✅ 全部一致 |
| `e2e/_ui-upload-flow.mjs`（单文件 40MB / 暂停→继续 / 立即继续 / 3 文件并发） | ✅ 4 场景全绿，零 4xx/5xx |
| `e2e/_ui-dock-check.mjs`（占位布局/命中测试/4 种窗口宽度/细栏/顶栏入口/全部暂停恢复） | ✅ 全绿 |
| `e2e/_upload-resilience.ts`（逻辑层 25 项） | ✅ 25/25 |
| `tsc --noEmit`（web + server） | ✅ |

#### 关键文件
- `web/src/utils/hash.ts`（根因：worker 请求 ID 全局唯一）
- `web/src/api/client.ts`、`web/src/api/index.ts`（上传接口 AbortSignal 支持）
- `web/src/utils/uploader.ts`（complete 自愈、占位分片重传、哈希错误可重试）
- `server/src/services/file.service.ts`（complete 幂等自愈 + 不销毁分片会话）
- `web/src/store/upload.ts`（先判成功再判暂停）
- `web/src/components/UploadQueue.tsx`（常驻栏宽度自适应）

## [v1.1.7] - 2026-09-14

### 上传任务列表改为「固定在页面右侧的常驻栏」（占位式，不覆盖文件列表）

#### 变更
- 桌面端不再用悬浮卡片，改为**右侧常驻栏**（antd `Sider`，宽 360px）：占用布局宽度、
  与左侧空间导航对称，**完全不覆盖文件列表**；无任务时整栏消失，内容区自动回满宽
- **收起态为 48px 细栏**：进度百分比 + 快捷「全部暂停/全部继续/清除已完成」+ 失败数红标，
  点击即可展开——列表始终“在”，不会因点击页面而消失
- 移动端不变：底部非模态面板（无遮罩）+ 进度胶囊（右栏会挤占手机屏幕，故不做停靠）
- 顶栏固定入口（`UploadTaskButton`：完成数/百分比 + 角标）保留，任意页面一键展开/收起
- `UploadQueue` 由懒加载改为静态引入（常驻栏参与布局，避免懒加载导致宽度跳动）：
  主包 gzip 37.5KB → 41KB；同时移除 v1.1.5 的浮动拖拽/定位逻辑（`nd_upload_panel_pos`）与拖拽手柄样式

#### 验证
- `npx tsc --noEmit` 通过；`e2e/_upload-resilience.ts` 25/25 通过
- 重建 web 镜像并重启后线上核对：`node e2e/_frontend-version.mjs`
  → 主包 `index-DxFyJnlz.js`、样式 `index-BcZWoLMb.css`，
  v1.1.5 / v1.1.6 / v1.1.7（含 `.upload-dock` / `.upload-dock__rail` 样式）标记全部命中 ✅
- 健康检查 `{"ok":true,"db":true,"minio":true}` ✅

#### 关键文件
- `web/src/components/UploadQueue.tsx`（桌面端 Sider 常驻栏 + 细栏；移动端底部面板）
- `web/src/components/Layout/MainLayout.tsx`（`<Layout hasSider>`：内容区 + 右侧常驻栏）
- `web/src/styles.css`（`.upload-dock` / `.upload-dock__rail` / 常驻栏内列表滚动）

## [v1.1.6] - 2026-09-14

### 上传任务列表常驻（不再出现「点一下网盘界面，任务列表就消失」）

#### 问题
- 全部任务完成后面板 2.5s 自动隐藏；收起/关闭后只剩一个小胶囊，且没有固定入口，
  用户点了网盘页面/切换目录后找不到任务列表（体验上等同「列表消失」）。

#### 修复
- **不再自动隐藏**：任务存在期间，列表始终以「面板」或「进度胶囊」形式存在；
  收起（`×`）/ 最小化（`—`）/ `Esc` 只切换形态，**不丢失列表**
- **顶栏固定入口**：新增 `UploadTaskButton`（登录后常驻）——显示 `已完成/总数 · 百分比`、
  进行中数量角标（失败为红色角标），点击即可展开/最小化任务列表；任何页面都能打开
- **全部完成后保留列表**：胶囊显示「上传完成 n/n · 100%」，面板底部提示「点『清除已完成』收起」；
  列表只在用户点「清除已完成」清空任务后才消失
- 面板最小化状态从组件内部上移到 store（`panelCollapsed` + `setPanelCollapsed`/`togglePanel`）并持久化，
  顶栏入口与新任务入队都能正确控制展开形态

#### 验证
- `npx tsc --noEmit` 通过；`e2e/_upload-resilience.ts` 25/25 通过（队列/暂停/重传逻辑未受影响）
- `docker compose build web` + 重启后线上资源核对：
  `node e2e/_frontend-version.mjs` → 主包 `index-DtJEeCtC.js` / chunk `UploadQueue-nDUoMJcM.js`，
  v1.1.5 与 v1.1.6 标记全部命中 ✅

#### 关键文件
- `web/src/components/UploadTaskButton.tsx`（新增，顶栏固定入口）
- `web/src/components/UploadQueue.tsx`（常驻列表：取消自动隐藏、胶囊完成后保留）
- `web/src/store/upload.ts`（`panelCollapsed` + `togglePanel`）
- `web/src/components/Layout/MainLayout.tsx`（顶栏挂载入口）

## [v1.1.5] - 2026-09-14

### 上传体验修复：偶发「请求失败，请稍后重试」自愈 + 暂停/继续 + 上传面板不再遮挡页面

#### 问题与根因
- **现象 1**：上传偶发提示「请求失败，请稍后重试」，手动点右侧「重试」又能成功 —— 属**瞬时故障无自愈**：
  网络抖动 / 网关 5xx / 429 限流 / 传输假死 / **分片签名 URL 过期（403）**（旧实现一次性签全部
  分片 URL，长耗时大文件后段 URL 超过 `PRESIGN_EXPIRY`=1h 后必然 403）→ 任务直接置失败。
- **现象 2**：无法暂停单个上传任务，也无法「全部暂停 / 一键全部继续」。
- **现象 3**：上传面板是带遮罩的右侧抽屉，遮罩挡住网盘列表，上传时无法操作页面。

#### 修复与新增
- **瞬时故障自动重试（无需手动点重试）** —— 新增 `web/src/utils/retry.ts`：
  - 错误分类：network / timeout / rate-limit / server / signature(403) / session-expired(404) /
    quota(507，不重试) / auth(401，交登录态治理) / client(4xx，不重试)
  - 指数退避 + 抖动（`backoffDelay`），`sleep` 可被暂停立即打断
  - 分片 PUT：最多 4 次重试；**403 自动重新签发该分片 URL 后重试**；90s 无进度判定假死并重试
  - `init` / `complete` 同样自动重试（3-4 次）
  - 任务级自动重试：仍失败且属瞬时故障 → 退避后自动重新排队（最多 3 轮，UI 显示「自动重试 N」）；
    404（MinIO 侧会话失效）自动作废旧会话并重新 init 自愈
- **按需签名（根治 403）**：`presign-parts` 改为「窗口式按需签发」（每次取分片时才签 32 个），
  不再一次性签全部 URL —— 长耗时上传不再因 URL 过期失败
- **暂停 / 继续（AbortSignal 中断 + 断点保留）**：
  - 单任务：`pauseTask` / `resumeTask`（按钮在每条任务上）
  - 批量：**全选 + 暂停选中 / 继续选中**；**一键「全部暂停」/「全部继续」**
  - 暂停立即中止在传请求，已完成分片保留；继续时断点续传，**不重复上传**
  - 关键节点强制刷盘 `flushResumeWrites()`：修复「暂停后立刻继续」读不到断点导致重传
- **上传面板重做（不再遮挡页面）** —— `web/src/components/UploadQueue.tsx`：
  - 去掉遮罩抽屉，改为**右下角悬浮卡片**：非模态、可**拖拽移动**、可**最小化为进度胶囊**
    （位置/折叠状态持久化；移动端为底部面板，页面仍可操作）
  - 面板提升到 `MainLayout` 全站挂载：切换目录/回收站/搜索页也不中断，随时可暂停
  - 工具栏：全选、暂停/继续选中、全部暂停、全部继续、重试失败、清除已完成；总进度按大小加权
- **断点续传补强**：单请求直传（≤8MB）PUT 成功后登记 `mode1Pending` 记录（含内容哈希），
  complete 失败/刷新后**直接补 complete 秒级完成**；哈希不一致则作废旧记录，避免提交旧内容

#### 修复的隐性缺陷（由韧性测试发现）
- **迟到进度覆盖已结算状态**：任务失败进入「自动重试」等待后，同轮仍在途分片的进度回调把状态
  改回「上传中」→ 自动重试被静默丢弃、进度条永久卡住。改用**运行令牌（run token）**丢弃过期回调。
- **迟到回调复活死会话**：会话失效清掉记录后，兄弟分片迟到的 `onPartDone` 又把记录写回 →
  重试仍按死会话续传导致 404 循环。改用 `recordWrites` 开关禁止终止后写记录。
- **暂停后立刻继续**：500ms 合并写窗口内读不到断点 → 重开会话重复上传；改为止 `flushResumeWrites()`。
- **暂停后立即移除/继续**：`finally` 误删新一轮的 AbortController（现按实例身份清理）。

#### 验证
- 受限环境无法启动 esbuild/tsx（spawn EPERM）与 Docker，新增**纯 Node 韧性测试**：
  `e2e/_upload-resilience.ts`（Node 原生 TS 类型剥离 + 伪造 XHR/fetch/localStorage）
  `node --import ./e2e/ts-register.mjs e2e/_upload-resilience.ts` → **25/25 通过**
  （瞬时故障自愈、403 重签、暂停中断/断点续传不重传、不可重试错误立即失败、
   队列全部暂停+一键全部继续、会话失效自愈）
- `npx tsc --noEmit` 通过

#### 关键文件
- `web/src/utils/retry.ts`（新增）、`web/src/utils/uploader.ts`、`web/src/store/upload.ts`
- `web/src/components/UploadQueue.tsx`（重写）、`web/src/components/Layout/MainLayout.tsx`
- `web/src/utils/resume-store.ts`（flushResumeWrites + sha256）、`web/src/hooks/useAutoResume.ts`
- `web/src/styles.css`、`e2e/_upload-resilience.ts`（新增验证）

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
