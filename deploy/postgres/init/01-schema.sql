-- =============================================================================
-- 企业私有化网盘 - PostgreSQL 初始化脚本（元数据库）
-- 仅存储元信息，文件二进制全部存放在 MinIO
-- 由 postgres 容器 /docker-entrypoint-initdb.d 首次启动时执行
-- =============================================================================

-- 扩展：文件名模糊检索加速（pg_trgm）
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 企业（租户）
CREATE TABLE orgs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(255) NOT NULL,
    code        VARCHAR(64)  UNIQUE,
    status      SMALLINT     NOT NULL DEFAULT 1,          -- 1 启用 0 停用
    quota_bytes BIGINT       NOT NULL DEFAULT 0,          -- 0 = 不限
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 部门（树形）
CREATE TABLE departments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    parent_id   UUID REFERENCES departments(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    path        TEXT NOT NULL DEFAULT '',                  -- 物化路径 /id1/id2/
    sort_order  INT  NOT NULL DEFAULT 0,
    quota_bytes BIGINT NOT NULL DEFAULT 0,                 -- 部门配额，0 = 不限制
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_departments_org ON departments(org_id);
CREATE INDEX idx_departments_parent ON departments(parent_id);

-- 用户
CREATE TABLE users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    username       VARCHAR(64) NOT NULL,                  -- 登录名（租户内唯一）
    password_hash  TEXT NOT NULL DEFAULT '',
    display_name   VARCHAR(255) NOT NULL DEFAULT '',
    email          VARCHAR(255) NOT NULL DEFAULT '',
    phone          VARCHAR(32)  NOT NULL DEFAULT '',
    role           SMALLINT NOT NULL DEFAULT 3,           -- 1 企业管理员 2 部门管理员 3 普通员工
    dept_id        UUID REFERENCES departments(id) ON DELETE SET NULL,
    status         SMALLINT NOT NULL DEFAULT 1,           -- 1 启用 0 禁用
    quota_bytes    BIGINT NOT NULL DEFAULT 0,             -- 0 = 跟随组织/不限
    used_bytes     BIGINT NOT NULL DEFAULT 0,             -- 已用容量（含回收站）
    auth_source    VARCHAR(16) NOT NULL DEFAULT 'local',  -- local | ldap | ad
    ldap_dn        VARCHAR(512) NOT NULL DEFAULT '',
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_users_org_username UNIQUE (org_id, username)
);
CREATE INDEX idx_users_dept ON users(dept_id);

-- 登录会话（Refresh Token）
CREATE TABLE sessions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT NOT NULL,
    ip                 VARCHAR(64)  NOT NULL DEFAULT '',
    user_agent         VARCHAR(512) NOT NULL DEFAULT '',
    expires_at         TIMESTAMPTZ NOT NULL,
    revoked_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- 目录（文件夹）树：企业公共盘(scope=1) / 部门盘(scope=2) / 个人空间(scope=3)
CREATE TABLE directories (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    dept_id    UUID REFERENCES departments(id) ON DELETE CASCADE,
    parent_id  UUID REFERENCES directories(id) ON DELETE CASCADE,
    owner_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    name       VARCHAR(255) NOT NULL,
    path       TEXT NOT NULL DEFAULT '',                  -- 物化路径，用于祖先判断
    scope      SMALLINT NOT NULL DEFAULT 3,               -- 1 企业公共 2 部门 3 个人
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,            -- 回收站标记
    deleted_at TIMESTAMPTZ,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_directories_parent ON directories(parent_id);
CREATE INDEX idx_directories_org ON directories(org_id);
CREATE INDEX idx_directories_trash ON directories(is_deleted, deleted_at) WHERE is_deleted = TRUE;
-- 目录 path 前缀搜索（子树查询 path = ? OR path LIKE ? || '%'）：btree text_pattern_ops 最优（无 collation 限制）
CREATE INDEX idx_directories_path_pattern ON directories USING btree (path text_pattern_ops);

-- 文件元数据（实体在 MinIO）
CREATE TABLE files (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    dir_id      UUID NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
    owner_id    UUID NOT NULL REFERENCES users(id),
    name        VARCHAR(255) NOT NULL,
    ext         VARCHAR(32)  NOT NULL DEFAULT '',
    mime_type   VARCHAR(255) NOT NULL DEFAULT '',
    size_bytes  BIGINT       NOT NULL DEFAULT 0,
    sha256      VARCHAR(64)  NOT NULL DEFAULT '',          -- 内容哈希（64 位十六进制，当前实现为 BLAKE3/B3SEG）
    object_key  TEXT         NOT NULL,                    -- 当前对象 Key（前端不可见）
    version_id  TEXT         NOT NULL DEFAULT '',         -- MinIO 当前版本号
    is_deleted  BOOLEAN      NOT NULL DEFAULT FALSE,      -- 回收站标记
    deleted_at  TIMESTAMPTZ,
    deleted_by  UUID,
    dedup_ref   BOOLEAN      NOT NULL DEFAULT FALSE,      -- 去重引用（共享池对象）
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- 目录列表（files 侧）由下方 uq_files_dir_name(dir_id, name) 部分唯一索引覆盖
--   （dir 等值 + name 排序 + 软删除过滤），不再需要单独的 dir_id 索引
CREATE INDEX idx_files_org_name ON files(org_id, name);
CREATE INDEX idx_files_org_sha ON files(org_id, sha256) WHERE sha256 <> '' AND is_deleted = FALSE;
CREATE INDEX idx_files_trash ON files(is_deleted, deleted_at) WHERE is_deleted = TRUE;
CREATE INDEX idx_files_org_updated ON files(org_id, updated_at DESC) WHERE is_deleted = FALSE;
-- 文件名模糊搜索（ILIKE '%q%'）：pg_trgm GIN 索引，实测 5 万行 35ms -> 4ms（8-49x）
CREATE INDEX idx_files_name_trgm ON files USING gin (name gin_trgm_ops) WHERE is_deleted = FALSE;
-- 配额统计/重算：按 owner 聚合 SUM(size_bytes)。不带谓词（回收站文件仍计入用量，
--   与"删除进回收站不扣减、彻底删除才扣减"的语义一致），实测 Index Only Scan 26.7ms -> 0.3ms（~88x）
CREATE INDEX idx_files_owner_size ON files(owner_id, size_bytes);
-- 同目录同名唯一（回收站内的记录除外），防止并发重名双写
CREATE UNIQUE INDEX uq_files_dir_name ON files(dir_id, name) WHERE is_deleted = FALSE;

-- 文件版本（对应 MinIO 对象版本，支持回滚）
CREATE TABLE file_versions (
    id          BIGSERIAL PRIMARY KEY,
    file_id     UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    object_key  TEXT NOT NULL,
    version_id  TEXT NOT NULL,
    size_bytes  BIGINT NOT NULL DEFAULT 0,
    sha256      VARCHAR(64) NOT NULL DEFAULT '',
    uploaded_by UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_file_versions_file ON file_versions(file_id, created_at DESC);

-- 目录 ACL（细粒度授权：对指定目录授予 用户/部门/企业 读写删享）
CREATE TABLE acls (
    id          BIGSERIAL PRIMARY KEY,
    dir_id      UUID NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
    target_type SMALLINT NOT NULL,                        -- 1 用户 2 部门 3 企业
    target_id   UUID NOT NULL,
    can_read    BOOLEAN NOT NULL DEFAULT TRUE,
    can_write   BOOLEAN NOT NULL DEFAULT FALSE,
    can_delete  BOOLEAN NOT NULL DEFAULT FALSE,
    can_share   BOOLEAN NOT NULL DEFAULT FALSE,
    created_by  UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_acl_dir_target UNIQUE (dir_id, target_type, target_id)
);

-- 内部授权分享（文件/目录 授权给 用户/部门/企业）
CREATE TABLE share_grants (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    file_id     UUID REFERENCES files(id) ON DELETE CASCADE,
    dir_id      UUID REFERENCES directories(id) ON DELETE CASCADE,
    target_type SMALLINT NOT NULL,
    target_id   UUID NOT NULL,
    can_write   BOOLEAN NOT NULL DEFAULT FALSE,
    can_delete  BOOLEAN NOT NULL DEFAULT FALSE,
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_share_target CHECK (file_id IS NOT NULL OR dir_id IS NOT NULL)
);
CREATE INDEX idx_share_grants_target ON share_grants(target_type, target_id);

-- 外链分享（内网链接：密码/有效期/次数）
CREATE TABLE share_links (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    token            VARCHAR(64) NOT NULL UNIQUE,
    file_id          UUID REFERENCES files(id) ON DELETE CASCADE,
    dir_id           UUID REFERENCES directories(id) ON DELETE CASCADE,
    password_hash    TEXT NOT NULL DEFAULT '',
    expires_at       TIMESTAMPTZ,
    max_access_count INT  NOT NULL DEFAULT 0,             -- 0 = 不限
    access_count     INT  NOT NULL DEFAULT 0,
    allow_download   BOOLEAN NOT NULL DEFAULT TRUE,
    created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at       TIMESTAMPTZ,
    CONSTRAINT ck_share_link_target CHECK (file_id IS NOT NULL OR dir_id IS NOT NULL)
);
CREATE INDEX idx_share_links_created ON share_links(created_by, created_at DESC);

-- 分片上传会话（断点续传：记录 MinIO uploadId）
CREATE TABLE upload_sessions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         UUID NOT NULL,
    user_id        UUID NOT NULL,
    dir_id         UUID NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
    file_name      VARCHAR(255) NOT NULL,
    file_size      BIGINT NOT NULL DEFAULT 0,
    sha256         VARCHAR(64) NOT NULL DEFAULT '',
    object_key     TEXT NOT NULL,
    upload_id      TEXT NOT NULL DEFAULT '',
    mode           SMALLINT NOT NULL DEFAULT 1,           -- 1 单请求 2 分片
    status         SMALLINT NOT NULL DEFAULT 0,           -- 0 进行中 1 完成 2 中止 3 失败
    uploaded_parts INT[] NOT NULL DEFAULT '{}',           -- 已上传分片号（服务端登记）
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_upload_sessions_user ON upload_sessions(user_id, created_at DESC);
CREATE INDEX idx_upload_sessions_status ON upload_sessions(status, updated_at) WHERE status = 0;

-- 审计日志（全量操作留痕，企业合规）
CREATE TABLE audit_logs (
    id          BIGSERIAL PRIMARY KEY,
    org_id      UUID,
    user_id     UUID,
    action      VARCHAR(64) NOT NULL,                     -- login/upload/download/delete/...
    target_type VARCHAR(32) NOT NULL DEFAULT '',
    target_id   UUID,
    file_id     UUID,
    detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip          VARCHAR(64) NOT NULL DEFAULT '',
    user_agent  VARCHAR(512) NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_user_time ON audit_logs(user_id, created_at DESC);
CREATE INDEX idx_audit_org_time ON audit_logs(org_id, created_at DESC);
CREATE INDEX idx_audit_action_time ON audit_logs(action, created_at DESC);

-- 配额统计缓存（定时重算）
CREATE TABLE quota_stats (
    org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    dept_id      UUID REFERENCES departments(id) ON DELETE CASCADE,
    used_bytes   BIGINT NOT NULL DEFAULT 0,
    computed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, dept_id)
);

-- 去重池元数据：SHA-256 哈希验证结果缓存（verified=true 后秒传免验）
CREATE TABLE dedup_pool (
    org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    sha256     VARCHAR(64) NOT NULL,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    verified   BOOLEAN NOT NULL DEFAULT FALSE,  -- 哈希已经服务端全量校验（可信）
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, sha256)
);

-- 监控：定时任务执行记录（回收站/审计/会话清理、去重池 GC、过期分享、配额重算等）
CREATE TABLE monitor_job_runs (
    id           BIGSERIAL PRIMARY KEY,
    job_name     VARCHAR(64) NOT NULL,          -- trash_purge / audit_purge / pool_gc / ...
    ok           BOOLEAN NOT NULL,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    detail       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_monitor_job_runs_name_time ON monitor_job_runs(job_name, started_at DESC);

-- 监控：告警（同 metric 只保留一条 active，恢复后置 FALSE；可人工确认）
CREATE TABLE monitor_alerts (
    id              BIGSERIAL PRIMARY KEY,
    level           VARCHAR(16) NOT NULL DEFAULT 'warn',  -- warn | critical
    metric          VARCHAR(64) NOT NULL,                  -- redis_memory / cache_hit_rate / job_stale:trash_purge
    message         TEXT NOT NULL DEFAULT '',
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    acknowledged_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_monitor_alert_active_metric ON monitor_alerts(metric) WHERE active = TRUE;

-- 密码找回验证码（邮箱/短信通道；10 分钟有效、尝试上限、发送限流）
CREATE TABLE password_reset_codes (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel     VARCHAR(16) NOT NULL,                      -- email | sms
    target      VARCHAR(255) NOT NULL,                     -- 收件邮箱 / 手机号
    code        VARCHAR(8) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    attempts    SMALLINT NOT NULL DEFAULT 0,               -- 校验失败次数
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reset_codes_user_time ON password_reset_codes(user_id, created_at DESC);
CREATE INDEX idx_reset_codes_cleanup ON password_reset_codes(expires_at);

-- 通用验证码（注册防恶意/其他场景；target=邮箱或手机）
CREATE TABLE verification_codes (
    id          BIGSERIAL PRIMARY KEY,
    scene       VARCHAR(32) NOT NULL,                      -- register / ...
    target      VARCHAR(255) NOT NULL,                     -- 邮箱 / 手机号
    code        VARCHAR(8) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    attempts    SMALLINT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_verification_codes_scene_target ON verification_codes(scene, target, created_at DESC);
CREATE INDEX idx_verification_codes_cleanup ON verification_codes(expires_at);

-- 密码历史（禁止重复使用最近 N 条密码）
CREATE TABLE password_history (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_password_history_user ON password_history(user_id, created_at DESC);
