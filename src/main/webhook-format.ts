import { createHmac } from 'crypto';
import type { NotificationPayload, NotifyKind } from '../shared/types';
import type { WebhookPlatform, WebhookTarget } from '../shared/webhook-types';
import { redact } from '../shared/redact';
import { parseUrl } from '../shared/webhook-url';

/**
 * webhook 消息格式化：平台识别、URL 规则与脱敏、钉钉 / 飞书加签、三平台消息体、响应判定。
 * 全部是纯函数，时间与主机名由调用方传入。
 */

export const SUMMARY_MAX = 80;
const BRAND = 'Claude Nexus';

export { detectPlatform, isLoopbackHost, isLoopbackUrl, validateWebhookUrl } from '../shared/webhook-url';

function maskToken(v: string): string {
  return v.length <= 4 ? '****' : `****${v.slice(-4)}`;
}

/** 脱敏：查询参数值与较长的路径段只保留末 4 位，便于辨认又不泄露令牌 */
export function maskWebhookUrl(url: string): string {
  const u = parseUrl(url);
  if (!u) return url ? maskToken(url) : '';
  const path = u.pathname.split('/').map(seg => (seg.length >= 16 ? maskToken(seg) : seg)).join('/');
  const params = [...u.searchParams.entries()].map(([k, v]) => `${k}=${maskToken(v)}`);
  return `${u.protocol}//${u.host}${path}${params.length ? `?${params.join('&')}` : ''}`;
}

/** 钉钉加签：HMAC-SHA256(secret, `${timestamp}\n${secret}`) 的 base64，timestamp 为毫秒 */
export function dingtalkSign(secret: string, timestampMs: number): string {
  return createHmac('sha256', secret).update(`${timestampMs}\n${secret}`).digest('base64');
}

/** 飞书签名校验：以 `${timestamp}\n${secret}` 为密钥对空串做 HMAC-SHA256 的 base64，timestamp 为秒 */
export function feishuSign(secret: string, timestampSec: number): string {
  return createHmac('sha256', `${timestampSec}\n${secret}`).update('').digest('base64');
}

/** 拼好的消息：首行标题加若干「键：值」行，末尾可附一行备注 */
export interface WebhookMessage {
  heading: string;
  lines: Array<[string, string]>;
  note?: string;
}

const KIND_TITLE: Record<NotifyKind, string> = {
  permission: '🔐 等待批准',
  input: '✋ 等待输入',
  turn: '✅ 本轮结束',
  ended: '⏹ 会话已退出',
  error: '❌ 异常退出',
  lost: '🔌 失联',
  overdue: '⏰ 仍在等待',
  budget: '📏 上下文告警',
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地时间 MM-DD HH:mm:ss */
export function stampText(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 单行化：去掉换行与 markdown 引用符，避免把消息结构打乱 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** cwd 只取末段，兼容 / 与 \ */
export function cwdTailOf(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

export interface BuildOptions {
  includeSummary: boolean;
  now: number;
  /** 限流期间被丢弃的条数，大于 0 时附注 */
  dropped?: number;
}

/** 通知转消息：会话、状态、目录、摘要（打码并截断到 80 字符）与时间；不含完整路径与终端输出 */
export function buildMessage(n: NotificationPayload, opts: BuildOptions): WebhookMessage {
  const kind = n.kind ?? 'turn';
  const m = n.meta ?? {};
  let heading = `${BRAND} · ${KIND_TITLE[kind]}`;
  if (kind === 'overdue' && m.status) heading = `${BRAND} · ⏰ ${oneLine(m.status)}`;
  const lines: Array<[string, string]> = [];
  if (m.label) lines.push(['会话', oneLine(redact(m.label, 40))]);
  if (m.status && kind !== 'overdue') lines.push(['状态', oneLine(m.status)]);
  if (m.cwdTail) lines.push(['目录', oneLine(redact(cwdTailOf(m.cwdTail), 60))]);
  if (opts.includeSummary && m.summary) lines.push(['摘要', oneLine(redact(oneLine(m.summary), SUMMARY_MAX))]);
  else if (!opts.includeSummary && m.toolName && kind !== 'permission') lines.push(['工具', oneLine(m.toolName)]);
  lines.push(['时间', stampText(n.createdAt || opts.now)]);
  const msg: WebhookMessage = { heading, lines };
  if (opts.dropped && opts.dropped > 0) msg.note = `（期间另有 ${opts.dropped} 条通知因限流未发送）`;
  return msg;
}

/** 测试消息：「Claude Nexus · 测试消息｜来自 <计算机名>，时间 …，配置可用」 */
export function testMessage(hostname: string, now: number): WebhookMessage {
  return {
    heading: `${BRAND} · 测试消息`,
    lines: [['来自', oneLine(hostname) || '本机'], ['时间', stampText(now)], ['结果', '配置可用']],
  };
}

export function markdownText(msg: WebhookMessage): string {
  const out = [`**${msg.heading}**`, ...msg.lines.map(([k, v]) => `> ${k}：${v}`)];
  if (msg.note) out.push(msg.note);
  return out.join('\n');
}

export function plainText(msg: WebhookMessage): string {
  const out = [msg.heading, ...msg.lines.map(([k, v]) => `${k}：${v}`)];
  if (msg.note) out.push(msg.note);
  return out.join('\n');
}

export interface WebhookRequest {
  url: string;
  body: string;
}

/** 生成请求：钉钉签名放查询参数，飞书签名放消息体；企业微信不加签 */
export function buildRequest(target: Pick<WebhookTarget, 'platform' | 'url' | 'secret'>, msg: WebhookMessage, now: number): WebhookRequest {
  const secret = target.secret?.trim();
  switch (target.platform) {
    case 'wecom':
      return { url: target.url, body: JSON.stringify({ msgtype: 'markdown', markdown: { content: markdownText(msg) } }) };
    case 'dingtalk': {
      let url = target.url;
      if (secret) {
        const u = new URL(target.url);
        u.searchParams.set('timestamp', String(now));
        u.searchParams.set('sign', dingtalkSign(secret, now));
        url = u.toString();
      }
      return { url, body: JSON.stringify({ msgtype: 'markdown', markdown: { title: msg.heading, text: markdownText(msg) } }) };
    }
    case 'feishu': {
      const body: Record<string, unknown> = { msg_type: 'text', content: { text: plainText(msg) } };
      if (secret) {
        const ts = Math.floor(now / 1000);
        body.timestamp = String(ts);
        body.sign = feishuSign(secret, ts);
      }
      return { url: target.url, body: JSON.stringify(body) };
    }
  }
}

/**
 * 响应判定：HTTP 2xx，且企业微信 / 钉钉 errcode 为 0、飞书 code（旧版 StatusCode）为 0 才算成功；
 * 响应体不是 JSON 或不带这些字段时只看 HTTP 状态（兼容自建转发服务）。
 */
export function judgeResponse(platform: WebhookPlatform, status: number, text: string): { ok: boolean; error?: string } {
  if (status < 200 || status >= 300) return { ok: false, error: `HTTP ${status}${text ? `：${oneLine(redact(text, 120))}` : ''}` };
  let data: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object') data = v as Record<string, unknown>;
  } catch { /* 非 JSON 只看状态码 */ }
  if (!data) return { ok: true };
  const code = platform === 'feishu' ? (data.code ?? data.StatusCode) : data.errcode;
  if (code === undefined || code === 0) return { ok: true };
  const msg = platform === 'feishu' ? (data.msg ?? data.StatusMessage) : data.errmsg;
  return { ok: false, error: `平台返回 ${String(code)}${typeof msg === 'string' && msg ? `：${oneLine(redact(msg, 120))}` : ''}` };
}
