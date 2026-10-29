import { describe, it, expect } from 'vitest';
import {
  batchFirstTurnText, batchStatusText, clampBatchCount, cleanupSummary, createSummary, dirtyPreviews, discardLine,
} from '../src/shared/batch-view';
import type { BatchDiscardPreview, BatchItemView, BatchRecord } from '../src/shared/batch-types';
import type { Session } from '../src/shared/types';

function rec(over: Partial<BatchRecord> = {}): BatchRecord {
  return {
    id: 'b1', label: '任务', prompt: 'p', cwd: 'D:/r', repoRoot: 'D:/r', baseRef: 'main', baseCommit: 'abc',
    sessionIds: ['s1', 's2'], indexes: { s1: 1, s2: 2 }, stats: {}, createdAt: 1, status: 'active', ...over,
  };
}

const wt = { repoRoot: 'D:/r', path: 'D:/r/.claude/worktrees/x', branch: 'nexus/x', baseRef: 'main' } as BatchDiscardPreview['worktree'];

describe('batch-view', () => {
  it('clampBatchCount 夹到 1～6，非数字按 1', () => {
    expect(clampBatchCount('3')).toBe(3);
    expect(clampBatchCount('0')).toBe(1);
    expect(clampBatchCount(9)).toBe(6);
    expect(clampBatchCount('abc')).toBe(1);
    expect(clampBatchCount('')).toBe(1);
    expect(clampBatchCount(2.7)).toBe(2);
  });

  it('batchStatusText 区分进行中、已保留与已结束', () => {
    expect(batchStatusText(rec())).toBe('进行中');
    expect(batchStatusText(rec({ status: 'resolved', keptSessionId: 's2' }))).toBe('已保留 #2');
    expect(batchStatusText(rec({ status: 'resolved' }))).toBe('已保留');
    expect(batchStatusText(rec({ status: 'ended' }))).toBe('已结束');
  });

  it('batchFirstTurnText 统计已完成首轮的方案', () => {
    const items = [{ turnsCompleted: 1 }, { turnsCompleted: 0 }, { turnsCompleted: 2 }] as BatchItemView[];
    expect(batchFirstTurnText(items)).toBe('2/3 已完成首轮');
  });

  it('discardLine 与 dirtyPreviews', () => {
    const base = { sessionId: 's', label: 'x', alive: true };
    const clean: BatchDiscardPreview = { ...base, index: 1, worktree: wt, status: { dirtyFiles: 0, unmergedCommits: 0 } };
    const dirty: BatchDiscardPreview = { ...base, index: 2, worktree: wt, status: { dirtyFiles: 3, unmergedCommits: 1 } };
    const noWt: BatchDiscardPreview = { ...base, index: 3 };
    const unknown: BatchDiscardPreview = { ...base, index: 4, worktree: wt };
    expect(discardLine(clean)).toBe('#1：没有未保存的改动');
    expect(discardLine(dirty)).toBe('#2：3 个未提交文件，1 个未合并提交');
    expect(discardLine(noWt)).toBe('#3：没有独立工作区，只结束会话');
    expect(discardLine(unknown)).toBe('#4：工作区状态读取失败，仍会删除');
    expect(dirtyPreviews([clean, dirty, noWt, unknown]).map(p => p.index)).toEqual([2]);
  });

  it('cleanupSummary 说明被占用与失败的工作区', () => {
    const ok = { sessionId: 'a', index: 1, result: { ok: true } };
    const busy = { sessionId: 'b', index: 3, result: { ok: true, kept: 'busy' as const } };
    const bad = { sessionId: 'c', index: 4, result: { ok: false, kept: 'error' as const } };
    expect(cleanupSummary([ok], 2)).toEqual({ text: '已保留 #2，清理 1 个方案', warn: false });
    const r = cleanupSummary([ok, busy, bad], 2);
    expect(r.warn).toBe(true);
    expect(r.text).toContain('1 个工作区被占用，已保留，可稍后在命令面板中清理');
    expect(r.text).toContain('1 个清理失败');
    expect(cleanupSummary([ok, ok]).text).toBe('已放弃全部 2 个方案');
  });

  it('createSummary 区分全部成功、部分失败与全部失败', () => {
    const s = { id: 'x' } as Session;
    expect(createSummary({ batch: rec(), sessions: [s, s, s], errors: [] }, 3)).toEqual({ text: '已派发 3 个方案', level: 'success' });
    const part = createSummary({ batch: rec(), sessions: [s, s], errors: [{ index: 3, message: '分支已存在' }] }, 3);
    expect(part.level).toBe('warning');
    expect(part.text).toBe('已派发 2/3 个方案，失败 #3：分支已存在');
    const all = createSummary({ sessions: [], errors: [{ index: 1, message: 'x' }, { index: 2, message: 'y' }] }, 2);
    expect(all).toEqual({ text: '批量派发失败：#1：x；#2：y', level: 'error' });
  });
});
