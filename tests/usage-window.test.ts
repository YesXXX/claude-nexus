import { describe, it, expect } from 'vitest';
import { BUILTIN_WINDOWS, bestMatch, inferWindow, matchKey, normalizeModelId } from '../src/shared/usage-window';
import { defaultUsageSettings } from '../src/shared/usage-format';

describe('normalizeModelId', () => {
  it('转小写、去 [1m]、点换横线、去 8 位日期后缀', () => {
    expect(normalizeModelId('claude-opus-4-6-20260101')).toEqual({ id: 'claude-opus-4-6', has1m: false });
    expect(normalizeModelId('Claude-Opus-5.5[1M]')).toEqual({ id: 'claude-opus-5-5', has1m: true });
    expect(normalizeModelId('claude-opus-5-5')).toEqual({ id: 'claude-opus-5-5', has1m: false });
    expect(normalizeModelId('claude-sonnet-5[1m]')).toEqual({ id: 'claude-sonnet-5', has1m: true });
    expect(normalizeModelId('  GLM-5.3 ')).toEqual({ id: 'glm-5-3', has1m: false });
  });

  it('非 8 位数字结尾不当日期去掉', () => {
    expect(normalizeModelId('claude-haiku-4-5').id).toBe('claude-haiku-4-5');
    expect(normalizeModelId('model-1234567').id).toBe('model-1234567');
  });
});

describe('版本段边界匹配', () => {
  it('claude-opus-5 不误匹配 claude-opus-5-5，但命中非版本号的后续段', () => {
    expect(matchKey('claude-opus-5', 'claude-opus-5-5')).toBe(-1);
    expect(matchKey('claude-opus-5', 'claude-opus-5')).toBeGreaterThan(0);
    expect(matchKey('claude-opus-5', 'claude-opus-5-preview')).toBeGreaterThan(0);
  });

  it('多个命中取最长，尾部通配做普通前缀匹配', () => {
    expect(bestMatch(BUILTIN_WINDOWS, 'claude-fable-5-1')?.key).toBe('claude-fable-5-1');
    expect(bestMatch(BUILTIN_WINDOWS, 'claude-fable-5')?.key).toBe('claude-fable-5');
    expect(bestMatch(BUILTIN_WINDOWS, 'claude-fable-5-2')).toBeNull();
    expect(bestMatch({ 'glm-*': 1 }, 'glm-5-3')?.key).toBe('glm-*');
  });
});

describe('inferWindow 五级推断', () => {
  const settings = defaultUsageSettings();
  const none = new Set<string>();

  it('设置覆盖最优先', () => {
    const s = { ...settings, windows: { 'claude-haiku-*': 500_000 } };
    expect(inferWindow('claude-haiku-4-5', { settings: s, flagged1m: new Set(['claude-haiku-4-5']), observedMax: 900_000 }))
      .toEqual({ window: 500_000, source: 'setting' });
  });

  it('[1m] 标记其次', () => {
    expect(inferWindow('claude-haiku-4-5', { settings, flagged1m: new Set(['claude-haiku-4-5']), observedMax: 0 }))
      .toEqual({ window: 1_000_000, source: 'flag_1m' });
  });

  it('观测超过 200k 后按 1M', () => {
    expect(inferWindow('claude-haiku-4-5', { settings, flagged1m: none, observedMax: 250_000 }))
      .toEqual({ window: 1_000_000, source: 'observed' });
    expect(inferWindow('claude-haiku-4-5', { settings, flagged1m: none, observedMax: 200_000 }).source).toBe('builtin');
  });

  it('内置表的默认窗口，日期后缀与快速模式桶按基础模型查', () => {
    expect(inferWindow('claude-haiku-4-5-20251001', { settings, flagged1m: none, observedMax: 0 })).toEqual({ window: 200_000, source: 'builtin' });
    expect(inferWindow('claude-opus-5#fast', { settings, flagged1m: none, observedMax: 0 })).toEqual({ window: 1_000_000, source: 'builtin' });
  });

  it('都没有时 200k，不误把 claude-opus-5-5 当成 claude-opus-5', () => {
    expect(inferWindow('mock-unknown-1', { settings, flagged1m: none, observedMax: 121_000 })).toEqual({ window: 200_000, source: 'default' });
    expect(inferWindow('claude-opus-5-5', { settings, flagged1m: none, observedMax: 0 }).source).toBe('default');
  });
});
