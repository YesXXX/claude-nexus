/**
 * 敏感内容打码：识别常见密钥、令牌、口令键值、URL 内嵌账号与长随机串，替换为 *** 后再按需截断。
 * 活动日志与远程通知共用，规则宁可多打码也不漏打码；纯函数，主进程与渲染层都可用。
 */

const MASK = '***';

/** 按顺序应用；每条规则只替换敏感部分，保留可读的前缀（如 Bearer、password=） */
const RULES: Array<[RegExp, string]> = [
  // URL 内嵌账号密码：scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@:]+(?::[^/\s@]*)?@/gi, `$1${MASK}@`],
  // Authorization: Bearer xxx / Basic xxx
  [/\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{6,}/g, `$1$2${MASK}`],
  // 口令与令牌类键值：password=xx、token: xx、"api_key": "xx"、--password xx；
  // 值为 Bearer / Basic 等认证方案时上一条已打码，这里保留方案名
  [/\b([\w-]*?(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|auth(?:orization)?|client[_-]?secret|private[_-]?key)["']?\s*[=:]\s*["']?)(?!(?:Bearer|Basic|Token)\s)[^\s"'&,;)]+/gi, `$1${MASK}`],
  [/(--?(?:password|passwd|token|secret|api-key)[= ])("[^"]*"|'[^']*'|\S+)/gi, `$1${MASK}`],
  // 厂商令牌前缀
  [/\bsk-[A-Za-z0-9_-]{12,}/g, `sk-${MASK}`],
  [/\b(gh[pousr]_)[A-Za-z0-9]{16,}/g, `$1${MASK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, `github_pat_${MASK}`],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, `$1${MASK}`],
  [/\b(xox[abposr]-)[A-Za-z0-9-]{8,}/g, `$1${MASK}`],
  // JWT：三段 base64url，以 eyJ 开头
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, MASK],
  // 32 位以上十六进制串（哈希、密钥）
  [/\b[0-9a-fA-F]{32,}\b/g, MASK],
];

/** 32 位以上的 base64 / base64url 串，且同时含数字、大写、小写字母，避免误伤普通长单词与路径 */
const LONG_B64 = /[A-Za-z0-9+_-]{32,}={0,2}/g;

function maskLongBase64(text: string): string {
  return text.replace(LONG_B64, s => (/\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s) ? MASK : s));
}

/** 打码：替换所有识别出的敏感片段 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return maskLongBase64(out);
}

/**
 * 按 UTF-16 长度截断到 max（含末尾省略号），不切断代理对；未超长原样返回。
 * max 小于 1 时返回空串。
 */
export function truncateText(text: string, max: number): string {
  if (max < 1) return '';
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  // 截断点落在高位代理之后会留下半个字符，退一位
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** 先打码再截断；max 缺省不截断 */
export function redact(text: string, max?: number): string {
  const masked = redactSecrets(text);
  return max === undefined ? masked : truncateText(masked, max);
}
