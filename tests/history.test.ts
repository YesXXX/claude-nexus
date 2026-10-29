import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { dropSessionDirs, SessionRecordStore } from '../src/main/session-record-store';
import { historyMeta } from '../src/main/ipc-history';
import {
  endKindOf, historyCwds, promptFields, queryRecords, sanitizeQuery,
} from '../src/shared/session-records';
import {
  deleteMessage, promptSummary, rangeSince, recordDurationMs, templateNameOf, worktreeLeft,
} from '../src/shared/history-view';
import type { SessionRecord } from '../src/shared/types';

function rec(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1, id, label: id, cwd: 'D:\\w', createdAt: 1, updatedAt: 1, lastActiveAt: 1, endedAt: 1,
    state: 'ended', lastStatus: 'completed', claudeSessionIds: [], turns: 0, resumeCount: 0, ...over,
  };
}

const wt = { repoRoot: 'D:/r', path: 'D:/r/.claude/worktrees/x', branch: 'nexus/fix-login', baseRef: 'main' } as SessionRecord['worktree'];

describe('历史查询', () => {
  const list = [
    rec('a', { label: '登录修复', firstPrompt: '修复 Login 页面的跳转', cwd: 'D:\\proj\\web', lastActiveAt: 30, endedAt: 30 }),
    rec('b', { label: '重构', lastPrompt: '把 utils 拆成两个文件', cwd: 'D:\\proj\\api', lastActiveAt: 20, endedAt: 20, pinned: true }),
    rec('c', { label: '分支任务', worktree: wt, cwd: 'D:\\r', lastActiveAt: 10, endedAt: 10, exitCode: 1 }),
  ];

  it('多个词按 AND 组合，覆盖标签、首条与最近提示词、目录、分支，不区分大小写', () => {
    expect(queryRecords(list, { text: 'login' }).items.map(r => r.id)).toEqual(['a', 'c']);
    expect(queryRecords(list, { text: 'LOGIN 跳转' }).items.map(r => r.id)).toEqual(['a']);
    expect(queryRecords(list, { text: 'utils 重构' }).items.map(r => r.id)).toEqual(['b']);
    expect(queryRecords(list, { text: 'proj web' }).items.map(r => r.id)).toEqual(['a']);
    expect(queryRecords(list, { text: 'login 不存在' }).total).toBe(0);
  });

  it('按结束状态过滤，固定的可排在前面', () => {
    expect(queryRecords(list, { endKinds: ['error'] }).items.map(r => r.id)).toEqual(['c']);
    expect(queryRecords(list, { endKinds: ['killed'] }).items.map(r => r.id)).toEqual(['a', 'b']);
    expect(queryRecords(list, { pinnedFirst: true }).items.map(r => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('sanitizeQuery 只认合法的结束状态与布尔开关', () => {
    expect(sanitizeQuery({ endKinds: ['error', 'bogus', 3], pinnedFirst: true })).toEqual({ endKinds: ['error'], pinnedFirst: true });
    expect(sanitizeQuery({ endKinds: ['bogus'], pinnedFirst: 'yes' })).toEqual({});
  });

  it('500 条记录内查询远小于 100ms', () => {
    const many = Array.from({ length: 500 }, (_, i) => rec(`r${i}`, {
      label: `任务 ${i}`, firstPrompt: `请处理第 ${i} 个问题，涉及 module${i % 17} 与 Login`, cwd: `D:\\proj\\p${i % 9}`,
      lastActiveAt: i, endedAt: i,
    }));
    const t0 = performance.now();
    for (let k = 0; k < 10; k++) queryRecords(many, { text: 'login module3 问题', limit: 200 });
    expect((performance.now() - t0) / 10).toBeLessThan(100);
    expect(queryRecords(many, { text: 'login module3' }).total).toBeGreaterThan(0);
  });

  it('endKindOf：退出码非零或异常为异常退出，其余按结束原因', () => {
    expect(endKindOf(rec('x'))).toBe('killed');
    expect(endKindOf(rec('x', { lastStatus: 'error' }))).toBe('error');
    expect(endKindOf(rec('x', { exitCode: 0, endReason: 'quit_end' }))).toBe('quit');
    expect(endKindOf(rec('x', { endReason: 'not_restored' }))).toBe('quit');
    expect(endKindOf(rec('x', { endReason: 'migrated' }))).toBe('migrated');
  });

  it('promptFields：首条只补一次，最近一条每次覆盖并截断', () => {
    expect(promptFields(undefined, 'p1')).toEqual({ firstPrompt: 'p1', lastPrompt: 'p1' });
    expect(promptFields(rec('x', { firstPrompt: 'p1' }), 'p2')).toEqual({ lastPrompt: 'p2' });
    expect(promptFields(undefined, 'x'.repeat(3000)).firstPrompt?.length).toBe(2000);
  });

  it('historyCwds 按最近结束去重', () => {
    const l = [rec('1', { cwd: 'D:\\a', endedAt: 1 }), rec('2', { cwd: 'd:/a/', endedAt: 5 }), rec('3', { cwd: 'D:\\b', endedAt: 3 }),
      rec('4', { cwd: 'D:\\live', state: 'live' })];
    expect(historyCwds(l)).toEqual(['d:/a/', 'D:\\b']);
  });
});

describe('历史展示', () => {
  it('rangeSince：今天从零点算，全部不限', () => {
    const now = new Date(2026, 9, 17, 15, 30).getTime();
    expect(rangeSince('today', now)).toBe(new Date(2026, 9, 17).getTime());
    expect(rangeSince('7d', now)).toBe(now - 7 * 86_400_000);
    expect(rangeSince('all', now)).toBeUndefined();
  });

  it('摘要、时长、模板名与工作区提示', () => {
    expect(promptSummary('a\n  b\tc')).toBe('a b c');
    expect(promptSummary('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(recordDurationMs(rec('x', { createdAt: 1000, endedAt: 61_000 }))).toBe(60_000);
    expect(templateNameOf(rec('x', { label: '' , firstPrompt: '写测试' }))).toBe('写测试');
    expect(worktreeLeft(rec('x', { worktree: wt }))).toBe(true);
    expect(worktreeLeft(rec('x', { worktree: wt, worktreeRemoved: true }))).toBe(false);
    expect(deleteMessage(rec('x', { worktree: wt }))).toContain('不会被删除');
    expect(deleteMessage(rec('x'))).not.toContain('工作区');
  });
});

describe('历史存储', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'panel-history-'));

  it('记录目录被同名文件占住时不可用，概况返回原因', () => {
    const root = tmp();
    const dir = path.join(root, 'records');
    fs.writeFileSync(dir, 'not a dir');
    const store = new SessionRecordStore(dir);
    store.load();
    const meta = historyMeta(store);
    expect(meta.ok).toBe(false);
    expect(meta.reason).toContain('记录目录不可用');
    expect(historyMeta(undefined).ok).toBe(false);
  });

  it('固定、清空（可保留固定的、跳过仍在列表里的）与跳过数', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
    const store = new SessionRecordStore(dir);
    store.load();
    for (const id of ['a', 'b', 'c', 'd']) store.upsert(rec(id));
    store.upsert(rec('live1', { state: 'live' }));
    expect(store.setPinned('a', true)).toBe(true);
    expect(store.setPinned('zz', true)).toBe(false);
    const meta = historyMeta(store);
    expect(meta).toMatchObject({ ok: true, skipped: 1, total: 4, pinned: 1 });
    expect(store.clear(true, id => id === 'b').sort()).toEqual(['c', 'd']);
    expect(store.setPinned('a', false)).toBe(true);
    expect(store.get('a')?.pinned).toBeUndefined();
    expect(store.clear(false).sort()).toEqual(['a', 'b']);
    expect(store.all().map(r => r.id)).toEqual(['live1']);
  });

  it('删除记录时连带清掉残留的会话目录，重启扫描不会把删掉的历史迁移回来', () => {
    const root = tmp();
    const sessions = path.join(root, 'sessions');
    for (const id of ['a', 'b']) fs.mkdirSync(path.join(sessions, id), { recursive: true });
    const store = new SessionRecordStore(path.join(root, 'records'), { onRemoved: ids => dropSessionDirs(sessions, ids) });
    store.load();
    store.upsert(rec('a'));
    store.upsert(rec('b'));
    store.remove(['a']);
    expect(fs.existsSync(path.join(sessions, 'a'))).toBe(false);
    expect(fs.existsSync(path.join(sessions, 'b'))).toBe(true);
    dropSessionDirs(sessions, ['..', '../records']);
    expect(fs.existsSync(path.join(root, 'records'))).toBe(true);
  });
});
