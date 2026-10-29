import type { ContextLevel, SessionUsageSummary, UsageSettings, WindowSource } from './usage-types';

/**
 * 上下文展示与设置校验的纯函数：token 格式、上下文告警级别、摘要比较 key、设置校验。
 * 主进程与渲染层共用同一份校验，保证两边口径一致。
 */

export const DEFAULT_USAGE_SETTINGS: Readonly<UsageSettings> = Object.freeze({
  contextWarnPct: 80,
  contextDangerPct: 95,
  windows: {},
});

/** 默认设置的独立副本（调用方可自由修改） */
export function defaultUsageSettings(): UsageSettings {
  return { contextWarnPct: 80, contextDangerPct: 95, windows: {} };
}

function trimZero(s: string): string {
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/** token 数的紧凑写法：950、12.3k、162k、1.2M */
export function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${trimZero((v / 1000).toFixed(v < 10_000 ? 1 : 0))}k`;
  return `${trimZero((v / 1_000_000).toFixed(1))}M`;
}

/** 带千分位的整数 */
export function fmtInt(n: number): string {
  const v = Number.isFinite(n) ? Math.round(n) : 0;
  return v.toLocaleString('en-US');
}

export const WINDOW_SOURCE_TEXT: Record<WindowSource, string> = {
  setting: '设置',
  flag_1m: '1M 标记',
  observed: '观测推断',
  builtin: '内置表',
  default: '默认',
};

/** 上下文告警级别：达到红档为 danger，达到黄档为 warn */
export function contextLevel(pct: number, s: Pick<UsageSettings, 'contextWarnPct' | 'contextDangerPct'>): ContextLevel {
  if (pct >= s.contextDangerPct) return 'danger';
  if (pct >= s.contextWarnPct) return 'warn';
  return 'ok';
}

/** 百分比取整，限制在 0～999 */
export function pctOf(used: number, total: number): number {
  if (!(total > 0) || !(used > 0)) return 0;
  return Math.min(999, Math.round((used / total) * 100));
}

/**
 * 摘要比较 key：只含展示关心的字段（状态、上下文百分比取整等），
 * key 不变时不推送会话列表，避免整表重绘。
 */
export function summaryKey(s: SessionUsageSummary | undefined): string {
  if (!s) return '';
  const c = s.context;
  return [
    s.state, s.reason ?? '',
    c ? `${c.pct}/${c.level}/${c.window}/${c.windowSource}/${c.model}/${c.compacted ? 1 : 0}/${c.compactions ?? 0}` : '-',
  ].join('|');
}

type Sanitized = { ok: true; value: UsageSettings } | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 可选的非负数：空串、null、undefined 视为未填 */
function optNum(v: unknown): number | undefined | 'bad' {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 'bad';
}

function sanitizeKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * 设置校验：返回规范化后的设置，或第一处错误的中文说明。缺省字段取默认值；
 * 旧版设置文件里的每日预算、提醒档位与单价覆盖等字段直接忽略。
 */
export function sanitizeUsageSettings(input: unknown): Sanitized {
  if (!isObj(input)) return { ok: false, error: '设置格式不正确' };
  const out = defaultUsageSettings();

  for (const [field, name] of [['contextWarnPct', '上下文黄档'], ['contextDangerPct', '上下文红档']] as const) {
    if (input[field] === undefined) continue;
    const n = optNum(input[field]);
    if (n === undefined || n === 'bad' || n < 1 || n > 100) return { ok: false, error: `${name}必须是 1～100 之间的数` };
    out[field] = n;
  }
  if (out.contextWarnPct >= out.contextDangerPct) return { ok: false, error: '上下文黄档必须小于红档' };

  if (input.windows !== undefined) {
    if (!isObj(input.windows)) return { ok: false, error: '窗口覆盖格式不正确' };
    for (const [rawKey, v] of Object.entries(input.windows)) {
      const key = sanitizeKey(rawKey);
      if (!key || key === '*') return { ok: false, error: '窗口覆盖的模型前缀不能为空' };
      const n = optNum(v);
      if (n === undefined || n === 'bad' || !Number.isInteger(n) || n < 1000) {
        return { ok: false, error: `窗口「${key}」必须是不小于 1000 的整数` };
      }
      out.windows[key] = n;
    }
  }
  return { ok: true, value: out };
}
