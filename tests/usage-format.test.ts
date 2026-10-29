import { describe, it, expect } from 'vitest';
import {
  DEFAULT_USAGE_SETTINGS, contextLevel, defaultUsageSettings, fmtInt, fmtTokens, pctOf, sanitizeUsageSettings, summaryKey,
} from '../src/shared/usage-format';
import type { SessionUsageSummary } from '../src/shared/usage-types';

function summary(p: Partial<SessionUsageSummary> = {}): SessionUsageSummary {
  return { state: 'ok', updatedAt: 1, ...p };
}

describe('token 格式', () => {
  it('fmtTokens', () => {
    expect(fmtTokens(950)).toBe('950');
    expect(fmtTokens(12_300)).toBe('12k');
    expect(fmtTokens(1_500)).toBe('1.5k');
    expect(fmtTokens(162_400)).toBe('162k');
    expect(fmtTokens(850_000)).toBe('850k');
    expect(fmtTokens(1_000_000)).toBe('1M');
    expect(fmtTokens(1_200_000)).toBe('1.2M');
  });

  it('fmtInt 带千分位', () => {
    expect(fmtInt(162_400)).toBe('162,400');
  });
});

describe('上下文告警级别', () => {
  const s = DEFAULT_USAGE_SETTINGS;
  it('边界：79 正常、80 黄、94 黄、95 红', () => {
    expect(contextLevel(79, s)).toBe('ok');
    expect(contextLevel(80, s)).toBe('warn');
    expect(contextLevel(94, s)).toBe('warn');
    expect(contextLevel(95, s)).toBe('danger');
    expect(contextLevel(120, s)).toBe('danger');
  });

  it('pctOf 取整，窗口为 0 时为 0', () => {
    expect(pctOf(121_000, 1_000_000)).toBe(12);
    expect(pctOf(121_000, 200_000)).toBe(61);
    expect(pctOf(5, 0)).toBe(0);
  });
});

describe('summaryKey', () => {
  it('只有 updatedAt 变化时 key 不变', () => {
    expect(summaryKey(summary({ updatedAt: 1 }))).toBe(summaryKey(summary({ updatedAt: 9 })));
  });

  it('状态、上下文百分比变化时 key 改变', () => {
    const base = summaryKey(summary());
    expect(summaryKey(summary({ state: 'no_data' }))).not.toBe(base);
    const ctx = { used: 1, window: 2, pct: 12, level: 'ok' as const, model: 'm', windowSource: 'default' as const, compacted: false, at: 1 };
    expect(summaryKey(summary({ context: ctx }))).not.toBe(summaryKey(summary({ context: { ...ctx, pct: 13 } })));
    expect(summaryKey(undefined)).toBe('');
  });
});

describe('sanitizeUsageSettings', () => {
  it('空对象取默认值', () => {
    expect(sanitizeUsageSettings({})).toEqual({ ok: true, value: defaultUsageSettings() });
  });

  it('合法设置规范化：前缀转小写、字符串数字可用', () => {
    const r = sanitizeUsageSettings({ contextWarnPct: '70', contextDangerPct: 90, windows: { ' Mock-* ': '500000' } });
    expect(r).toEqual({ ok: true, value: { contextWarnPct: 70, contextDangerPct: 90, windows: { 'mock-*': 500_000 } } });
  });

  it('旧版设置里的预算、档位与单价覆盖被忽略，其余字段照常读取', () => {
    const r = sanitizeUsageSettings({
      dailyBudgetUsd: 20, budgetAlertPcts: [100, 80], prices: { 'glm-*': { input: -1 } }, contextWarnPct: 60, windows: {},
    });
    expect(r).toEqual({ ok: true, value: { ...defaultUsageSettings(), contextWarnPct: 60 } });
  });

  it.each([
    ['非对象', 5],
    ['黄档不小于红档', { contextWarnPct: 95, contextDangerPct: 95 }],
    ['红档超过 100', { contextDangerPct: 120 }],
    ['黄档为 0', { contextWarnPct: 0 }],
    ['前缀为空', { windows: { ' ': 500_000 } }],
    ['窗口太小', { windows: { 'glm-*': 10 } }],
    ['窗口非整数', { windows: { 'glm-*': 1000.5 } }],
  ])('非法输入被拒绝：%s', (_name, input) => {
    const r = sanitizeUsageSettings(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});
