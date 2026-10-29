import * as path from 'path';
import { randomUUID } from 'crypto';
import type { NotifyKind } from '../shared/types';
import {
  WEBHOOK_MAX_TARGETS, WEBHOOK_PLATFORMS, type WebhookConfig, type WebhookConfigDraft, type WebhookTarget,
  type WebhookTargetView,
} from '../shared/webhook-types';
import { maskWebhookUrl, validateWebhookUrl } from './webhook-format';
import { readJson, writeJsonAtomic } from './json-store';
import { log } from './logger';

/**
 * 远程通知配置：落盘 `<panelHome>/webhook.json`，URL 与 secret 用系统加密（safeStorage）保存为
 * `enc:v1:<base64>`，加密不可用时保存为 `plain:<原文>`。内存里保存解密后的配置，
 * 渲染层只拿脱敏视图；保存时留空或等于脱敏值的 URL、留空的 secret 表示沿用原值。
 */

/** 系统加密器：主进程注入 safeStorage，单测注入假实现 */
export interface SecretCipher {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(b64: string): string;
}

export const ALL_KINDS: readonly NotifyKind[] = ['permission', 'input', 'turn', 'ended', 'error', 'lost', 'overdue', 'budget'];

const DEFAULT_EVENTS: Record<NotifyKind, boolean> = {
  permission: true, input: false, turn: true, ended: true, error: true, lost: true, overdue: false, budget: true,
};

export function defaultWebhookConfig(): WebhookConfig {
  return {
    version: 1, enabled: false, targets: [], events: { ...DEFAULT_EVENTS },
    when: 'away', awayMinutes: 5, quiet: { enabled: false, start: '22:00', end: '08:00' },
    throttleSec: 60, includeSummary: true,
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isHhmm(v: unknown): v is string {
  return typeof v === 'string' && HHMM.test(v);
}

function seal(cipher: SecretCipher, plain: string): string {
  if (!plain) return '';
  if (cipher.available()) {
    try { return `enc:v1:${cipher.encrypt(plain)}`; } catch (err) { log('webhook', `加密失败，改为明文保存：${String(err)}`); }
  }
  return `plain:${plain}`;
}

function unseal(cipher: SecretCipher, stored: unknown): string {
  if (typeof stored !== 'string' || !stored) return '';
  if (stored.startsWith('plain:')) return stored.slice(6);
  if (stored.startsWith('enc:v1:')) {
    try { return cipher.decrypt(stored.slice(7)); } catch (err) {
      log('webhook', `解密失败，该项按未设置处理：${String(err)}`);
      return '';
    }
  }
  return '';
}

function num(v: unknown, def: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def;
}

/** 把磁盘或输入中的任意对象规整为合法配置；非法字段回落默认值 */
function normalize(raw: unknown, cipher: SecretCipher): WebhookConfig {
  const def = defaultWebhookConfig();
  if (!raw || typeof raw !== 'object') return def;
  const r = raw as Record<string, unknown>;
  const events = { ...def.events };
  const ev = r.events as Record<string, unknown> | undefined;
  if (ev && typeof ev === 'object') for (const k of ALL_KINDS) if (typeof ev[k] === 'boolean') events[k] = ev[k] as boolean;
  const q = (r.quiet ?? {}) as Record<string, unknown>;
  const targets: WebhookTarget[] = [];
  if (Array.isArray(r.targets)) {
    for (const t of r.targets.slice(0, WEBHOOK_MAX_TARGETS)) {
      if (!t || typeof t !== 'object') continue;
      const o = t as Record<string, unknown>;
      const platform = WEBHOOK_PLATFORMS.includes(o.platform as never) ? o.platform as WebhookTarget['platform'] : 'wecom';
      const secret = unseal(cipher, o.secret);
      targets.push({
        id: typeof o.id === 'string' && o.id ? o.id : randomUUID(),
        name: typeof o.name === 'string' ? o.name.slice(0, 40) : '',
        platform, enabled: o.enabled !== false, url: unseal(cipher, o.url),
        ...(secret ? { secret } : {}),
      });
    }
  }
  return {
    version: 1,
    enabled: r.enabled === true,
    targets,
    events,
    when: r.when === 'always' ? 'always' : 'away',
    awayMinutes: num(r.awayMinutes, def.awayMinutes, 1, 240),
    quiet: {
      enabled: q.enabled === true,
      start: isHhmm(q.start) ? q.start : def.quiet.start,
      end: isHhmm(q.end) ? q.end : def.quiet.end,
    },
    throttleSec: num(r.throttleSec, def.throttleSec, 0, 3600),
    includeSummary: r.includeSummary !== false,
  };
}

export function targetView(t: WebhookTarget): WebhookTargetView {
  const { url, secret, ...rest } = t;
  return { ...rest, urlMasked: maskWebhookUrl(url), hasSecret: !!secret };
}

/**
 * 校验渲染层提交的草稿并与已保存的配置合并，返回合并后的配置或逐字段错误。
 * 键名：enabled 以外的字段按路径给出，如 targets.0.url、awayMinutes、quiet.start。
 */
export function mergeDraft(
  current: WebhookConfig, draft: WebhookConfigDraft,
): { ok: true; config: WebhookConfig } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!draft || typeof draft !== 'object') return { ok: false, errors: { form: '提交的内容无效' } };
  const list = Array.isArray(draft.targets) ? draft.targets : [];
  if (list.length > WEBHOOK_MAX_TARGETS) errors.targets = `最多 ${WEBHOOK_MAX_TARGETS} 个目标`;
  const targets: WebhookTarget[] = [];
  list.slice(0, WEBHOOK_MAX_TARGETS).forEach((d, i) => {
    const old = d.id ? current.targets.find(t => t.id === d.id) : undefined;
    const typed = typeof d.url === 'string' ? d.url.trim() : '';
    const keep = !!old && (!typed || typed === maskWebhookUrl(old.url));
    const url = keep ? old!.url : typed;
    const urlErr = validateWebhookUrl(url);
    if (urlErr) errors[`targets.${i}.url`] = urlErr;
    if (!WEBHOOK_PLATFORMS.includes(d.platform)) errors[`targets.${i}.platform`] = '请选择平台';
    const typedSecret = typeof d.secret === 'string' ? d.secret.trim() : '';
    const secret = d.clearSecret ? '' : typedSecret || old?.secret || '';
    const name = typeof d.name === 'string' ? d.name.trim().slice(0, 40) : '';
    targets.push({
      id: old ? old.id : (typeof d.id === 'string' && d.id && !current.targets.some(t => t.id === d.id) ? d.id : randomUUID()),
      name: name || `目标 ${i + 1}`, platform: d.platform, enabled: d.enabled !== false, url,
      ...(secret && d.platform !== 'wecom' ? { secret } : {}),
    });
  });
  const aw = draft.awayMinutes;
  if (typeof aw !== 'number' || !Number.isInteger(aw) || aw < 1 || aw > 240) errors.awayMinutes = '离开判定为 1–240 的整数分钟';
  const th = draft.throttleSec;
  if (typeof th !== 'number' || !Number.isInteger(th) || th < 0 || th > 3600) errors.throttleSec = '节流为 0–3600 的整数秒';
  const q = draft.quiet ?? { enabled: false, start: '', end: '' };
  if (!isHhmm(q.start)) errors['quiet.start'] = '时间格式为 HH:mm';
  if (!isHhmm(q.end)) errors['quiet.end'] = '时间格式为 HH:mm';
  if (q.enabled && isHhmm(q.start) && q.start === q.end) errors['quiet.end'] = '开始与结束不能相同';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const events = { ...defaultWebhookConfig().events };
  for (const k of ALL_KINDS) if (typeof draft.events?.[k] === 'boolean') events[k] = draft.events[k];
  return {
    ok: true,
    config: {
      version: 1, enabled: draft.enabled === true, targets, events,
      when: draft.when === 'always' ? 'always' : 'away', awayMinutes: aw, quiet: { enabled: q.enabled === true, start: q.start, end: q.end },
      throttleSec: th, includeSummary: draft.includeSummary !== false,
    },
  };
}

export class WebhookConfigStore {
  private config: WebhookConfig;

  constructor(private readonly file: string, private readonly cipher: SecretCipher) {
    this.config = this.load();
  }

  static fileIn(home: string): string {
    return path.join(home, 'webhook.json');
  }

  private load(): WebhookConfig {
    const raw = readJson(this.file, { tag: 'webhook' });
    if (raw === null) return defaultWebhookConfig();
    return normalize(raw, this.cipher);
  }

  get(): WebhookConfig {
    return this.config;
  }

  encryptionAvailable(): boolean {
    try { return this.cipher.available(); } catch { return false; }
  }

  views(): WebhookTargetView[] {
    return this.config.targets.map(targetView);
  }

  /** 校验并保存；写盘失败时内存配置不变 */
  save(draft: WebhookConfigDraft): { ok: true } | { ok: false; errors: Record<string, string> } {
    const r = mergeDraft(this.config, draft);
    if (!r.ok) return r;
    const disk = {
      ...r.config,
      targets: r.config.targets.map(t => ({
        id: t.id, name: t.name, platform: t.platform, enabled: t.enabled,
        url: seal(this.cipher, t.url), ...(t.secret ? { secret: seal(this.cipher, t.secret) } : {}),
      })),
    };
    if (!writeJsonAtomic(this.file, disk, { tag: 'webhook' })) return { ok: false, errors: { form: '写入配置文件失败' } };
    this.config = r.config;
    log('webhook', `配置已保存：${r.config.enabled ? '启用' : '停用'}，目标 ${r.config.targets.length} 个`);
    return { ok: true };
  }
}
