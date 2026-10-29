import type { WebhookPlatform } from './webhook-types';

/**
 * webhook 地址规则：平台识别、回环判定与 https 校验。主进程保存时与渲染层即时提示共用同一份实现。
 */

const PLATFORM_HOSTS: Array<[RegExp, WebhookPlatform]> = [
  [/^qyapi\.weixin\.qq\.com$/i, 'wecom'],
  [/^oapi\.dingtalk\.com$/i, 'dingtalk'],
  [/^open\.(feishu\.cn|larksuite\.com)$/i, 'feishu'],
];

export function parseUrl(url: string): URL | null {
  try { return new URL(url.trim()); } catch { return null; }
}

/** 按域名识别平台，识别不了返回 null */
export function detectPlatform(url: string): WebhookPlatform | null {
  const u = parseUrl(url);
  if (!u) return null;
  for (const [re, p] of PLATFORM_HOSTS) if (re.test(u.hostname)) return p;
  return null;
}

/** 回环地址：localhost、127.0.0.0/8、::1 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

export function isLoopbackUrl(url: string): boolean {
  const u = parseUrl(url);
  return !!u && isLoopbackHost(u.hostname);
}

/** URL 校验：必须是 https，http 只允许回环地址；返回错误文本，合法返回 null */
export function validateWebhookUrl(url: string): string | null {
  const text = url.trim();
  if (!text) return '请填写 webhook 地址';
  const u = parseUrl(text);
  if (!u || !u.hostname) return '地址格式不正确';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:') return isLoopbackHost(u.hostname) ? null : '只允许 https 地址（http 仅限本机回环地址）';
  return '只允许 https 地址';
}
