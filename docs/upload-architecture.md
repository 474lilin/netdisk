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
                          ↘ auth-failed → (重新登录+继续上传) → queued（断点续传）
                          ↘ error
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

## 5. 关键文件

- `web/src/utils/token-refresh.ts`：主动续期核心（解码/定时/并发锁/退避）
- `web/src/hooks/useVisibilityCheck.ts`：切前台检测
- `web/src/api/client.ts`：401 拦截器 → 刷新 → 暂停
- `web/src/store/upload.ts`：auth-failed 状态 + pauseForAuth/resumeAuth
- `web/src/components/UploadResumeButton.tsx`：恢复入口
- `web/src/utils/metrics.ts`：interrupt_reason 埋点
- `web/src/utils/resume-store.ts`：断点续传 IndexedDB 持久化（3.1）
- `web/src/utils/uploader.ts`：三级续传引擎（IndexedDB→服务端→localStorage）
- `web/src/hooks/useAutoResume.ts`：页面加载自动恢复（3.3）
- 后端：`server/src/routes/auth.ts` `/refresh`（cookie refresh_token，免鉴权）
- 后端：`server/src/routes/files.ts` `/upload/parts-report` + `/upload/parts`（3.2）
