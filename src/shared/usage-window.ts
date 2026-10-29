import type { UsageSettings, WindowSource } from './usage-types';

/**
 * 模型 id 归一化与上下文窗口推断。
 * 内置表只记录已确认的各模型默认窗口；其余模型（含通过兼容端点使用的第三方模型）按观测或默认 200k 推断，
 * 也可由用户在设置里按模型前缀覆盖。
 */

const WINDOW_1M = 1_000_000;
const WINDOW_DEFAULT = 200_000;
/** 观测到单次上下文超过该值即认定为 1M 窗口 */
const OBSERVED_1M_THRESHOLD = 200_000;

/** 内置的模型默认上下文窗口（key 为模型前缀，按版本段边界匹配） */
export const BUILTIN_WINDOWS: Readonly<Record<string, number>> = {
  'claude-fable-5-1': WINDOW_1M,
  'claude-fable-5': WINDOW_1M,
  'claude-opus-5': WINDOW_1M,
  'claude-opus-4-8': WINDOW_1M,
  'claude-opus-4-7': WINDOW_1M,
  'claude-opus-4-6': WINDOW_1M,
  'claude-sonnet-5': WINDOW_1M,
  'claude-sonnet-4-6': WINDOW_1M,
  'claude-haiku-4-5': WINDOW_DEFAULT,
};

/** 快速模式桶的后缀 */
export const FAST_SUFFIX = '#fast';

/**
 * 模型 id 归一化：转小写 → 去掉 [1m] → `.` 换成 `-` → 去掉 8 位日期后缀。
 * 同一模型在 transcript 与 cost-state 中写法不同（如 claude-opus-5-5 与 Claude-Opus-5.5[1M]），归一化后一致。
 */
export function normalizeModelId(raw: string): { id: string; has1m: boolean } {
  let s = String(raw ?? '').trim().toLowerCase();
  const has1m = s.includes('[1m]');
  s = s.replace(/\[1m\]/g, '').replace(/\./g, '-').replace(/-\d{8}$/, '');
  return { id: s, has1m };
}

/** 设置中的前缀 key 归一化（保留尾部 *） */
function normalizeKey(key: string): string {
  const star = key.trim().endsWith('*');
  const base = normalizeModelId(star ? key.trim().slice(0, -1) : key).id;
  return star ? `${base}*` : base;
}

/**
 * 前缀是否以版本段为边界命中 id：相等，或 id 以 `key-` 开头且下一段不是 1～2 位纯数字。
 * 尾部带 * 的 key 做普通前缀匹配。返回命中长度，未命中返回 -1。
 */
export function matchKey(key: string, id: string): number {
  const k = normalizeKey(key);
  if (!k) return -1;
  if (k.endsWith('*')) {
    const p = k.slice(0, -1);
    return id.startsWith(p) ? p.length : -1;
  }
  if (id === k) return k.length;
  if (!id.startsWith(`${k}-`)) return -1;
  const next = id.slice(k.length + 1).split('-')[0];
  return /^\d{1,2}$/.test(next) ? -1 : k.length;
}

/** 在一组前缀表中找最长命中的 key */
export function bestMatch<T>(table: Readonly<Record<string, T>>, id: string): { key: string; value: T } | null {
  let best: { key: string; value: T; len: number } | null = null;
  for (const [key, value] of Object.entries(table)) {
    const len = matchKey(key, id);
    if (len >= 0 && (!best || len > best.len)) best = { key, value, len };
  }
  return best ? { key: best.key, value: best.value } : null;
}

/** 去掉快速模式后缀 */
export function baseModelOf(bucket: string): { id: string; fast: boolean } {
  return bucket.endsWith(FAST_SUFFIX)
    ? { id: bucket.slice(0, -FAST_SUFFIX.length), fast: true }
    : { id: bucket, fast: false };
}

/**
 * 上下文窗口推断，取第一个命中：
 * 设置覆盖 → [1m] 标记 → 本会话观测超过 200k 后按 1M → 内置表 → 200k。
 */
export function inferWindow(
  id: string,
  ctx: { settings: Pick<UsageSettings, 'windows'>; flagged1m: ReadonlySet<string>; observedMax: number },
): { window: number; source: WindowSource } {
  const norm = normalizeModelId(baseModelOf(id).id).id;
  const setting = bestMatch(ctx.settings.windows ?? {}, norm);
  if (setting && Number.isFinite(setting.value) && setting.value > 0) return { window: setting.value, source: 'setting' };
  if (ctx.flagged1m.has(norm)) return { window: WINDOW_1M, source: 'flag_1m' };
  if (ctx.observedMax > OBSERVED_1M_THRESHOLD) return { window: WINDOW_1M, source: 'observed' };
  const builtin = bestMatch(BUILTIN_WINDOWS, norm);
  if (builtin) return { window: builtin.value, source: 'builtin' };
  return { window: WINDOW_DEFAULT, source: 'default' };
}
