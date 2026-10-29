import { describe, it, expect } from 'vitest';
import {
  groupSessions, orderForDisplay, shortDuration, longDuration, cwdBaseName, matchesQuery, stepSelection,
} from '../src/shared/session-view';
import { compareByAttention } from '../src/shared/status-engine';
import { Session, SessionStatus } from '../src/shared/types';

function mk(id: string, status: SessionStatus, statusSince = 0): Session {
  return { id, label: id, cwd: 'D:\\t', status, statusSince, createdAt: 0, escalated: false };
}

describe('groupSessions', () => {
  it('按 等待权限 / 等待输入 / 异常+失联 / 运行中 / 已完成 排列，只返回非空组', () => {
    const groups = groupSessions([
      mk('a', 'completed'), mk('b', 'running'), mk('c', 'disconnected'),
      mk('d', 'waiting_permission'), mk('e', 'error'),
    ]);
    expect(groups.map(g => g.key)).toEqual(['perm', 'trouble', 'running', 'done']);
    expect(groups[1].title).toBe('异常 / 失联');
    expect(groups[1].sessions.map(s => s.id)).toEqual(['c', 'e']);
  });

  it('空列表返回空数组', () => {
    expect(groupSessions([])).toEqual([]);
  });
});

describe('orderForDisplay', () => {
  it('对主进程已排序的列表保持原顺序（序号与 Ctrl+数字一致）', () => {
    const sorted = [
      mk('a', 'running', 5), mk('b', 'error', 3), mk('c', 'waiting_input', 9),
      mk('d', 'disconnected', 1), mk('e', 'completed', 2), mk('f', 'waiting_permission', 7),
    ].sort(compareByAttention);
    expect(orderForDisplay(sorted).map(s => s.id)).toEqual(sorted.map(s => s.id));
  });

  it('新建会话临时插到最前时也归入所属分组', () => {
    const list = [mk('new', 'running'), mk('p', 'waiting_permission'), mk('done', 'completed')];
    expect(orderForDisplay(list).map(s => s.id)).toEqual(['p', 'new', 'done']);
  });
});

describe('shortDuration / longDuration', () => {
  it('紧凑格式逐级进位', () => {
    expect(shortDuration(-5)).toBe('0秒');
    expect(shortDuration(45_000)).toBe('45秒');
    expect(shortDuration(6 * 60_000 + 12_000)).toBe('6分');
    expect(shortDuration(2 * 3_600_000)).toBe('2小时');
    expect(shortDuration(3 * 86_400_000)).toBe('3天');
  });

  it('完整格式带次级单位', () => {
    expect(longDuration(12_000)).toBe('12 秒');
    expect(longDuration(6 * 60_000 + 12_000)).toBe('6 分 12 秒');
    expect(longDuration(3_600_000 + 3 * 60_000)).toBe('1 小时 3 分');
    expect(longDuration(2 * 86_400_000 + 4 * 3_600_000)).toBe('2 天 4 小时');
  });
});

describe('cwdBaseName', () => {
  it('取最后一级目录名', () => {
    expect(cwdBaseName('D:\\work\\my-app')).toBe('my-app');
    expect(cwdBaseName('/home/me/repo/')).toBe('repo');
    expect(cwdBaseName('D:\\')).toBe('D:');
    expect(cwdBaseName('')).toBe('');
  });
});

describe('matchesQuery', () => {
  it('多词全部命中才算匹配，不区分大小写', () => {
    expect(matchesQuery('user 重构', '重构用户模块', 'D:\\User-Service')).toBe(true);
    expect(matchesQuery('user 报表', '重构用户模块', 'D:\\User-Service')).toBe(false);
    expect(matchesQuery('   ', 'x')).toBe(true);
    expect(matchesQuery('x', undefined)).toBe(false);
  });
});

describe('stepSelection', () => {
  const ids = ['a', 'b', 'c'];
  it('前后移动并在两端停住', () => {
    expect(stepSelection(ids, 'a', 1)).toBe('b');
    expect(stepSelection(ids, 'c', 1)).toBe('c');
    expect(stepSelection(ids, 'a', -1)).toBe('a');
  });
  it('未选中或选中项不在列表中：J 取第一项，K 取最后一项', () => {
    expect(stepSelection(ids, null, 1)).toBe('a');
    expect(stepSelection(ids, 'zz', -1)).toBe('c');
    expect(stepSelection([], null, 1)).toBeNull();
  });
});

describe('待续接分组', () => {
  it('单独成组，排在最后，标题为待续接', () => {
    const groups = groupSessions([mk('s', 'suspended'), mk('a', 'completed'), mk('b', 'running')]);
    expect(groups.map(g => g.key)).toEqual(['running', 'done', 'suspended']);
    expect(groups[2].title).toBe('待续接');
    expect(groups[2].sessions.map(s => s.id)).toEqual(['s']);
  });
});
