import { describe, it, expect } from 'vitest';
import { classifyResumeFailure, evaluateResume, stripAnsi, RESUME_MESSAGES, type ResumeCheckInput } from '../src/main/resume-check';
import type { Session } from '../src/shared/types';

const CAPS = { version: 't', resume: true, sessionId: true, forkSession: true, name: true, probedAt: 0 };
const ID = '11111111-1111-4111-8111-111111111111';

function session(extra: Partial<Session> = {}): Session {
  return {
    id: 'p1', label: '甲', cwd: 'D:\w', status: 'completed', statusSince: 1, createdAt: 1, escalated: false,
    claudeSessionId: ID, ...extra,
  };
}

function input(extra: Partial<ResumeCheckInput> = {}): ResumeCheckInput {
  return {
    session: session(), alive: false, liveOthers: [], caps: CAPS,
    exists: () => true, locate: () => ({ state: 'found', path: 'x', size: 1 }), ...extra,
  };
}

describe('evaluateResume', () => {
  it('记录存在且进程已结束：可续接、可分叉', () => {
    expect(evaluateResume(input())).toMatchObject({ resumable: true, transcript: 'found', canFresh: true, canFork: true, message: RESUME_MESSAGES.found });
  });

  it('记录根目录读不了：仍允许尝试续接，但不能分叉', () => {
    const r = evaluateResume(input({ locate: () => ({ state: 'unknown' }) }));
    expect(r).toMatchObject({ resumable: true, transcript: 'unknown', canFork: false, message: RESUME_MESSAGES.unknown });
  });

  it('CLI 不支持分叉时 canFork 为假', () => {
    expect(evaluateResume(input({ caps: { ...CAPS, forkSession: false } })).canFork).toBe(false);
  });

  it('判定顺序：只读优先于目录缺失', () => {
    const r = evaluateResume(input({ session: session({ readOnly: true }), exists: () => false }));
    expect(r.reason).toBe('readonly');
  });

  it('工作区目录缺失优先于普通目录检查', () => {
    const wt = { path: 'D:\wt', branch: 'b', baseRef: 'main', repoRoot: 'D:\r' } as unknown as Session['worktree'];
    const r = evaluateResume(input({ session: session({ worktree: wt }), exists: p => p !== 'D:\wt' }));
    expect(r).toMatchObject({ reason: 'worktree_missing', canFresh: false, canRebuildWorktree: false });
  });

  it('工作区还在但会话子目录没了：可续接，回退到工作区根目录', () => {
    const wt = { path: 'D:\\wt', branch: 'b', baseRef: 'main', repoRoot: 'D:\\r' } as unknown as Session['worktree'];
    const s = session({ worktree: wt, cwd: 'D:\\wt\\sub' });
    const r = evaluateResume(input({ session: s, exists: p => p !== 'D:\\wt\\sub' }));
    expect(r).toMatchObject({ resumable: true, cwdFallback: 'D:\\wt' });
    expect(evaluateResume(input({ session: session({ cwd: 'D:\\gone' }), exists: p => p !== 'D:\\gone' })))
      .toMatchObject({ reason: 'cwd_missing' });
    expect(evaluateResume(input({ session: s })).cwdFallback).toBeUndefined();
  });

  it('目录存在但没有 id：no_id，可全新开始', () => {
    expect(evaluateResume(input({ session: session({ claudeSessionId: undefined }) }))).toMatchObject({ reason: 'no_id', canFresh: true });
  });

  it('id 被其他存活会话占用（大小写不敏感）', () => {
    const other = session({ id: 'p2', label: '乙', claudeSessionId: ID.toUpperCase() });
    expect(evaluateResume(input({ liveOthers: [other] }))).toMatchObject({ reason: 'in_use', inUseBy: { id: 'p2', label: '乙' } });
  });

  it('记录缺失优先于进程存活', () => {
    expect(evaluateResume(input({ alive: true, locate: () => ({ state: 'missing' }) })).reason).toBe('no_transcript');
  });

  it('进程存活：busy，其他条件满足', () => {
    expect(evaluateResume(input({ alive: true }))).toMatchObject({ resumable: false, reason: 'busy', canFresh: true, canFork: true });
  });
});

describe('续接失败归类', () => {
  it('stripAnsi 去掉 CSI、OSC 与控制字符，保留换行', () => {
    expect(stripAnsi('\x1b]0;title\x07\x1b[1;31mred\x1b[0m\x07\nok')).toBe('red\nok');
  });

  it('No conversation found 归为 no_transcript，只看最后 2KB', () => {
    const raw = 'x'.repeat(5000) + '\x1b[31mNo conversation found with session ID: abc\x1b[0m\r\n';
    const f = classifyResumeFailure(raw, 1, 9);
    expect(f).toMatchObject({ reason: 'no_transcript', exitCode: 1, at: 9 });
    expect(f.detail!.length).toBeLessThanOrEqual(400);
    expect(f.detail).toContain('No conversation found with session ID: abc');
  });

  it('特征文本被挤出最后 2KB 时归为 exited_early', () => {
    const raw = 'No conversation found\n' + 'y'.repeat(3000);
    expect(classifyResumeFailure(raw, 2, 0).reason).toBe('exited_early');
  });

  it('没有输出时不带 detail', () => {
    expect(classifyResumeFailure('', null, 0)).toEqual({ reason: 'exited_early', exitCode: null, at: 0 });
  });
});
