import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { createGitRunner } from '../src/main/git-runner';
import { WorktreeManager } from '../src/main/worktree-manager';
import { endSession, launchSession, type LaunchInput } from '../src/main/session-launcher';
import { BATCH_RETAIN_MS, BatchManager, type BatchManagerDeps, sessionAlive } from '../src/main/batch-manager';
import { normalizeBatch, topChangedFiles, type BatchRecord } from '../src/shared/batch-types';
import type { ChangeList, ChangedFile, KillResult, Session } from '../src/shared/types';

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function tmpDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeRepo(): string {
  const dir = tmpDir('panel-batch-');
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const changeList = (files: ChangedFile[] = []): ChangeList => ({
  summary: { mode: 'base', files: files.length, additions: 0, deletions: 0, updatedAt: 1 },
  files, truncated: false, sharedWith: 0,
});

interface Harness {
  repo: string;
  file: string;
  wm: WorktreeManager;
  sessions: Map<string, Session>;
  launched: LaunchInput[];
  delivered: Array<{ id: string; prompt: string }>;
  changed: string[];
  bm: BatchManager;
  /** 第几次创建会话时抛错（从 1 计） */
  failAt: Set<number>;
  clock: { t: number };
}

function harness(over: Partial<BatchManagerDeps> = {}, repo = makeRepo(), file?: string): Harness {
  const home = tmpDir('panel-batch-home-');
  const wm = new WorktreeManager({ git: createGitRunner(), registryFile: path.join(home, 'worktrees.json'), sleep: async () => {} });
  const sessions = new Map<string, Session>();
  const launched: LaunchInput[] = [];
  const delivered: Array<{ id: string; prompt: string }> = [];
  const changed: string[] = [];
  const failAt = new Set<number>();
  const clock = { t: 1000 };
  let calls = 0;
  const manager = {
    createSession(input: { id?: string; label: string; cwd: string; worktree?: Session['worktree']; batchId?: string }): Session {
      calls++;
      if (failAt.has(calls)) throw new Error(`启动失败 ${calls}`);
      const s: Session = {
        id: input.id ?? `plain-${calls}`, label: input.label, cwd: input.cwd, status: 'running', statusSince: clock.t,
        createdAt: clock.t, escalated: false,
        ...(input.worktree ? { worktree: input.worktree } : {}), ...(input.batchId ? { batchId: input.batchId } : {}),
      };
      sessions.set(s.id, s);
      return s;
    },
    getSession: (id: string) => sessions.get(id),
    killSession: (id: string) => { sessions.delete(id); },
    killSessionAndWait: async (id: string) => { sessions.delete(id); },
  };
  const prompts = { deliver: (id: string, prompt: string) => { delivered.push({ id, prompt }); } };
  const deps: BatchManagerDeps = {
    file: file ?? path.join(home, 'batches.json'),
    launch: input => { launched.push(input); return launchSession({ manager, worktrees: wm, prompts }, input); },
    end: (id, opts) => endSession({ manager, worktrees: wm }, id, opts),
    getSession: id => sessions.get(id),
    inspect: cwd => wm.inspect(cwd),
    resolveCommit: async (cwd, ref) => {
      try { return sh(cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`) || undefined; } catch { return undefined; }
    },
    getChanges: async () => changeList(),
    worktreeStatus: info => wm.status(info),
    onChange: id => changed.push(id),
    now: () => clock.t,
    ...over,
  };
  const bm = new BatchManager(deps);
  bm.load();
  return { repo, file: deps.file, wm, sessions, launched, delivered, changed, bm, failAt, clock };
}

const worktreeDirs = (repo: string): string[] => {
  const d = path.join(repo, '.claude', 'worktrees');
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};

describe('BatchManager 派发', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('N=3 全部成功：顺序创建、标签带序号、同一基线、首条提示词逐个投递、批次登记', async () => {
    const progress: number[] = [];
    const r = await h.bm.create({ label: '重构', cwd: h.repo, prompt: '  做点事\n第二行 ', count: 3 }, p => progress.push(p.done));
    expect(r.errors).toEqual([]);
    expect(r.sessions.map(s => s.label)).toEqual(['重构 #1', '重构 #2', '重构 #3']);
    expect(progress).toEqual([0, 1, 2, 3]);
    expect(h.launched.every(l => l.worktree && l.baseRef === 'main' && l.batchId === r.batch!.id)).toBe(true);
    expect(h.delivered.map(d => d.prompt)).toEqual(['做点事\n第二行', '做点事\n第二行', '做点事\n第二行']);
    expect(worktreeDirs(h.repo)).toHaveLength(3);
    const b = r.batch!;
    expect(b).toMatchObject({ label: '重构', status: 'active', baseRef: 'main', baseCommit: sh(h.repo, 'rev-parse', 'HEAD') });
    expect(Object.values(b.indexes)).toEqual([1, 2, 3]);
    expect(r.sessions.every(s => s.batchId === b.id && h.bm.batchOf(s.id) === b.id)).toBe(true);
    expect(h.bm.list().map(x => x.id)).toEqual([b.id]);
  });

  it('第 2 个失败：其余继续，错误按序号汇报，失败的工作区回滚', async () => {
    h.failAt.add(2);
    const r = await h.bm.create({ label: 'x', cwd: h.repo, prompt: 'p', count: 3 });
    expect(r.errors).toEqual([{ index: 2, message: '启动失败 2' }]);
    expect(r.sessions.map(s => s.label)).toEqual(['x #1', 'x #3']);
    expect(Object.values(r.batch!.indexes)).toEqual([1, 3]);
    expect(worktreeDirs(h.repo)).toHaveLength(2);
  });

  it('全部失败：不留工作区、分支与批次记录', async () => {
    for (const i of [1, 2]) h.failAt.add(i);
    const r = await h.bm.create({ label: 'x', cwd: h.repo, prompt: 'p', count: 2 });
    expect(r.batch).toBeUndefined();
    expect(r.errors).toHaveLength(2);
    expect(worktreeDirs(h.repo)).toEqual([]);
    expect(sh(h.repo, 'branch', '--list', 'nexus/*')).toBe('');
    expect(h.bm.list()).toEqual([]);
    expect(fs.existsSync(h.file)).toBe(false);
  });

  it('参数校验：缺提示词、方案数越界、非仓库、基线不存在', async () => {
    await expect(h.bm.create({ label: 'x', cwd: h.repo, prompt: '  ', count: 2 })).rejects.toThrow('首条提示词');
    await expect(h.bm.create({ label: 'x', cwd: h.repo, prompt: 'p', count: 1 })).rejects.toThrow('方案数');
    await expect(h.bm.create({ label: 'x', cwd: h.repo, prompt: 'p', count: 7 })).rejects.toThrow('方案数');
    await expect(h.bm.create({ label: '', cwd: h.repo, prompt: 'p', count: 2 })).rejects.toThrow('标签');
    await expect(h.bm.create({ label: 'x', cwd: tmpDir('panel-batch-plain-'), prompt: 'p', count: 2 })).rejects.toThrow('git 仓库');
    await expect(h.bm.create({ label: 'x', cwd: h.repo, prompt: 'p', count: 2, baseRef: 'nope' })).rejects.toThrow('基线不存在');
    expect(h.launched).toEqual([]);
  });
});

describe('BatchManager 保留与放弃', () => {
  it('保留其一：只结束并清理其他方案，保留的会话与工作区不动；确认信息列出未提交与未合并', async () => {
    const h = harness();
    const r = await h.bm.create({ label: 'k', cwd: h.repo, prompt: 'p', count: 3 });
    const [s1, s2, s3] = r.sessions;
    fs.writeFileSync(path.join(s3.worktree!.path, 'dirty.txt'), 'x');
    sh(s2.worktree!.path, 'commit', '-q', '--allow-empty', '-m', 'w');

    const pv = await h.bm.preview(r.batch!.id, s1.id);
    expect(pv.map(p => p.index)).toEqual([2, 3]);
    expect(pv[0].status).toMatchObject({ dirtyFiles: 0, unmergedCommits: 1 });
    expect(pv[1].status).toMatchObject({ dirtyFiles: 1, unmergedCommits: 0 });
    expect(pv.every(p => p.alive)).toBe(true);

    const res = await h.bm.keep(r.batch!.id, s1.id);
    expect(res.map(x => x.index)).toEqual([2, 3]);
    expect(res.every(x => x.result.ok)).toBe(true);
    expect(h.sessions.has(s1.id)).toBe(true);
    expect(h.sessions.has(s2.id) || h.sessions.has(s3.id)).toBe(false);
    expect(fs.existsSync(s1.worktree!.path)).toBe(true);
    expect(fs.existsSync(s2.worktree!.path) || fs.existsSync(s3.worktree!.path)).toBe(false);
    expect(h.bm.get(r.batch!.id)).toMatchObject({ status: 'resolved', keptSessionId: s1.id, endedAt: 1000 });
    await expect(h.bm.keep(r.batch!.id, s1.id)).rejects.toThrow('已保留过');
    await expect(h.bm.keep(r.batch!.id, 'other')).rejects.toThrow('不属于');
  });

  it('被占用的工作区保留并汇报；已不在列表的会话不再结束', async () => {
    const busy: KillResult = { ok: false, kept: 'busy', message: '工作区目录被占用，已保留，可稍后在命令面板中清理' };
    const ended: string[] = [];
    const h = harness({ end: async id => { ended.push(id); return busy; } });
    const r = await h.bm.create({ label: 'b', cwd: h.repo, prompt: 'p', count: 3 });
    h.sessions.delete(r.sessions[2].id);
    const res = await h.bm.discardAll(r.batch!.id);
    expect(ended).toEqual([r.sessions[0].id, r.sessions[1].id]);
    expect(res.map(x => x.result)).toEqual([busy, busy, { ok: true, message: '会话已不在列表中' }]);
    expect(h.bm.get(r.batch!.id)?.status).toBe('ended');
  });

  it('删除记录只限已结束或已保留的批次', async () => {
    const h = harness();
    const r = await h.bm.create({ label: 'f', cwd: h.repo, prompt: 'p', count: 2 });
    expect(h.bm.forget(r.batch!.id)).toBe(false);
    await h.bm.discardAll(r.batch!.id);
    expect(worktreeDirs(h.repo)).toEqual([]);
    expect(h.bm.forget(r.batch!.id)).toBe(true);
    expect(h.bm.list()).toEqual([]);
  });
});

describe('BatchManager 统计、对比与持久化', () => {
  it('一轮结束累计轮数；对比数据含用时、改动前几个文件与验证结果', async () => {
    const files: ChangedFile[] = [
      { path: 'b.ts', kind: 'modified', additions: 1, deletions: 1, binary: false },
      { path: 'a.ts', kind: 'added', additions: 30, deletions: 0, binary: false },
    ];
    const h = harness({ getChanges: async () => changeList(files) });
    const r = await h.bm.create({ label: 'v', cwd: h.repo, prompt: 'p', count: 2 });
    const [s1, s2] = r.sessions;
    h.changed.length = 0;
    h.clock.t = 61_000;
    h.bm.onEvent(s1.id, { type: 'turn_completed' } as never);
    h.bm.onEvent(s1.id, { type: 'tool_finished' } as never);
    h.bm.onEvent('stranger', { type: 'turn_completed' } as never);
    expect(h.changed).toEqual([r.batch!.id]);
    h.sessions.get(s1.id)!.status = 'completed';
    s2.verify = { state: 'passed' } as never;
    h.clock.t = 90_000;

    const v = (await h.bm.view(r.batch!.id))!;
    expect(v.items.map(i => i.turnsCompleted)).toEqual([1, 0]);
    expect(v.items[0].durationMs).toBe(60_000);   // 空闲的方案停在最近一轮结束
    expect(v.items[1].durationMs).toBe(89_000);   // 运行中的方案计到现在
    expect(v.items[0].topFiles.map(f => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(v.items[1].verify).toEqual({ state: 'passed' });
    expect(await h.bm.view('nope')).toBeNull();
  });

  it('重启后从批次文件恢复归属与轮数；会话全部消失的进行中批次转为已结束', async () => {
    const h = harness();
    const r = await h.bm.create({ label: 'r', cwd: h.repo, prompt: 'p', count: 2 });
    h.bm.onEvent(r.sessions[1].id, { type: 'turn_completed' } as never);

    const h2 = harness({}, h.repo, h.file);
    for (const s of r.sessions) h2.sessions.set(s.id, { ...s, status: 'suspended', dormant: true });
    const b = h2.bm.get(r.batch!.id)!;
    expect(b.status).toBe('active');
    expect(b.stats[r.sessions[1].id].turns).toBe(1);
    expect(h2.bm.batchOf(r.sessions[0].id)).toBe(r.batch!.id);
    expect(sessionAlive(h2.sessions.get(r.sessions[0].id))).toBe(false);

    for (const s of r.sessions) h2.sessions.delete(s.id);
    h2.bm.onDetach(r.sessions[0].id);
    expect(h2.bm.get(r.batch!.id)?.status).toBe('ended');
    expect(h2.changed).toContain(r.batch!.id);
  });

  it('启动时清理 30 天前结束的批次，进行中的不清理；损坏条目丢弃', () => {
    const dir = tmpDir('panel-batch-file-');
    const file = path.join(dir, 'batches.json');
    const base = { label: 'x', prompt: 'p', cwd: 'D:\r', sessionIds: ['s'], createdAt: 1 };
    const now = BATCH_RETAIN_MS + 10_000;
    fs.writeFileSync(file, JSON.stringify([
      { ...base, id: 'old', status: 'ended', endedAt: 5_000 },
      { ...base, id: 'recent', status: 'resolved', endedAt: now - 1000 },
      { ...base, id: 'act', status: 'active' },
      { id: 'bad' },
    ]));
    const h = harness({ now: () => now, getSession: () => ({ id: 's' } as Session) }, tmpDir('panel-batch-norepo-'), file);
    expect(h.bm.list().map(b => b.id).sort()).toEqual(['act', 'recent']);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as BatchRecord[];
    expect(saved.map(b => b.id).sort()).toEqual(['act', 'recent']);
  });
});

describe('批次数据工具', () => {
  it('normalizeBatch 补齐序号与统计，拒绝缺字段的条目', () => {
    const b = normalizeBatch({ id: 'b', label: 'l', cwd: 'c', sessionIds: ['x', 'y', 3], stats: { x: { turns: 2 } } })!;
    expect(b.indexes).toEqual({ x: 1, y: 2 });
    expect(b.stats).toEqual({ x: { turns: 2 }, y: { turns: 0 } });
    expect(b.status).toBe('active');
    expect(normalizeBatch({ id: 'b', label: 'l' })).toBeNull();
    expect(normalizeBatch(null)).toBeNull();
  });

  it('topChangedFiles 按增删行数倒序，同数按路径', () => {
    const f = (p: string, a: number | null, d: number | null): ChangedFile =>
      ({ path: p, kind: 'modified', additions: a, deletions: d, binary: a === null });
    expect(topChangedFiles([f('c', 1, 1), f('a', 5, 0), f('b', 1, 1), f('bin', null, null)], 3).map(x => x.path))
      .toEqual(['a', 'b', 'c']);
  });
});
