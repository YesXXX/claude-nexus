import { describe, it, expect } from 'vitest';
import {
  appendClaudeId, canTransitionRecord, dormantSession, newRecord, normalizeRecord, pickRestoreReason, pruneCandidates,
  queryRecords, recordFieldsFromSession, sanitizeQuery, startupDisposition,
} from '../src/shared/session-records';
import type { RecordState, Session, SessionRecord } from '../src/shared/types';

const DAY = 24 * 60 * 60 * 1000;

function rec(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1, id, label: `任务 ${id}`, cwd: 'D:\\work\\proj', createdAt: 1, updatedAt: 1, lastActiveAt: 1,
    state: 'ended', lastStatus: 'completed', claudeSessionIds: [], turns: 0, resumeCount: 0, ...over,
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1', label: '会话', cwd: 'D:\\w', status: 'running', statusSince: 5, createdAt: 5, escalated: false, ...over,
  };
}

describe('记录状态迁移', () => {
  const allowed: Array<[RecordState, RecordState]> = [
    ['live', 'exited'], ['live', 'suspended'], ['live', 'ended'],
    ['exited', 'live'], ['exited', 'ended'],
    ['suspended', 'live'], ['suspended', 'ended'],
    ['ended', 'live'],
  ];
  const denied: Array<[RecordState, RecordState]> = [
    ['exited', 'suspended'], ['suspended', 'exited'], ['ended', 'exited'], ['ended', 'suspended'],
  ];
  it.each(allowed)('%s → %s 允许', (a, b) => { expect(canTransitionRecord(a, b)).toBe(true); });
  it.each(denied)('%s → %s 不允许', (a, b) => { expect(canTransitionRecord(a, b)).toBe(false); });
  it('同状态更新总是允许', () => {
    for (const s of ['live', 'exited', 'suspended', 'ended'] as RecordState[]) expect(canTransitionRecord(s, s)).toBe(true);
  });
});

describe('记录构造与校验', () => {
  it('newRecord 按会话生成 live 记录，缺失字段不出现', () => {
    const r = newRecord(session({ claudeSessionId: 'c1', claudeSessionIds: ['c1'] }), 100);
    expect(r).toMatchObject({ version: 1, id: 's1', state: 'live', lastStatus: 'running', claudeSessionId: 'c1', turns: 0, resumeCount: 0 });
    expect(r.claudeSessionIds).toEqual(['c1']);
    expect('transcriptPath' in r).toBe(false);
    expect('exitCode' in r).toBe(false);
  });

  it('recordFieldsFromSession 对缺失字段显式给 undefined，便于合并时删除旧值', () => {
    const f = recordFieldsFromSession(session());
    expect('transcriptPath' in f).toBe(true);
    expect(f.transcriptPath).toBeUndefined();
    expect(f.claudeSessionIds).toEqual([]);
  });

  it('normalizeRecord 拒绝版本不认识、缺 id 或 cwd 的数据，补齐缺省值并保留未知字段', () => {
    expect(normalizeRecord(null)).toBeNull();
    expect(normalizeRecord({ version: 2, id: 'a', cwd: 'x' })).toBeNull();
    expect(normalizeRecord({ version: 1, cwd: 'x' })).toBeNull();
    expect(normalizeRecord({ version: 1, id: 'a' })).toBeNull();
    const r = normalizeRecord({ version: 1, id: 'a', cwd: 'x', state: 'bogus', pinned: true, claudeSessionIds: ['c', 3] })!;
    expect(r).toMatchObject({ state: 'ended', turns: 0, resumeCount: 0, label: '', claudeSessionIds: ['c'] });
    expect((r as unknown as { pinned: boolean }).pinned).toBe(true);
  });

  it('appendClaudeId 去重挪到末尾并限制 20 个', () => {
    expect(appendClaudeId(['a', 'b'], 'a')).toEqual(['b', 'a']);
    const many = Array.from({ length: 20 }, (_, i) => `x${i}`);
    const next = appendClaudeId(many, 'new');
    expect(next).toHaveLength(20);
    expect(next[19]).toBe('new');
    expect(next[0]).toBe('x1');
  });
});

describe('queryRecords', () => {
  const list: SessionRecord[] = [
    rec('a', { label: '修复导入', lastActiveAt: 30, createdAt: 3, endedAt: 100 }),
    rec('b', { label: '加功能', cwd: 'D:/Work/Proj/sub', lastActiveAt: 50, createdAt: 1, endedAt: 50, claudeSessionIds: ['ABC-123'] }),
    rec('c', { label: '其他目录', cwd: 'E:\\other', lastActiveAt: 10, createdAt: 2, endedAt: 70 }),
    rec('d', { state: 'live', label: '正在跑', lastActiveAt: 99 }),
    rec('e', {
      label: '工作区', cwd: 'D:\\wt\\nexus-e', lastActiveAt: 20, createdAt: 4, endedAt: 20,
      worktree: { repoRoot: 'D:\\work\\proj', path: 'D:\\wt\\nexus-e', branch: 'nexus/feature-x', baseRef: 'main', baseCommit: 'x' },
    }),
  ];

  it('缺省只查 ended，按最近活动倒序', () => {
    const page = queryRecords(list);
    expect(page.items.map(r => r.id)).toEqual(['b', 'a', 'e', 'c']);
    expect(page.total).toBe(4);
  });

  it('按状态筛选', () => {
    expect(queryRecords(list, { states: ['live'] }).items.map(r => r.id)).toEqual(['d']);
  });

  it('文本匹配标签、目录、Claude 会话 id 与分支，不区分大小写', () => {
    expect(queryRecords(list, { text: '导入' }).items.map(r => r.id)).toEqual(['a']);
    expect(queryRecords(list, { text: 'abc-1' }).items.map(r => r.id)).toEqual(['b']);
    expect(queryRecords(list, { text: 'FEATURE-X' }).items.map(r => r.id)).toEqual(['e']);
    expect(queryRecords(list, { text: 'e:\\oth' }).items.map(r => r.id)).toEqual(['c']);
  });

  it('目录精确匹配，大小写与斜杠不敏感', () => {
    expect(queryRecords(list, { cwd: 'd:/work/proj/' }).items.map(r => r.id)).toEqual(['a']);
  });

  it('仓库匹配工作区 repoRoot 或位于其下的目录', () => {
    expect(queryRecords(list, { repoRoot: 'D:\\Work\\Proj' }).items.map(r => r.id)).toEqual(['b', 'a', 'e']);
  });

  it('时间范围按最近活动时间', () => {
    expect(queryRecords(list, { since: 20, until: 30 }).items.map(r => r.id)).toEqual(['a', 'e']);
  });

  it('排序：创建时间、结束时间', () => {
    expect(queryRecords(list, { sort: 'created' }).items.map(r => r.id)).toEqual(['e', 'a', 'c', 'b']);
    expect(queryRecords(list, { sort: 'ended' }).items.map(r => r.id)).toEqual(['a', 'c', 'b', 'e']);
  });

  it('分页：limit 上限 200、offset，total 为分页前总数', () => {
    const page = queryRecords(list, { limit: 2, offset: 1 });
    expect(page.items.map(r => r.id)).toEqual(['a', 'e']);
    expect(page.total).toBe(4);
    const big = Array.from({ length: 250 }, (_, i) => rec(`r${i}`, { lastActiveAt: i }));
    expect(queryRecords(big, { limit: 1000 }).items).toHaveLength(200);
    expect(queryRecords(big).items).toHaveLength(50);
  });

  it('sanitizeQuery 丢掉类型不对的字段', () => {
    expect(sanitizeQuery({ states: ['ended', 'x'], text: '  hi ', limit: '3', sort: 'bad', since: 5 }))
      .toEqual({ states: ['ended'], text: 'hi', since: 5 });
    expect(sanitizeQuery(null)).toEqual({});
  });
});

describe('pruneCandidates', () => {
  const now = 1000 * DAY;
  it('只清 ended：超过天数的删除，其余按结束时间倒序超出条数的删除', () => {
    const list = [
      rec('old', { endedAt: now - 91 * DAY }),
      rec('n1', { endedAt: now - 1 }),
      rec('n2', { endedAt: now - 2 }),
      rec('n3', { endedAt: now - 3 }),
      rec('live-old', { state: 'live', endedAt: now - 200 * DAY }),
      rec('sus', { state: 'suspended', updatedAt: 0 }),
    ];
    const ids = pruneCandidates(list, { historyMaxCount: 2, historyMaxDays: 90 }, now);
    expect(ids.sort()).toEqual(['n3', 'old']);
  });

  it('置顶记录不清理，也不占条数', () => {
    const list = [
      { ...rec('pin', { endedAt: now - 365 * DAY }), pinned: true } as SessionRecord,
      rec('n1', { endedAt: now - 1 }),
    ];
    expect(pruneCandidates(list, { historyMaxCount: 1, historyMaxDays: 90 }, now)).toEqual([]);
  });

  it('没有结束时间时按更新时间算', () => {
    const list = [rec('x', { updatedAt: now - 100 * DAY })];
    expect(pruneCandidates(list, { historyMaxCount: 10, historyMaxDays: 90 }, now)).toEqual(['x']);
  });
});

describe('pickRestoreReason', () => {
  it('按 crash > update > quit 取最高', () => {
    expect(pickRestoreReason([])).toBeNull();
    expect(pickRestoreReason(['quit'])).toBe('quit');
    expect(pickRestoreReason(['quit', 'update'])).toBe('update');
    expect(pickRestoreReason(['update', 'crash', 'quit'])).toBe('crash');
  });
});

describe('startupDisposition', () => {
  const records = [
    rec('ended', { state: 'ended', createdAt: 1 }),
    rec('adopted', { state: 'live', createdAt: 2 }),
    rec('crashed', { state: 'live', createdAt: 3 }),
    rec('kept', { state: 'suspended', restoreReason: 'quit', createdAt: 4 }),
    rec('upd', { state: 'suspended', restoreReason: 'update', createdAt: 5 }),
    rec('exited', { state: 'exited', lastStatus: 'error', createdAt: 6 }),
    rec('noreason', { state: 'suspended', createdAt: 7 }),
  ];
  const adopted = new Set(['adopted']);

  it('询问档：崩溃遗留转 crash，更新前保留的直接续接，其余进横幅；exited 原样恢复', () => {
    const p = startupDisposition(records, adopted, 'ask');
    expect(p.adopted).toEqual(['adopted']);
    expect(p.crashed).toEqual(['crashed']);
    expect(p.end).toEqual([]);
    expect(p.dormant).toEqual([
      { id: 'crashed', state: 'suspended', restoreReason: 'crash' },
      { id: 'kept', state: 'suspended', restoreReason: 'quit' },
      { id: 'upd', state: 'suspended', restoreReason: 'update' },
      { id: 'exited', state: 'exited' },
      { id: 'noreason', state: 'suspended', restoreReason: 'quit' },
    ]);
    expect(p.autoResume).toEqual(['upd']);
    expect(p.prompt).toEqual({ ids: ['crashed', 'kept', 'noreason'], reason: 'crash' });
  });

  it('自动档：待续接全部自动续接，没有横幅', () => {
    const p = startupDisposition(records, adopted, 'auto');
    expect(p.autoResume).toEqual(['crashed', 'kept', 'upd', 'noreason']);
    expect(p.prompt).toBeNull();
  });

  it('不恢复档：待续接（含崩溃遗留与更新前保留）全部转入历史，exited 仍恢复', () => {
    const p = startupDisposition(records, adopted, 'never');
    expect(p.end).toEqual(['crashed', 'kept', 'upd', 'noreason']);
    expect(p.crashed).toEqual(['crashed']);
    expect(p.dormant).toEqual([{ id: 'exited', state: 'exited' }]);
    expect(p.autoResume).toEqual([]);
    expect(p.prompt).toBeNull();
  });

  it('只有退出保留时横幅原因为 quit；没有记录时方案为空', () => {
    expect(startupDisposition([rec('k', { state: 'suspended', restoreReason: 'quit' })], new Set(), 'ask').prompt)
      .toEqual({ ids: ['k'], reason: 'quit' });
    expect(startupDisposition([], new Set(), 'ask')).toEqual({
      adopted: [], dormant: [], crashed: [], end: [], autoResume: [], prompt: null,
    });
  });
});

describe('dormantSession', () => {
  it('待续接记录构造为 suspended 行，带原因、轮数与保留时间', () => {
    const s = dormantSession(rec('a', {
      state: 'suspended', restoreReason: 'quit', updatedAt: 50, createdAt: 10, turns: 6,
      claudeSessionId: 'c1', claudeSessionIds: ['c0', 'c1'], transcriptPath: 'C:\t.jsonl',
    }), { id: 'a', state: 'suspended', restoreReason: 'crash' });
    expect(s).toMatchObject({
      id: 'a', status: 'suspended', statusSince: 50, createdAt: 10, dormant: true, dormantSince: 50, turns: 6,
      restoreReason: 'crash', claudeSessionId: 'c1', claudeSessionIds: ['c0', 'c1'], claudeTranscriptPath: 'C:\t.jsonl',
    });
    expect('exitCode' in s).toBe(false);
  });

  it('exited 记录沿用退出类状态，非退出类状态按失联显示；不带恢复原因', () => {
    const done = dormantSession(rec('b', { state: 'exited', lastStatus: 'completed', exitCode: 0 }), { id: 'b', state: 'exited' });
    expect(done).toMatchObject({ status: 'completed', exitCode: 0, dormant: true });
    expect(done.restoreReason).toBeUndefined();
    const odd = dormantSession(rec('c', { state: 'exited', lastStatus: 'running' }), { id: 'c', state: 'exited' });
    expect(odd.status).toBe('disconnected');
  });

  it('续接失败原因带到会话行', () => {
    const f = { reason: 'no_transcript' as const, exitCode: 1, at: 9 };
    expect(dormantSession(rec('d', { state: 'exited', lastResumeFailure: f }), { id: 'd', state: 'exited' }).resumeFailure).toEqual(f);
  });
});

describe('recordFieldsFromSession 与待续接', () => {
  it('suspended 行不覆盖记录里退出前的状态', () => {
    expect('lastStatus' in recordFieldsFromSession(session({ status: 'suspended' }))).toBe(false);
    expect(recordFieldsFromSession(session({ status: 'error' })).lastStatus).toBe('error');
  });
});

describe('批次归属', () => {
  it('批次 id 写进记录，并随待续接行恢复', () => {
    expect(recordFieldsFromSession(session({ batchId: 'b1' })).batchId).toBe('b1');
    expect(recordFieldsFromSession(session()).batchId).toBeUndefined();
    const s = dormantSession(rec('e', { state: 'suspended', batchId: 'b1' }), { id: 'e', state: 'suspended' });
    expect(s.batchId).toBe('b1');
  });
});
