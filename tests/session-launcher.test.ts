import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSession, normalizeLaunch, PROMPT_INPUT_MAX, type LaunchDeps } from '../src/main/session-launcher';
import type { Session, WorktreeInfo } from '../src/shared/types';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-launch-'));

function wtInfo(id: string): WorktreeInfo {
  return { path: path.join(DIR, 'wt', id), branch: `panel/${id}`, repoRoot: DIR, baseRef: 'HEAD', baseCommit: 'abc' } as WorktreeInfo;
}

function setup(opts: { createThrows?: boolean; wtThrows?: boolean; deliverThrows?: boolean } = {}) {
  const calls: string[] = [];
  const sessions = new Map<string, Session>();
  const removed: Array<{ info: WorktreeInfo; force: boolean }> = [];
  const delivered: Array<[string, string]> = [];
  let n = 0;
  const deps: LaunchDeps = {
    uuid: () => `id-${++n}`,
    manager: {
      createSession: input => {
        calls.push(`create:${input.cwd}`);
        if (opts.createThrows) throw new Error('spawn 失败');
        const s = { id: input.id ?? `plain-${++n}`, label: input.label, cwd: input.cwd, worktree: input.worktree } as Session;
        sessions.set(s.id, s);
        return s;
      },
      getSession: id => sessions.get(id),
    },
    worktrees: {
      create: async input => {
        calls.push(`wt:${input.sessionId}:${input.branch ?? ''}:${input.baseRef ?? ''}`);
        if (opts.wtThrows) throw new Error('分支已存在');
        const info = wtInfo(input.sessionId);
        return { info, cwd: info.path };
      },
      remove: async (info, force) => { removed.push({ info, force }); return { ok: true }; },
    },
    changes: { refresh: id => { calls.push(`refresh:${id}`); } },
    prompts: {
      deliver: (id, text) => {
        if (opts.deliverThrows) throw new Error('发件箱已满');
        delivered.push([id, text]);
      },
    },
  };
  return { deps, calls, removed, delivered };
}

describe('normalizeLaunch', () => {
  it('校验标签、目录与提示词长度', () => {
    expect(() => normalizeLaunch('', DIR)).toThrow('任务标签不能为空');
    expect(() => normalizeLaunch('a', '  ')).toThrow('工作目录不能为空');
    expect(() => normalizeLaunch('a', path.join(DIR, 'nope'))).toThrow('工作目录不存在');
    expect(() => normalizeLaunch('a', DIR, { initialPrompt: 'x'.repeat(PROMPT_INPUT_MAX + 1) })).toThrow('首条提示词过长');
  });

  it('去掉首尾空白，非工作区模式忽略分支参数', () => {
    expect(normalizeLaunch(' 任务 ', ` ${DIR} `, { initialPrompt: '  ', branch: 'b' })).toEqual({ label: '任务', cwd: DIR });
    expect(normalizeLaunch('t', DIR, { worktree: true, branch: 'b', baseRef: 3, initialPrompt: ' hi ' }))
      .toEqual({ label: 't', cwd: DIR, worktree: true, branch: 'b', initialPrompt: 'hi' });
  });
});

describe('launchSession', () => {
  it('普通会话：创建后刷新改动并排队首条提示词', async () => {
    const t = setup();
    const s = await launchSession(t.deps, { label: 'a', cwd: DIR, initialPrompt: '第一行\n第二行' });
    expect(t.calls).toEqual([`create:${DIR}`, `refresh:${s.id}`]);
    expect(t.delivered).toEqual([[s.id, '第一行\n第二行']]);
  });

  it('工作区会话：先建工作区，用预分配的 id 在工作区目录拉起', async () => {
    const t = setup();
    const s = await launchSession(t.deps, { label: 'a', cwd: DIR, worktree: true, branch: 'feat/x', baseRef: 'main' });
    expect(s.id).toBe('id-1');
    expect(s.cwd).toBe(wtInfo('id-1').path);
    expect(s.worktree?.branch).toBe('panel/id-1');
    expect(t.calls).toEqual(['wt:id-1:feat/x:main', `create:${wtInfo('id-1').path}`, 'refresh:id-1']);
    expect(t.delivered).toEqual([]);
  });

  it('会话起不来时强制删除刚建的工作区并抛出原错误', async () => {
    const t = setup({ createThrows: true });
    await expect(launchSession(t.deps, { label: 'a', cwd: DIR, worktree: true, initialPrompt: 'x' })).rejects.toThrow('spawn 失败');
    expect(t.removed).toHaveLength(1);
    expect(t.removed[0].force).toBe(true);
    expect(t.removed[0].info.path).toBe(wtInfo('id-1').path);
    expect(t.delivered).toEqual([]);
  });

  it('建工作区失败时不创建会话', async () => {
    const t = setup({ wtThrows: true });
    await expect(launchSession(t.deps, { label: 'a', cwd: DIR, worktree: true })).rejects.toThrow('分支已存在');
    expect(t.calls).toEqual(['wt:id-1::']);
    expect(t.removed).toEqual([]);
  });

  it('没有工作区管理器时报错', async () => {
    const t = setup();
    delete t.deps.worktrees;
    await expect(launchSession(t.deps, { label: 'a', cwd: DIR, worktree: true })).rejects.toThrow('独立工作区不可用');
  });

  it('首条提示词排队失败不影响会话创建', async () => {
    const t = setup({ deliverThrows: true });
    const s = await launchSession(t.deps, { label: 'a', cwd: DIR, initialPrompt: 'x' });
    expect(s.label).toBe('a');
  });
});
