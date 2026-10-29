import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { SessionManager } from '../src/main/session-manager';
import { SessionRecordStore } from '../src/main/session-record-store';
import { createGitRunner } from '../src/main/git-runner';
import { WorktreeManager } from '../src/main/worktree-manager';
import { projectDirName } from '../src/main/claude-paths';
import { checkResumeFull, restartWithWorktree, type WorktreeResumeDeps } from '../src/main/worktree-resume';
import type { PtyFactory, PtyProcess, WorktreeInfo } from '../src/shared/types';

class MockPty implements PtyProcess {
  private exitCbs: Array<(c: number | null) => void> = [];
  static nextPid = 9000;
  readonly pid: number = MockPty.nextPid++;
  constructor(public file: string, public args: string[], public options: { cwd: string }) {}
  write(): void { /* 不需要 */ }
  kill(): void { /* 退出由用例手动触发 */ }
  onData(): void { /* 不需要 */ }
  onExit(cb: (c: number | null) => void): void { this.exitCbs.push(cb); }
  emitExit(code: number | null): void { this.exitCbs.forEach(cb => cb(code)); }
}

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-wtres-'));
process.env.CLAUDE_PANEL_HOME = TEST_HOME;
const CAPS = { version: 't', resume: true, sessionId: true, forkSession: true, name: true, probedAt: 0 };

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-wtres-repo-')));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

let seq = 0;
const uuid = (): string => `cccccccc-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

interface Harness {
  m: SessionManager; wm: WorktreeManager; store: SessionRecordStore; ptys: MockPty[]; projects: string;
  deps: WorktreeResumeDeps; repo: string;
}

function harness(): Harness {
  const ptys: MockPty[] = [];
  const factory: PtyFactory = { spawn: (file, args, options) => { const p = new MockPty(file, args, options); ptys.push(p); return p; } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-wtres-home-'));
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects);
  const store = new SessionRecordStore(path.join(root, 'records'));
  store.load();
  const wm = new WorktreeManager({ git: createGitRunner(), registryFile: path.join(root, 'worktrees.json'), sleep: async () => {} });
  const m = new SessionManager({
    ptyFactory: factory, hookClientPath: 'x', mockClaudePath: 'y', caps: () => CAPS, newUuid: uuid,
    projectsRoot: () => projects, records: store,
  });
  const deps: WorktreeResumeDeps = { host: m, worktrees: wm, patchRecord: (id, p) => { store.patch(id, p); } };
  return { m, wm, store, ptys, projects, deps, repo: makeRepo() };
}

/** 以工作区模式新建会话并跑完一轮：写一份对话记录，进程正常退出 */
async function worktreeSession(h: Harness): Promise<{ id: string; info: WorktreeInfo; claudeId: string }> {
  const id = uuid();
  const { info, cwd } = await h.wm.create({ sessionId: id, label: '修复', cwd: h.repo });
  const s = h.m.createSession({ id, label: '修复', cwd, worktree: info });
  const claudeId = s.claudeSessionId!;
  const dir = path.join(h.projects, projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${claudeId}.jsonl`), '{"type":"user"}\n');
  h.ptys[h.ptys.length - 1].emitExit(0);
  return { id, info, claudeId };
}

describe('工作区会话续接', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('工作区目录被删、分支还在：可重建；不带重建标记时不拉起', async () => {
    const { id, info } = await worktreeSession(h);
    fs.rmSync(info.path, { recursive: true, force: true });
    const check = await checkResumeFull(h.deps, id);
    expect(check).toMatchObject({ resumable: false, reason: 'worktree_missing', canRebuildWorktree: true });
    expect(check.message).toContain(info.branch);
    const r = await restartWithWorktree(h.deps, id, { mode: 'resume' });
    expect(r).toMatchObject({ ok: false, reason: 'worktree_missing' });
    expect(h.ptys).toHaveLength(1);
  });

  it('rebuildWorktree：先按原路径与分支重建，再以 --resume 在工作区里拉起，清掉已删除标记', async () => {
    const { id, info, claudeId } = await worktreeSession(h);
    fs.rmSync(info.path, { recursive: true, force: true });
    h.store.patch(id, { worktreeRemoved: true });
    const r = await restartWithWorktree(h.deps, id, { mode: 'resume', rebuildWorktree: true });
    expect(r).toMatchObject({ ok: true, mode: 'resume', message: '已重建工作区' });
    expect(fs.existsSync(path.join(info.path, 'a.txt'))).toBe(true);
    expect(sh(info.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(info.branch);
    expect(h.ptys).toHaveLength(2);
    expect(h.ptys[1].args.join(' ')).toContain(`--resume ${claudeId}`);
    expect(path.resolve(h.ptys[1].options.cwd)).toBe(path.resolve(info.path));
    expect(h.m.getSession(id)).toMatchObject({ status: 'running', claudeSessionId: claudeId, worktree: info });
    expect(h.store.get(id)!.worktreeRemoved).toBeUndefined();
    expect(h.wm.findRecord(info.path)?.sessionId).toBe(id);
  });

  it('分支也删了：不可重建，重建请求不拉起进程', async () => {
    const { id, info } = await worktreeSession(h);
    await h.wm.remove(info, true);
    const check = await checkResumeFull(h.deps, id);
    expect(check).toMatchObject({ reason: 'worktree_missing', canRebuildWorktree: false, canFresh: false });
    expect(check.message).toContain('也已删除');
    const r = await restartWithWorktree(h.deps, id, { mode: 'resume', rebuildWorktree: true });
    expect(r).toMatchObject({ ok: false, reason: 'worktree_missing' });
    expect(h.ptys).toHaveLength(1);
    expect(fs.existsSync(info.path)).toBe(false);
  });

  it('主仓库目录不在：不可重建并说明', async () => {
    const id = uuid();
    const gone = path.join(TEST_HOME, 'gone-repo');
    const info: WorktreeInfo = { repoRoot: gone, path: path.join(gone, '.claude', 'worktrees', 'x'), branch: 'nexus/x', baseRef: 'main', baseCommit: 'abc' };
    fs.mkdirSync(path.join(TEST_HOME, 'cwd-for-create'), { recursive: true });
    h.m.createSession({ id, label: 'x', cwd: path.join(TEST_HOME, 'cwd-for-create'), worktree: info });
    h.ptys[0].emitExit(0);
    const check = await checkResumeFull(h.deps, id);
    expect(check).toMatchObject({ reason: 'worktree_missing', canRebuildWorktree: false });
    expect(check.message).toContain('主仓库');
  });

  it('重建失败：不拉起进程并返回原因', async () => {
    const { id, info } = await worktreeSession(h);
    fs.rmSync(info.path, { recursive: true, force: true });
    const deps: WorktreeResumeDeps = {
      host: h.m,
      worktrees: { branchExists: async () => true, restore: async () => { throw new Error('重建工作区失败：磁盘已满'); } },
    };
    const r = await restartWithWorktree(deps, id, { mode: 'resume', rebuildWorktree: true });
    expect(r).toMatchObject({ ok: false, reason: 'worktree_missing', message: '重建工作区失败：磁盘已满' });
    expect(h.ptys).toHaveLength(1);
  });

  it('工作区在、子目录没了：回退到工作区根目录续接并提示', async () => {
    const id = uuid();
    const { info } = await h.wm.create({ sessionId: id, label: 'sub', cwd: h.repo });
    const sub = path.join(info.path, 'build-out');
    fs.mkdirSync(sub);
    const s = h.m.createSession({ id, label: 'sub', cwd: sub, worktree: info });
    const dir = path.join(h.projects, projectDirName(sub));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${s.claudeSessionId}.jsonl`), '{"type":"user"}\n');
    h.ptys[0].emitExit(0);
    fs.rmSync(sub, { recursive: true, force: true });
    expect((await checkResumeFull(h.deps, id))).toMatchObject({ resumable: true, cwdFallback: info.path });
    const r = await restartWithWorktree(h.deps, id, { mode: 'resume' });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('工作区根目录');
    expect(h.ptys[1].options.cwd).toBe(info.path);
    expect(h.m.getSession(id)!.cwd).toBe(info.path);
  });

  it('会话不存在时检查返回不可续接', async () => {
    expect(await checkResumeFull(h.deps, 'nope')).toMatchObject({ resumable: false, message: '会话不存在' });
  });
});
