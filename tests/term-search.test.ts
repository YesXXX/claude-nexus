import { describe, expect, it } from 'vitest';
import {
  buildSearchOptions, EMPTY_QUERY, formatCount, nextQueryState, SEARCH_DECORATIONS, validateQuery,
} from '../src/renderer/features/term-search/search-state';

describe('终端搜索查询状态', () => {
  it('输入文本只改 query，开关逐个取反', () => {
    let s = nextQueryState(EMPTY_QUERY, { kind: 'text', query: 'Error' });
    expect(s).toEqual({ query: 'Error', caseSensitive: false, regex: false, wholeWord: false });
    s = nextQueryState(s, { kind: 'toggle', option: 'caseSensitive' });
    s = nextQueryState(s, { kind: 'toggle', option: 'regex' });
    s = nextQueryState(s, { kind: 'toggle', option: 'wholeWord' });
    expect(s).toEqual({ query: 'Error', caseSensitive: true, regex: true, wholeWord: true });
    s = nextQueryState(s, { kind: 'toggle', option: 'regex' });
    expect(s.regex).toBe(false);
    // 不修改传入的对象
    expect(EMPTY_QUERY.query).toBe('');
  });

  it('搜索选项带上三个开关与高亮装饰', () => {
    const s = { query: 'x', caseSensitive: true, regex: false, wholeWord: true };
    expect(buildSearchOptions(s)).toEqual({
      caseSensitive: true, regex: false, wholeWord: true, incremental: false, decorations: SEARCH_DECORATIONS,
    });
    expect(buildSearchOptions(s, true).incremental).toBe(true);
  });

  it('装饰颜色都是 #RRGGBB', () => {
    for (const v of Object.values(SEARCH_DECORATIONS)) expect(v).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('空查询不搜，非正则模式任何文本都合法', () => {
    expect(validateQuery(EMPTY_QUERY)).toEqual({ ok: false, empty: true });
    expect(validateQuery({ ...EMPTY_QUERY, query: '([' })).toEqual({ ok: true });
  });

  it('正则模式下语法错误给出原因而不抛异常', () => {
    const bad = validateQuery({ ...EMPTY_QUERY, query: '([', regex: true });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.empty).toBe(false);
      expect(bad.error).toBeTruthy();
    }
    expect(validateQuery({ ...EMPTY_QUERY, query: 'err(or)?\\d+', regex: true })).toEqual({ ok: true });
  });

  it('计数文本：当前/总数、无结果、超过高亮上限', () => {
    expect(formatCount(2, 27, 1000)).toBe('3/27');
    expect(formatCount(-1, 0, 1000)).toBe('无结果');
    expect(formatCount(-1, 5, 1000)).toBe('-/5');
    expect(formatCount(-1, 1000, 1000)).toBe('-/1000+');
    expect(formatCount(9, 1000, 1000)).toBe('10/1000+');
  });
});
