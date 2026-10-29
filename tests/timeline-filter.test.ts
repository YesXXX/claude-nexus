import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '../src/shared/activity';
import {
  dayLabel, emptyFilter, eventsToText, isFilterEmpty, matchesFilter, mergeEvents, sessionHue, timeText, toQuery, typesOf,
} from '../src/renderer/features/timeline/timeline-filter';

function ev(p: Partial<ActivityEvent> & { id: string; seq: number }): ActivityEvent {
  return { rev: 1, at: 1_700_000_000_000, updatedAt: 1_700_000_000_000, type: 'turn.end', level: 'info', source: 't', title: 't', ...p };
}

describe('时间线过滤与合并', () => {
  it('空过滤条件不带任何查询字段', () => {
    expect(isFilterEmpty(emptyFilter())).toBe(true);
    expect(toQuery(emptyFilter())).toEqual({});
  });

  it('类别展开为事件类型，与会话、仅需关注一起转为查询', () => {
    expect(typesOf(['git'])).toEqual(['git.commit', 'git.merge']);
    expect(toQuery({ sessionIds: ['s1'], categories: ['budget', 'verify'], attentionOnly: true }))
      .toEqual({ sessionIds: ['s1'], types: ['budget.alert', 'verify.result'], attentionOnly: true });
  });

  it('增量过滤与主进程同一口径', () => {
    const f = { sessionIds: ['s1'], categories: ['turn' as const], attentionOnly: false };
    expect(matchesFilter(ev({ id: 'a', seq: 1, sessionId: 's1', type: 'tool.batch' }), f)).toBe(true);
    expect(matchesFilter(ev({ id: 'b', seq: 2, sessionId: 's2', type: 'tool.batch' }), f)).toBe(false);
    expect(matchesFilter(ev({ id: 'c', seq: 3, sessionId: 's1', type: 'git.commit' }), f)).toBe(false);
  });

  it('合并：同 id 取更高 rev，结果按 seq 倒序，不改入参', () => {
    const list = [ev({ id: 'b', seq: 2 }), ev({ id: 'a', seq: 1 })];
    const out = mergeEvents(list, [ev({ id: 'a', seq: 1, rev: 3, title: 'new' }), ev({ id: 'c', seq: 5 }), ev({ id: 'b', seq: 2, rev: 0, title: 'old' })]);
    expect(out.map(e => e.id)).toEqual(['c', 'b', 'a']);
    expect(out.find(e => e.id === 'a')!.title).toBe('new');
    expect(out.find(e => e.id === 'b')!.title).toBe('t');
    expect(list.map(e => e.id)).toEqual(['b', 'a']);
  });

  it('合并工具调用显示起止时间段，其余只显示时间', () => {
    const at = new Date(2026, 9, 17, 9, 5, 7).getTime();
    expect(timeText({ type: 'turn.end', at, updatedAt: at + 5000 })).toBe('09:05:07');
    expect(timeText({ type: 'tool.batch', at, updatedAt: at + 65_000 })).toBe('09:05:07–09:06:12');
  });

  it('按天分组标题：今天、昨天、月日、跨年带年份', () => {
    const now = new Date(2026, 9, 17, 12).getTime();
    expect(dayLabel(new Date(2026, 9, 17, 1).getTime(), now)).toBe('今天');
    expect(dayLabel(new Date(2026, 9, 16, 23).getTime(), now)).toBe('昨天');
    expect(dayLabel(new Date(2026, 8, 3).getTime(), now)).toBe('9月3日');
    expect(dayLabel(new Date(2025, 11, 31).getTime(), now)).toBe('2025年12月31日');
  });

  it('复制为文本与会话色相稳定', () => {
    const text = eventsToText([ev({ id: 'a', seq: 1, sessionLabel: '甲', title: '本轮结束', detail: '用时 1 分' })]);
    expect(text).toMatch(/甲 {2}本轮结束 {2}用时 1 分$/);
    expect(sessionHue('abc')).toBe(sessionHue('abc'));
    expect(sessionHue('abc')).toBeGreaterThanOrEqual(0);
    expect(sessionHue('abc')).toBeLessThan(360);
  });
});
