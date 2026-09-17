# 上传架构与认证续期（upload-architecture）

> 本文记录上传链路架构与 v1.0.13 引入的 Token 过期治理设计。部署/运维见其他文档。

## 1. 上传链路概览

```
浏览器（React）
  ├─ 文件选择/拖拽/文件夹(webkitdirectory)
  ├─ prepareUploads：目录并行创建（按深度分层，限流 12）→ 一次性入队
  ├─ 上传队列（store/upload.ts）：Map 存储 + FIFO 调度泵（小文件 6 / 大文件 2 并发）
  │    ├─ 小文件(≤8MB)：BLAKE3 哈希 → init(签 PUT URL) → PUT 直传 MinIO → complete
  │    └─ 大文件(>8MB)：BLAKE3 分片哈希 → init(multipart) → 分片并发 PUT → complete
  ├─ 队列渲染：裁剪 200 条 + 1s 轮询快照（万级任务不卡主线程）
  └─ 完成后：防抖刷新列表（500ms 合并）
服务端
  ├─ upload/init：配额/同名/去重池检查 → 签发签名 URL 或 multipart
  ├─ complete：stat + 服务端哈希校验(≤64MB) + 事务落库 + 池注册(异步限流 8)
  └─ MinIO：对象存储（版本控制，30 天非当前版本清理）
```

## 2. 认证与续期（v1.0.13）

### 2.1 Token 模型

| Token | 存储 | 有效期 | 用途 |
|---|---|---|---|
| access_token (JWT) | localStorage `nd_access_token` | **30 分钟**（JWT_ACCESS_TTL） | 业务请求 Bearer |
| refresh_token | httpOnly cookie `nd_refresh` | 30 天（JWT_REFRESH_TTL） | 刷新 access_token |
| CSRF token | 非 httpOnly cookie `nd_csrf` | 会话 | 写操作双重提交 |

### 2.2 主动续期（第一轮：源头减少 401）

```
60s 定时器（MainLayout 登录态挂载）
  └─ decodeTokenExp(jwt) → tokenExpireAt
       └─ 距过期 ≤10min → refreshTokenWithGuard()
            ├─ 并发锁：已在途共享同一 Promise（多任务只 1 次刷新）
            ├─ 5s 超时（AbortController，独立于业务 30s）
            ├─ 指数退避：429/失败 → 1s/2s/4s/8s 最多 4 次
            └─ 60s 最小间隔（防 429；401 纠错 force 无视间隔）
切前台（useVisibilityCheck）
  └─ visibilitychange → visible → checkTokenOnVisible()（后台定时器被节流，不依赖其精度）
```

### 2.3 401 纠错（第二轮：Token 过期不丢任务）

```
业务请求 401
  └─ api/client.ts 拦截器
       ├─ refreshTokenWithGuard(true) → 成功 → 更新 token → 重试原请求
       └─ 失败
            ├─ pauseForAuth()：队列暂停 + 全部未完成任务标记 auth-failed
            │    （保留 progress/bytesDone；埋点 interrupt_reason=token_expired）
            ├─ token 清理
            └─ UI：UploadResumeButton 横幅「N 个文件等待继续上传」
用户重新登录 → LoginPage afterLogin 检查 nd_resume_upload
  └─ resumeAuth()：auth-failed → queued 重新入队（uploader 断点续传复用已传分片）
```

### 2.4 状态机

```
queued → hashing → uploading → completed
                          ↘ paused →(继续) → queued（断点续传）
                          ↘ auth-failed → (重新登录+继续上传) → queued（断点续传）
                          ↘ error → (自动重试 ≤3 轮 / 手动重试) → queued
```

### 2.5 时序图

正常流程：
```
用户上传 → 队列运行
    ├─ 定时器(60s)监控
    ├─ [距过期≤10min] → 主动刷新 → 更新 token → 继续（无感）
    └─ 上传完成 → 停止
异常流程：
上传中 → Token 过期（未及时刷新）
    ├─ 请求 401 → 捕获 → 刷新失败
    ├─ 队列 → 全部未完成标记 auth-failed → 暂停
    ├─ UI → 「登录已过期，N 个文件等待继续上传」
    ├─ 用户重新登录 → 刷新成功
    └─ 点击「继续上传」→ auth-failed 重新入队 → 断点续传
```

## 3. 风险治理对照（v1.0.13 方案 R1-R7）

| 风险 | 缓解 | 状态 |
|---|---|---|
| R1 双 Token 死锁 | `/api/auth/refresh` 在免鉴权白名单（appRoutes），用 cookie 的 refresh_token 验证，不依赖旧 access_token | ✅ 已确认 |
| R2 刷新 429 | 指数退避 + 60s 最小间隔 | ✅ |
| R3 恢复并发爆炸 | 复用并发槽（小 6 / 大 2），恢复严格限流入队 | ✅ |
| R4 后台定时器节流 | 切前台主动检测 | ✅ |
| R5 渲染卡顿 | v1.0.12 裁剪 200 条 + 1s 轮询 | ✅ |
| R6 关页任务丢失 | 本轮接受（UI 提示勿关页），第三轮断点续传解决 | ⏳ v1.1.x |
| R7 刷新/业务超时冲突 | 刷新独立 5s，不影响上传分片 30s | ✅ |

## 4. 断点续传（v1.1.0 第三轮）

### 4.1 持久化层级（页面刷新/关闭后恢复）

```
刷新/关闭后恢复优先级：
1) IndexedDB 记录（utils/resume-store.ts）
     ├─ sessionId + partsEtag + partSize/totalParts（所有分片文件）
     └─ 小文件(≤8MB) 额外存 File 引用 → 页面加载自动恢复（useAutoResume）
2) 服务端 /upload/parts（upload_sessions.uploaded_parts）
     └─ 跨设备/清本地后补齐缺失分片（mergeServerParts）
3) localStorage 旧机制（nd_resume_sessions，v1.0.x 兼容兜底）
```

### 4.2 分片上报与查询

```
分片 PUT 完成 → onPartDone
    ├─ 写 IndexedDB（含 File 引用，小文件）
    ├─ 节流上报（每 5 分片）→ POST /upload/parts-report → 服务端合并 uploaded_parts
    └─ complete 时最终上报一次
恢复时：
    ├─ 读 IndexedDB 记录 → 校验会话可用（presignParts 探测）
    ├─ GET /upload/parts → 合并服务端已传分片（本地缺失补 'server' 占位 → 真实重传）
    └─ 重选同一文件 → 命中续传（不重新 init/不重复已传分片）
```

### 4.3 清理策略

| 时机 | 清理 |
|---|---|
| 任务完成/去重命中 | 删除 IndexedDB 记录 + localStorage 旧记录 |
| 服务端 complete | upload_sessions 置 status=1 |
| 过期 | IndexedDB 7 天；服务端定时任务清中止/完成会话（每日 02:30） |
| 失败 | 保留 IndexedDB 记录（下次续传） |

### 4.4 审查加固（v1.1.1）

- **IndexedDB 降级**：Safari 私有模式 `indexedDB.open` 失败 → 标记 `idbUnavailable`，
  后续读写走 localStorage（`nd_resume_sessions_v2`，File 引用丢弃、进度保留）
- **批量写合并**：`saveResumeRecord` 500ms 合并（pendingWrites + flushTimer），
  删除用 `deletedKeys` 标记防在途 flush 写回（完成/删除竞态防护）
- **增量上报**：`schedulePartsReport` 只发新增分片（reportedParts 按 session 跟踪），
  complete 后清理
- **恢复分批**：`useAutoResume` 每批 50 + setTimeout(0) 让出主线程

## 5. 上传韧性：瞬时故障自愈 + 暂停/继续（v1.1.5）

### 5.1 为什么需要（对应用户反馈）

「上传偶发提示『请求失败，请稍后重试』，点一下重试又能成功」= **瞬时故障没有自愈**。
常见来源：网络抖动、网关 5xx、429 限流、传输假死、**分片签名 URL 过期（403）**
（旧实现一次性签全部分片 URL，大文件超过 `PRESIGN_EXPIRY`=1h 后后段 URL 必然失效）。

### 5.2 错误分类与重试策略（`web/src/utils/retry.ts`）

| 分类 | 触发 | 策略 |
|---|---|---|
| network | 断网/DNS/连接重置（`TypeError`、XHR onerror） | 自动重试（指数退避+抖动） |
| timeout | 请求超时 / 传输 90s 无进度 | 自动重试 |
| rate-limit | HTTP 429 | 自动重试 |
| server | HTTP 5xx（含网关 502/503/504） | 自动重试 |
| signature | 分片 PUT 403（签名过期） | **重新签发该分片 URL** 后重试 |
| session-expired | 分片 PUT 404（MinIO 侧会话/分片丢失） | 作废本地会话 → 任务级重试重新 init |
| quota | 507 空间不足 | 不重试（提示用户） |
| auth | 401 登录态失效 | 不重试，交 `pauseForAuth` 全局治理 |
| client | 其它 4xx（参数/权限/校验失败） | 不重试 |

- **分片级**：最多 4 次重试；`PRESIGN_WINDOW=32` 按需签名；`PART_STALL_TIMEOUT=90s` 假死中断
- **任务级**：瞬时故障仍失败 → 退避后自动重新排队，最多 3 轮（UI 标签「自动重试 N」），
  成功后 `attempts` 归零
- **进度准确性**：分片字节按「本次已达最大值」累计，重试同一分片不重复计数

### 5.3 暂停 / 继续（AbortSignal）

```
pauseTask(id) / pauseAll()             resumeTask(id) / resumeAll()
   ├─ controllers.get(id).abort()         ├─ 状态 paused → queued
   ├─ uploader: PUT 中断 → 已传分片保留   ├─ queuedIds.push + pump
   │   ├─ flushResumeWrites() 立即落盘    └─ uploader 命中 IndexedDB/服务端分片 → 只补缺失分片
   │   └─ 返回 status='paused'（非错误）
   └─ 状态 paused（不计入失败/完成）
```

- 队列级暂停标志 `paused + pauseReason`：`user`（用户全部暂停）/ `token_expired`（登录过期）
- 单任务暂停时队列继续调度其它任务；全部暂停时停止调度
- 交互：全选 + 暂停选中/继续选中；一键「全部暂停」/「全部继续」；最小化胶囊上也有一键暂停/继续

### 5.4 并发正确性（两道令牌）

| 机制 | 作用 |
|---|---|
| 运行令牌 `runTokens`（store） | 任务结算后，同轮在途分片的**迟到进度回调被丢弃**——否则会把状态改回「上传中」，导致自动重试被静默丢弃、进度条卡死 |
| 写记录开关 `recordWrites`（uploader） | 会话失效/暂停后，兄弟分片迟到的 `onPartDone` **不再写断点记录**——否则会复活已作废会话，重试时按死会话续传（404 循环） |

### 5.5 任务列表：悬浮浮层（默认）+ 下载任务（v1.1.10）

- **默认悬浮浮层**：`position: fixed`（`z-index: 1200`）浮在网盘界面之上，可拖拽移动（位置持久化），
  可最小化为浮层胶囊；**不响应点击外部/失焦/Esc**——操作网盘、切目录、开预览都不会让它消失
- **形态可切换**：标题栏一键「悬浮 ⇄ 停靠右侧」（停靠=占位式，不覆盖文件列表），选择持久化
- **列表持久化**（`localStorage: nd_task_list_v1`，节流 500ms）：
  - 刷新/前进后退（整页重载）后列表仍在——旧实现内存队列会被清空，是"列表凭空消失"的主因之一
  - 被打断的条目标记「已中断」：下载用持久化的 `fileId/isDir` 重建执行体可**一键重新下载**；
    上传提示重新选择文件（≤8MB 由 IndexedDB 自动续传）
- **上传 + 下载同一列表**：`kind='upload' | 'download'`
  - 下载：`utils/downloader.ts` 流式读取（实时进度/可取消/可重试/落盘），并发 2，独立于上传队列
  - 单文件走 MinIO 预签名直连；文件夹走 `/api/files/:id/download-dir`；>1.5GB 交还浏览器原生下载
  - 暂停/继续只作用于上传任务（下载只能取消）
- 顶栏固定入口 `UploadTaskButton`：显示 `已完成/总数 · 百分比` + 角标，任意页面开关面板
- **nginx**：`index.html` 必须 `no-store`（否则升级后浏览器仍跑旧包，用户看到"修复没生效"）

### 5.6 上传面板（历史形态）

- **桌面端**：`MainLayout` 的 `<Layout hasSider>` 内、内容区右侧挂载 `UploadQueue`（渲染 antd `Sider`，宽 360px）
  - **占位式**：占用布局宽度，**不覆盖文件列表**（与左侧空间导航对称）；无任务时整栏消失、内容区自动回满宽
  - **收起态**（v1.1.9 起）为 **196px 带文字的紧凑面板**：进度 + 「全部暂停」/「全部继续」**常驻文字按钮**
    （无可操作任务时置灰）+ 重试失败/清除已完成；**不再使用 48px 图标细栏**
    （旧细栏按钮无文字、命中区小，用户既找不到按钮又容易误触暂停）
  - **不使用 Esc 收起**（v1.1.9）：原全局 Escape 监听会在用户关预览/弹窗时把上传栏一起收起，
    造成「点一下网盘界面，上传就隐藏了」的错觉；收起只由显式按钮触发
  - 暂停/继续操作后弹出明确提示（已暂停 N 个、如何恢复、断点保留）
  - 常驻栏内列表占满剩余高度并内部滚动（`.upload-dock .upload-panel__list`）
- **移动端**（≤768px）：底部非模态面板（无遮罩，可继续操作页面）+ 进度胶囊
- **顶栏固定入口** `UploadTaskButton`：显示 `已完成/总数 · 百分比` + 进行中角标（失败红标），任意页面展开/收起
- **列表常驻**：任务存在期间不会消失——收起/最小化只切换形态；也**不再自动隐藏**
  （旧行为 v1.1.5：全部成功后 2.5s 自动收起，用户点页面后就找不到列表，见 v1.1.6 修复）
- **状态**：展开/收起由 store 的 `visible` + `panelCollapsed` 驱动并持久化；
  `UploadQueue` 静态引入（参与布局，避免懒加载造成的宽度跳动）
- 工具栏：全选 / 暂停选中 / 继续选中 / 全部暂停 / 全部继续 / 重试失败 / 清除已完成；总进度按文件大小加权

## 6. 上传可靠性根因修复（v1.1.8）

> 用户反馈：「上传偶发『请求失败，请稍后重试』，点一下重试又能成功」。真实浏览器复现 + 服务端日志定位到两个独立根因。

### 6.1 根因一：客户端并发哈希串号（P0，数据正确性）

```
客户端 BLAKE3 Worker 池（web/src/utils/hash.ts）
  旧实现：hashViaWorker(worker, segId, buf)  ← 用「分片序号」当请求关联 ID
  问题：多个 >8MB 文件并发哈希共用同一 worker 池；
        EventTarget 监听器会收到该 worker 的**每一条**消息，且按 id 匹配
        → 文件 A 的 seg0 回复把同样在等 seg0 的文件 B 一并 resolve
        → 两个文件内容哈希互相串号 → 客户端上报错误哈希
        → 服务端 completeUpload 重算 BLAKE3(B3SEG) 不一致 → 400「文件哈希校验失败，已终止上传」
        → 界面「请求失败，请稍后重试」；单文件重试（不再并发）即可成功
  为何只有大文件：≤8MB 走主线程单例哈希（init/update/digest 无 await，原子）
  修复：请求 ID 改为全局单调递增（与分片序号解耦，一问一答严格对应）
```

### 6.2 根因二：暂停后「全部继续」永久卡在「上传中」

```
旧流程：暂停 → uploader 只中断了分片 PUT（XHR），**未中断** init/presign/complete（JSON 接口）
        → 服务端其实已完成合并并落库；客户端却因任务被标记 suspended/paused
          在 store .then 中直接 return（丢弃「已完成」）→ 任务永远停在上传中
        → 恢复后再次 complete 撞 MinIO NoSuchUpload → 500 → 卡死
修复（三层防御）：
  1) api()/uploadInit/presignParts/completeUpload 支持 AbortSignal：暂停同步中断接口
  2) 服务端 complete 幂等自愈：NoSuchUpload 且对象已存在且大小一致 → 视为已完成继续落库
  3) 客户端 complete 失败自愈：init 校验内容是否已落库（命中去重即成功）；
     store「先判成功、再判暂停」——真实完成的结果不再被暂停标记吞掉
附带：complete 缺分片清单不再 abortMultipart（不销毁可恢复分片）；
     服务端占位分片（'server'，无 ETag）必须真实重传
```

### 6.3 回归测试（真实浏览器 Playwright + 本机 Edge）

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `e2e/_ui-hash-check.mjs` | 并发哈希 vs 串行基准（3 文件 / 8 文件压力） | ✅ 逐一致 |
| `e2e/_ui-upload-flow.mjs` | 40MB 单文件 / 暂停→继续 / 立即继续 / 3 文件并发（抓取所有 4xx-5xx） | ✅ 零非预期失败 |
| `e2e/_ui-dock-check.mjs` | 常驻栏占位布局/命中测试/4 种窗口宽度/细栏/顶栏入口/全部暂停恢复/控制台无错误 | ✅ |
| `e2e/_upload-resilience.ts` | 逻辑层 25 项（退避重试/断点/暂停） | ✅ 25/25 |
| `e2e/_cleanup-tests.mjs` | 测试数据清理（软删 → purge，因 purge 只对已删除目标生效） | ✅ |

## 7. 关键文件

- `web/src/utils/token-refresh.ts`：主动续期核心（解码/定时/并发锁/退避）
- `web/src/hooks/useVisibilityCheck.ts`：切前台检测
- `web/src/api/client.ts`：401 拦截器 → 刷新 → 暂停；上传二进制错误结构化（HttpStatusError）；支持 AbortSignal
- `web/src/utils/retry.ts`：错误分类 + 指数退避 + 可中断 sleep（v1.1.5）
- `web/src/utils/hash.ts`：BLAKE3 分片哈希（worker 池 + `__ndFileHash` 测试钩子；v1.1.8 修复并发串号）
- `web/src/store/upload.ts`：状态机 + 暂停/继续/批量暂停 + 运行令牌 + 任务级自动重试（v1.1.5/1.1.8）
- `web/src/components/UploadQueue.tsx`：任务列表（悬浮浮层/浮层胶囊/停靠栏；上传+下载）
- `web/src/utils/downloader.ts`：流式下载引擎（进度/取消/落盘/超大文件直连，v1.1.10）
- `web/src/components/UploadTaskButton.tsx`：顶栏固定「上传任务」入口（进度/角标，v1.1.6）
- `web/src/components/UploadResumeButton.tsx`：恢复入口
- `web/src/utils/metrics.ts`：interrupt_reason 埋点（token_expired / user_paused / auto_retry / session_expired）
- `web/src/utils/resume-store.ts`：断点续传 IndexedDB 持久化（3.1）+ `flushResumeWrites` 立即刷盘（v1.1.5）
- `web/src/utils/uploader.ts`：三级续传引擎（IndexedDB→服务端→localStorage）+ 自动重试/按需签名/暂停中断（v1.1.5）
- `web/src/hooks/useAutoResume.ts`：页面加载自动恢复（3.3 + mode1Pending 补 complete）
- `e2e/_upload-resilience.ts`：上传韧性测试（伪造 XHR/fetch，25 项断言，v1.1.5）
- 后端：`server/src/routes/auth.ts` `/refresh`（cookie refresh_token，免鉴权）
- 后端：`server/src/routes/files.ts` `/upload/parts-report` + `/upload/parts`（3.2）
