import { describe, it, expect } from 'vitest';
import { summarize, filterGroup, countActiveSessions } from '../src/shared/filters';
import { Session, SessionStatus } from '../src/shared/types';

function mk(status: SessionStatus, readOnly = false): Session {
  return { id: Math.random().toString(36).slice(2), label: 'x', cwd: 'D:\\t',
    status, statusSince: 0, createdAt: 0, escalated: false, readOnly };
}

describe('filterGroup', () => {
  it('running → running；completed → done；其余全部 → attention', () => {
    expect(filterGroup('running')).toBe('running');
    expect(filterGroup('completed')).toBe('done');
    for (const s of ['waiting_permission', 'waiting_input', 'error', 'disconnected'] as SessionStatus[]) {
      expect(filterGroup(s)).toBe('attention');
    }
  });
});

describe('summarize', () => {
  it('四组计数，all 恒等于总数', () => {
    const sessions = [mk('running'), mk('waiting_permission'), mk('error'), mk('completed'), mk('completed')];
    expect(summarize(sessions)).toEqual({ all: 5, attention: 2, running: 1, done: 2 });
  });
  it('空列表全零', () => {
    expect(summarize([])).toEqual({ all: 0, attention: 0, running: 0, done: 0 });
  });
});

describe('countActiveSessions（退出保护）', () => {
  it('running 与 waiting_* 计入；completed/error/disconnected/只读排除', () => {
    const sessions = [
      mk('running'), mk('waiting_permission'), mk('waiting_input'),
      mk('completed'), mk('error'), mk('disconnected'), mk('running', true),
    ];
    expect(countActiveSessions(sessions)).toBe(3);
  });
});

describe('待续接', () => {
  it('筛选归入已完成，不计入待处理与活跃数', () => {
    expect(filterGroup('suspended')).toBe('done');
    const list = [mk('suspended'), mk('suspended'), mk('running')];
    expect(summarize(list)).toEqual({ all: 3, attention: 0, running: 1, done: 2 });
    expect(countActiveSessions(list)).toBe(1);
  });
});
