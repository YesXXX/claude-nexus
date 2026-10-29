import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { createGitRunner } from '../src/main/git-runner';
import { WorktreeManager } from '../src/main/worktree-manager';

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-wt-')));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('WorktreeManager', () => {
  let repo: string;
  let registryFile: string;
  let wm: WorktreeManager;
  const id = '3f2a91c0-1111-2222-3333-444444444444';

  beforeEach(() => {
    repo = makeRepo();
    registryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-wt-home-')), 'worktrees.json');
    wm = new WorktreeManager({ git: createGitRunner(), registryFile, sleep: async () => {} });
  });

  it('inspect：普通仓库、非仓库、无提交仓库', async () => {
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x');
    const info = await wm.inspect(path.join(repo, 'src'));
    expect(info.state).toBe('repo');
    expect(path.resolve(info.repoRoot!)).toBe(path.resolve(repo));
    expect(info.head).toBe('main');
    expect(info.dirtyCount).toBe(1);
    expect(info.hasSubmodules).toBe(false);

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-wt-plain-'));
    expect((await wm.inspect(plain)).state).toBe('not_repo');

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-wt-empty-'));
    sh(empty, 'init', '-q');
    expect((await wm.inspect(empty)).state).toBe('no_commit');
  });

  it('create：建在 .claude/worktrees 下、映射子目录、写排除规则、复制本地配置、登记', async () => {
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{"permissions":{}}');
    fs.writeFileSync(path.join(repo, 'src', 'uncommitted.txt'), 'not carried over');

    const { info, cwd } = await wm.create({ sessionId: id, label: 'fix', cwd: path.join(repo, 'src') });
    expect(info.path).toBe(path.join(repo, '.claude', 'worktrees', 'nexus-3f2a91c0'));
    expect(info.branch).toBe('nexus/3f2a91c0');
    expect(info.baseRef).toBe('main');
    expect(info.baseCommit).toBe(sh(repo, 'rev-parse', 'HEAD'));
    expect(cwd).toBe(path.join(info.path, 'src'));
    expect(fs.existsSync(path.join(info.path, 'src', 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(info.path, 'src', 'uncommitted.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(info.path, '.claude', 'settings.local.json'), 'utf8')).toContain('permissions');

    // 主目录 git status 看不到工作区目录
    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('/.claude/worktrees/');
    expect(sh(repo, 'status', '--porcelain')).not.toContain('worktrees');

    expect(wm.findRecord(info.path)?.sessionId).toBe(id);
    expect(wm.leftovers(new Set([id]))).toEqual([]);
    expect(wm.leftovers(new Set()).map(r => r.sessionId)).toEqual([id]);

    // 本地配置不计入未提交文件
    expect(await wm.status(info)).toEqual({ dirtyFiles: 0, unmergedCommits: 0 });
  });

  it('create：自定义分支与基线；分支已存在、分支名非法、基线不存在时报错且不留残留', async () => {
    sh(repo, 'branch', 'dev');
    const { info } = await wm.create({ sessionId: id, label: 'x', cwd: repo, branch: 'feat/x', baseRef: 'dev' });
    expect(info.branch).toBe('feat/x');
    expect(info.baseRef).toBe('dev');

    const other = 'aaaaaaaa-0000-0000-0000-000000000000';
    await expect(wm.create({ sessionId: other, label: 'y', cwd: repo, branch: 'dev' })).rejects.toThrow('分支已存在：dev');
    await expect(wm.create({ sessionId: other, label: 'y', cwd: repo, branch: 'bad..name' })).rejects.toThrow('分支名不合法');
    await expect(wm.create({ sessionId: other, label: 'y', cwd: repo, baseRef: 'nope' })).rejects.toThrow('基线不存在：nope');
    expect(fs.existsSync(path.join(repo, '.claude', 'worktrees', 'nexus-aaaaaaaa'))).toBe(false);
  });

  it('create：非仓库目录报错', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-wt-plain-'));
    await expect(wm.create({ sessionId: id, label: 'x', cwd: plain })).rejects.toThrow('不是 git 仓库');
  });

  it('status / remove：干净且无提交时连分支一起删除', async () => {
    const { info } = await wm.create({ sessionId: id, label: 'x', cwd: repo });
    const r = await wm.remove(info, false);
    expect(r).toEqual({ ok: true });
    expect(fs.existsSync(info.path)).toBe(false);
    expect(sh(repo, 'branch', '--list', info.branch)).toBe('');
    expect(wm.findRecord(info.path)).toBeUndefined();
  });

  it('status / remove：有未合并提交时删除工作区但保留分支', async () => {
    const { info } = await wm.create({ sessionId: id, label: 'x', cwd: repo });
    fs.writeFileSync(path.join(info.path, 'new.txt'), 'n\n');
    expect((await wm.status(info)).dirtyFiles).toBe(1);
    sh(info.path, 'add', '.');
    sh(info.path, 'commit', '-q', '-m', 'work');
    expect(await wm.status(info)).toEqual({ dirtyFiles: 0, unmergedCommits: 1 });

    const r = await wm.remove(info, false);
    expect(r.kept).toBe('unmerged');
    expect(fs.existsSync(info.path)).toBe(false);
    expect(sh(repo, 'branch', '--list', info.branch)).toContain(info.branch);
  });

  it('remove：有未提交改动时不强制则保留，强制则删除', async () => {
    const { info } = await wm.create({ sessionId: id, label: 'x', cwd: repo });
    fs.writeFileSync(path.join(info.path, 'src', 'a.txt'), 'changed\n');
    const kept = await wm.remove(info, false);
    expect(kept.kept).toBe('error');
    expect(fs.existsSync(info.path)).toBe(true);
    expect(wm.findRecord(info.path)).toBeDefined();

    const forced = await wm.remove(info, true);
    expect(forced).toEqual({ ok: true });
    expect(fs.existsSync(info.path)).toBe(false);
  });

  it('prune：目录被手动删掉的记录从登记表移除', async () => {
    const { info } = await wm.create({ sessionId: id, label: 'x', cwd: repo });
    fs.rmSync(info.path, { recursive: true, force: true });
    expect(await wm.prune()).toBe(1);
    expect(wm.findRecord(info.path)).toBeUndefined();
    expect(sh(repo, 'worktree', 'list')).not.toContain('nexus-');
  });

  it('restore：目录被删后按原路径与原分支重建，提交保留、本地配置复制、登记表恢复', async () => {
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{"permissions":{}}');
    const { info } = await wm.create({ sessionId: id, label: 'fix', cwd: repo });
    fs.writeFileSync(path.join(info.path, 'work.txt'), 'w\n');
    sh(info.path, 'add', 'work.txt');
    sh(info.path, 'commit', '-q', '-m', 'work');
    const head = sh(info.path, 'rev-parse', 'HEAD');
    fs.rmSync(info.path, { recursive: true, force: true });
    await wm.prune();
    expect(wm.findRecord(info.path)).toBeUndefined();

    expect(await wm.branchExists(repo, info.branch)).toBe(true);
    await wm.restore(info, { sessionId: id, label: 'fix' });
    expect(fs.existsSync(path.join(info.path, 'work.txt'))).toBe(true);
    expect(sh(info.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(info.branch);
    expect(sh(info.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(fs.readFileSync(path.join(info.path, '.claude', 'settings.local.json'), 'utf8')).toContain('permissions');
    expect(wm.findRecord(info.path)).toMatchObject({ sessionId: id, label: 'fix', branch: info.branch });
    expect(await wm.status(info)).toEqual({ dirtyFiles: 0, unmergedCommits: 1 });
  });

  it('restore：未先 prune 也能重建（git 仍登记着失效工作区）', async () => {
    const { info } = await wm.create({ sessionId: id, label: 'x', cwd: repo });
    fs.rmSync(info.path, { recursive: true, force: true });
    await wm.restore(info, { sessionId: id, label: 'x' });
    expect(fs.existsSync(path.join(info.path, 'src', 'a.txt'))).toBe(true);
  });

  it('branchExists / restore：分支已删、主仓库不在、目录仍在时都不重建', async () => {
    const { info } = await wm.create({ sessionId: id, label: 'x', cwd: repo });
    await expect(wm.restore(info, { sessionId: id, label: 'x' })).rejects.toThrow('工作区目录已存在');
    await wm.remove(info, true);
    expect(await wm.branchExists(repo, info.branch)).toBe(false);
    await expect(wm.restore(info, { sessionId: id, label: 'x' })).rejects.toThrow(`分支已不存在：${info.branch}`);
    expect(fs.existsSync(info.path)).toBe(false);
    const gone = path.join(os.tmpdir(), 'panel-wt-gone-repo');
    expect(await wm.branchExists(gone, 'main')).toBe(false);
    await expect(wm.restore({ ...info, repoRoot: gone }, { sessionId: id, label: 'x' })).rejects.toThrow('主仓库目录已不存在');
  });
});
