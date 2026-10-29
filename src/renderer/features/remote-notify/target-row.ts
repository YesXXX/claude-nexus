import {
  WEBHOOK_PLATFORMS, WEBHOOK_PLATFORM_TEXT, type WebhookPlatform, type WebhookSendResult, type WebhookTargetDraft,
  type WebhookTargetView,
} from '../../../shared/webhook-types.js';
import { detectPlatform, isLoopbackUrl, validateWebhookUrl } from '../../../shared/webhook-url.js';
import { el } from '../../core/dom.js';

/**
 * 远程通知设置里的单个目标行：启用、名称、平台、地址、加签密钥、最近结果与测试 / 删除按钮。
 * 已保存的目标地址框里显示脱敏地址，原样提交表示沿用；secret 永远不回显，留空表示沿用。
 * 地址输入时即时提示格式问题，并按域名自动选平台；最终以主进程返回的逐字段错误为准。
 */

export interface TargetRow {
  id: string;
  root: HTMLElement;
  enabled: HTMLInputElement;
  name: HTMLInputElement;
  platform: HTMLSelectElement;
  url: HTMLInputElement;
  secret: HTMLInputElement;
  secretBox: HTMLElement;
  clearSecret: HTMLButtonElement;
  hint: HTMLElement;
  last: HTMLElement;
  test: HTMLButtonElement;
  del: HTMLButtonElement;
  /** 已保存的脱敏地址；新目标为空 */
  masked: string;
  hasSecret: boolean;
  clearing: boolean;
}

export interface TargetRowHooks {
  onTest(row: TargetRow): void;
  onDelete(row: TargetRow): void;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function input(type: string, cls: string, placeholder = ''): HTMLInputElement {
  const i = el('input', cls);
  i.type = type;
  i.placeholder = placeholder;
  i.spellcheck = false;
  i.autocomplete = 'off';
  return i;
}

function smallButton(text: string, cls: string): HTMLButtonElement {
  const b = el('button', `btn sm ${cls}`, text);
  b.type = 'button';
  return b;
}

/** 平台切换后：企业微信不支持加签，隐藏 secret；钉钉提示可改用关键词 */
function syncPlatform(r: TargetRow): void {
  const p = r.platform.value as WebhookPlatform;
  r.secretBox.hidden = p === 'wecom';
  r.root.dataset.platform = p;
}

function secretPlaceholder(r: TargetRow): void {
  if (r.clearing) r.secret.placeholder = '保存后将删除已设置的 secret';
  else if (r.hasSecret) r.secret.placeholder = '已设置，留空不修改';
  else r.secret.placeholder = '加签 secret（可选）';
  r.clearSecret.hidden = !r.hasSecret;
  r.clearSecret.textContent = r.clearing ? '撤销清除' : '清除';
}

/** 地址即时提示：格式错误给出原因；域名不在三平台列表时只做提醒，不阻止保存 */
export function urlHint(r: TargetRow): string {
  const v = r.url.value.trim();
  if (r.masked && (v === '' || v === r.masked)) return '';
  const err = validateWebhookUrl(v);
  if (err) return err;
  if (!detectPlatform(v) && !isLoopbackUrl(v)) return '域名不在企业微信 / 钉钉 / 飞书之列，将按所选平台的格式发送（自建转发可忽略）';
  return '';
}

function refreshHint(r: TargetRow): void {
  const text = urlHint(r);
  r.hint.classList.remove('err');
  r.hint.textContent = text;
  r.hint.hidden = !text;
}

export function setRowError(r: TargetRow, text: string): void {
  if (!text) { refreshHint(r); return; }
  r.hint.textContent = text;
  r.hint.hidden = false;
  r.hint.classList.add('err');
}

/** 最近一次结果与熔断提示 */
export function setRowLast(r: TargetRow, res: WebhookSendResult | undefined, openUntil?: number): void {
  r.last.classList.toggle('ok', !!res?.ok);
  r.last.classList.toggle('fail', !!res && !res.ok);
  let text = res
    ? `最近：${hhmm(res.at)} ${res.ok ? '成功' : '失败'} · ${res.ms}ms${res.ok ? '' : ` · ${res.error ?? '未知原因'}`}`
    : '最近：尚未发送';
  if (openUntil && openUntil > Date.now()) text += `　连续失败已熔断，${hhmm(openUntil)} 后恢复`;
  r.last.textContent = text;
}

export function createTargetRow(view: WebhookTargetView | null, hooks: TargetRowHooks): TargetRow {
  const root = el('div', 'rn-target');
  const enabled = input('checkbox', 'rn-t-enabled');
  enabled.title = '启用此目标';
  enabled.checked = view ? view.enabled : true;
  const name = input('text', 'rn-t-name', '名称，如研发群');
  name.value = view?.name ?? '';
  const platform = el('select', 'rn-t-platform');
  for (const p of WEBHOOK_PLATFORMS) {
    const o = el('option', '', WEBHOOK_PLATFORM_TEXT[p]);
    o.value = p;
    platform.appendChild(o);
  }
  platform.value = view?.platform ?? 'wecom';
  const url = input('text', 'rn-t-url', '粘贴群机器人 webhook 地址');
  url.value = view?.urlMasked ?? '';
  const secret = input('password', 'rn-t-secret');
  const clearSecret = smallButton('清除', 'rn-t-clear');
  const secretBox = el('div', 'rn-t-secretbox');
  secretBox.append(secret, clearSecret, el('span', 'rn-t-tip', '钉钉也可在机器人安全设置里用关键词 Nexus'));
  const hint = el('div', 'rn-hint');
  hint.hidden = true;
  const last = el('div', 'rn-t-last');
  const test = smallButton('测试', 'rn-t-test');
  const del = smallButton('删除', 'rn-t-del');

  const head = el('div', 'rn-t-head');
  head.append(enabled, name, platform);
  const foot = el('div', 'rn-t-foot');
  foot.append(last, test, del);
  root.append(head, url, hint, secretBox, foot);

  const r: TargetRow = {
    id: view?.id ?? newId(), root, enabled, name, platform, url, secret, secretBox, clearSecret, hint, last, test, del,
    masked: view?.urlMasked ?? '', hasSecret: !!view?.hasSecret, clearing: false,
  };
  root.dataset.id = r.id;
  syncPlatform(r);
  secretPlaceholder(r);
  setRowLast(r, undefined);

  url.addEventListener('input', () => {
    r.hint.classList.remove('err');
    const p = detectPlatform(url.value);
    if (p && p !== platform.value) { platform.value = p; syncPlatform(r); }
    refreshHint(r);
  });
  platform.addEventListener('change', () => syncPlatform(r));
  clearSecret.addEventListener('click', () => {
    r.clearing = !r.clearing;
    if (r.clearing) secret.value = '';
    secretPlaceholder(r);
  });
  secret.addEventListener('input', () => {
    if (r.clearing && secret.value) { r.clearing = false; secretPlaceholder(r); }
  });
  test.addEventListener('click', () => hooks.onTest(r));
  del.addEventListener('click', () => hooks.onDelete(r));
  return r;
}

/** 收集为草稿；地址等于脱敏值时原样提交，由主进程识别为沿用 */
export function rowDraft(r: TargetRow): WebhookTargetDraft {
  const platform = r.platform.value as WebhookPlatform;
  const secret = platform === 'wecom' ? '' : r.secret.value.trim();
  return {
    id: r.id, name: r.name.value.trim(), platform, enabled: r.enabled.checked, url: r.url.value.trim(),
    ...(secret ? { secret } : {}), ...(r.clearing ? { clearSecret: true } : {}),
  };
}
