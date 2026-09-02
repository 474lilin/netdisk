// =============================================================================
// 告警通知渠道：钉钉 / 企业微信 / 邮件(SMTP) / 通用 webhook
// - 任一渠道未配置则跳过；多渠道可同时启用（全部发送）
// - 通知失败仅记日志，绝不影响告警主流程（monitor_alerts 已持久化）
// - 离线私有化部署：钉钉/企微走机器人 webhook（需出网），邮件走内网 SMTP
// =============================================================================
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { logger } from './logger.js';
import { config } from '../config/index.js';

export interface AlertEvent {
  type: 'raised' | 'resolved';
  level: string; // warn | critical
  metric: string;
  message: string;
}

const MSG_LIMIT = 4000; // 钉钉/企微单条消息长度上限

function fmtText(events: AlertEvent[]): string {
  const lines = events.map(
    (e) => `## [${e.type === 'raised' ? '告警' : '恢复'}] ${e.level.toUpperCase()} ${e.metric}\n${e.message}`
  );
  lines.unshift('**企业网盘监控通知**');
  return lines.join('\n\n');
}

async function postJson(url: string, body: unknown, timeoutMs = 8000): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 钉钉机器人（可选加签） ----------
async function notifyDingtalk(text: string): Promise<void> {
  if (!config.alertDingtalkWebhook) return;
  let url = config.alertDingtalkWebhook;
  if (config.alertDingtalkSecret) {
    const ts = Date.now();
    const sign = crypto.createHmac('sha256', config.alertDingtalkSecret).update(`${ts}\n${config.alertDingtalkSecret}`).digest('base64');
    url = `${url}${url.includes('?') ? '&' : '?'}timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
  }
  await postJson(url, {
    msgtype: 'markdown',
    markdown: { title: '企业网盘监控', text: text.slice(0, MSG_LIMIT) },
  });
}

// ---------- 企业微信机器人 ----------
async function notifyWecom(text: string): Promise<void> {
  if (!config.alertWecomWebhook) return;
  await postJson(config.alertWecomWebhook, {
    msgtype: 'markdown',
    markdown: { content: text.slice(0, MSG_LIMIT) },
  });
}

// ---------- 通用 webhook（JSON 事件数组） ----------
async function notifyWebhook(events: AlertEvent[]): Promise<void> {
  if (!config.alertWebhookUrl) return;
  await postJson(config.alertWebhookUrl, {
    source: 'netdisk-monitor',
    ts: new Date().toISOString(),
    events,
  });
}

// ---------- 邮件（SMTP） ----------
let mailTransport: ReturnType<typeof nodemailer.createTransport> | null = null;
function getTransport(): ReturnType<typeof nodemailer.createTransport> | null {
  if (!config.alertSmtpHost) return null;
  if (!mailTransport) {
    mailTransport = nodemailer.createTransport({
      host: config.alertSmtpHost,
      port: config.alertSmtpPort,
      secure: config.alertSmtpSecure,
      auth: config.alertSmtpUser
        ? { user: config.alertSmtpUser, pass: config.alertSmtpPass }
        : undefined,
    });
  }
  return mailTransport;
}

async function notifyMail(text: string, count: number): Promise<void> {
  const t = getTransport();
  if (!t || !config.alertMailTo) return;
  await t.sendMail({
    from: config.alertMailFrom || config.alertSmtpUser,
    to: config.alertMailTo,
    subject: `[企业网盘监控] ${count} 条告警${text.includes('恢复') ? '/恢复' : ''}通知 ${new Date().toISOString().slice(0, 16)}`,
    text,
  });
}

/** 发送告警通知（所有已配置渠道并行发送，各渠道独立容错） */
export async function notifyAlerts(events: AlertEvent[]): Promise<void> {
  if (events.length === 0) return;
  const text = fmtText(events);
  const tasks: Array<Promise<void>> = [];
  const push = (name: string, p: Promise<void>): void => {
    tasks.push(p.catch((err) => logger.warn(`alert notify ${name} failed`, { message: (err as Error).message })));
  };
  push('dingtalk', notifyDingtalk(text));
  push('wecom', notifyWecom(text));
  push('webhook', notifyWebhook(events));
  push('mail', notifyMail(text, events.length));
  await Promise.all(tasks);
}
