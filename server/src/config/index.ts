// 配置中心：全部由环境变量驱动，禁止硬编码（.env / docker compose 注入）
import 'dotenv/config';
import os from 'node:os';

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`环境变量 ${name} 不是有效数字: ${v}`);
  return n;
}

// 进程数：WEB_CONCURRENCY 覆盖；默认 min(4, CPU 核数)；1 = 关闭 cluster 单进程
function workers(): number {
  const v = Number(process.env.WEB_CONCURRENCY);
  if (Number.isFinite(v) && v >= 1) return Math.floor(v);
  return Math.min(4, os.cpus().length);
}

function str(name: string, def = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`缺少必需环境变量 ${name}，请检查 .env / docker compose 配置`);
  }
  return v;
}

export const config = {
  nodeEnv: str('NODE_ENV', 'development'),
  isProd: str('NODE_ENV', 'development') === 'production',
  port: int('PORT', 3000),
  apiPrefix: '/api',

  // PostgreSQL
  databaseUrl: str('DATABASE_URL', ''),
  // 连接池上限：500 并发压测实测默认 20 排队严重（P95 3.9s），调大可显著降低排队；
  // cluster 多进程下每 worker 均分（总连接 ≈ pgPoolMax）
  pgPoolMax: int('PG_POOL_MAX', 60),
  // cluster 进程数（WEB_CONCURRENCY 覆盖；默认 min(4, CPU)）
  webConcurrency: workers(),

  // JWT / 会话
  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  cookieSecret: required('COOKIE_SECRET'),
  jwtAccessTtl: str('JWT_ACCESS_TTL', '30m'),
  jwtRefreshTtl: str('JWT_REFRESH_TTL', '30d'),

  // MinIO（内部访问 + 公网签名两套端点）
  minio: {
    endpoint: required('MINIO_ENDPOINT'),
    port: int('MINIO_PORT', 9000),
    useSSL: str('MINIO_USE_SSL', 'false') === 'true',
    accessKey: required('MINIO_ACCESS_KEY'),
    secretKey: required('MINIO_SECRET_KEY'),
    bucket: str('MINIO_BUCKET', 'netdisk-data'),
    region: str('MINIO_REGION', 'us-east-1'),
    publicEndpoint: str('MINIO_PUBLIC_ENDPOINT', ''),
    publicPort: int('MINIO_PUBLIC_PORT', 9000),
    publicUseSSL: str('MINIO_PUBLIC_USE_SSL', 'false') === 'true',
    presignExpiry: int('PRESIGN_EXPIRY', 3600),
  },

  // 上传
  partSize: int('PART_SIZE', 16 * 1024 * 1024),
  smallFileThreshold: int('SMALL_FILE_THRESHOLD', 8 * 1024 * 1024),
  // 服务端 SHA-256 校验阈值：小于该值的文件上传后服务端重算哈希（保证去重/审计可信）
  verifyShaThreshold: int('VERIFY_SHA256_THRESHOLD', 64 * 1024 * 1024),
  // 去重不限大小：零拷贝共享引用，任何大小的文件命中去重池均为纯元数据操作
  // 去重命中等待/在线校验上限：小/中文件（<= 该值）可等待后台池就绪或在线校验；超大文件不等待，池就绪后自动生效
  dedupInlineMax: int('DEDUP_INLINE_MAX', 1024 * 1024 * 1024),
  // 去重池 GC 保留期（天）：池是去重缓存（支持删除后重传秒传），零引用超过该天数后由每日任务清理
  poolGcDays: int('POOL_GC_DAYS', 30),

  // 策略
  trashRetentionDays: int('TRASH_RETENTION_DAYS', 30),
  auditRetentionDays: int('AUDIT_RETENTION_DAYS', 365),
  quotaRecomputeCron: str('QUOTA_RECOMPUTE_CRON', '0 3 * * *'),
  corsOrigin: str('CORS_ORIGIN', ''),
  trustProxy: str('TRUST_PROXY', 'false') === 'true',

  // 监控告警（Redis 内存 / 缓存命中率 / 清理任务状态）
  monitorRedisMemPct: int('MONITOR_REDIS_MEM_PCT', 80), // Redis 内存使用率告警阈值（%）
  monitorHitRateMin: 0.4, // 缓存命中率告警阈值（0-1，40%）；低于且流量充足时告警
  monitorHitRateMinSample: int('MONITOR_HITRATE_MIN_SAMPLE', 200), // 命中率评估最小请求采样量（防冷启动误报）
  monitorCheckCron: str('MONITOR_CHECK_CRON', '*/5 * * * *'), // 监控自检频率

  // 告警通知渠道（未配置即跳过；可同时启用多个）
  alertDingtalkWebhook: str('ALERT_DINGTALK_WEBHOOK', ''), // 钉钉机器人 access_token URL
  alertDingtalkSecret: str('ALERT_DINGTALK_SECRET', ''), // 钉钉加签密钥（机器人安全设置）
  alertWecomWebhook: str('ALERT_WECOM_WEBHOOK', ''), // 企业微信机器人 key URL
  alertWebhookUrl: str('ALERT_WEBHOOK_URL', ''), // 通用 webhook（POST JSON 事件数组）
  alertSmtpHost: str('ALERT_SMTP_HOST', ''), // SMTP 服务器
  alertSmtpPort: int('ALERT_SMTP_PORT', 465),
  alertSmtpSecure: str('ALERT_SMTP_SECURE', 'true') === 'true',
  alertSmtpUser: str('ALERT_SMTP_USER', ''),
  alertSmtpPass: str('ALERT_SMTP_PASS', ''),
  alertMailFrom: str('ALERT_MAIL_FROM', ''),
  alertMailTo: str('ALERT_MAIL_TO', ''),

  // 密码找回通道（未配置即该通道不可用）
  // 邮箱：SMTP 发送验证码；短信：POST {phone, code} 到自建短信网关 webhook（离线内网常见）
  resetMailHost: str('RESET_MAIL_HOST', ''),
  resetMailPort: int('RESET_MAIL_PORT', 465),
  resetMailSecure: str('RESET_MAIL_SECURE', 'true') === 'true',
  resetMailUser: str('RESET_MAIL_USER', ''),
  resetMailPass: str('RESET_MAIL_PASS', ''),
  resetMailFrom: str('RESET_MAIL_FROM', ''),
  resetSmsWebhook: str('RESET_SMS_WEBHOOK', ''),

  // 初始管理员
  admin: {
    username: str('ADMIN_USERNAME', 'admin'),
    password: str('ADMIN_PASSWORD', ''),
    displayName: str('ADMIN_DISPLAY_NAME', '系统管理员'),
  },

  // LDAP/AD（占位）
  ldap: {
    enabled: str('LDAP_ENABLED', 'false') === 'true',
    url: str('LDAP_URL', ''),
    bindDn: str('LDAP_BIND_DN', ''),
    bindPassword: str('LDAP_BIND_PASSWORD', ''),
    baseDn: str('LDAP_BASE_DN', ''),
    userFilter: str('LDAP_USER_FILTER', '(&(objectClass=user)(sAMAccountName=%s))'),
  },
} as const;

export type AppConfig = typeof config;
