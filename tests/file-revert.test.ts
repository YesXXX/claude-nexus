import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { createGitRunner } from '../src/main/git-runner';
import { ChangeTracker } from '../src/main/change-tracker';
import { WriteGuard } from '../src/main/write-guard';
import { CommandLog } from '../src/main/command-log';
import { FileRevert } from '../src/main/file-revert';
import type { Session, WorktreeInfo } from '../src/shared/types';

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function tmpDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(root: string, rel: string, content: string | Buffer): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function read(root: string, rel: string): Buffer {
  return fs.readFileSync(path.join(root, ...rel.split('/')));
}

function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, ...rel.split('/')));
}

const BIN = Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 13, 10]);

interface SetupOptions {
  worktree?: boolean;
  readOnly?: boolean;
  maxBackupBytes?: number;
}

function setup(opts: SetupOptions = {}) {
  const repo = tmpDir('panel-rv-repo-');
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 't');
  sh(repo, 'config', 'core.autocrlf', 'false');
  write(repo, 'a.txt', 'l1\nl2\nl3\n');
  write(repo, 'crlf.txt', 'x\r\ny\r\n');
  write(repo, 'bin.dat', BIN);
  write(repo, '目录/中文 文件.txt', '中文\n');
  write(repo, 'old.txt', 'rename me\nline2\nline3\n');
  write(repo, 'gone.txt', 'will be deleted\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  const base = sh(repo, 'rev-parse', 'HEAD');
  const home = tmpDir('panel-rv-home-');
  let busy = false;
  let clock = 1_700_000_000_000;
  const worktree: WorktreeInfo | undefined = opts.worktree
    ? { repoRoot: repo, path: repo, branch: 'main', baseRef: 'main', baseCommit: base }
    : undefined;
  const session = { id: 's1', label: 't', cwd: repo, readOnly: opts.readOnly, worktree } as unknown as Session;
  const getSession = (id: string): Session | undefined => (id === 's1' ? session : undefined);
  const git = createGitRunner();
  const tracker = new ChangeTracker({ git, getSession });
  const log = new CommandLog();
  const revert = new FileRevert({
    home, git, guard: new WriteGuard(git), log, tracker, getSession, isBusy: () => busy,
    now: () => clock, maxBackupBytes: opts.maxBackupBytes,
  });
  return {
    repo, home, base, tracker, revert, log, session,
    setBusy: (v: boolean) => { busy = v; },
    tick: (ms: number) => { clock += ms; },
    stage: () => sh(repo, 'ls-files', '-s'),
  };
}

type Env = ReturnType<typeof setup>;

/** 撤销后恢复：内容与暂存区都回到撤销前 */
async function roundTrip(env: Env, rel: string, files: string[], mode?: 'working' | 'base') {
  const before = new Map(files.map(f => [f, exists(env.repo, f) ? read(env.repo, f) : null]));
  const stageBefore = env.stage();
  await env.tracker.getChanges('s1', mode);
  const r = await env.revert.revert('s1', rel, mode, {});
  expect(r.ok, r.message + (r.detail ?? '')).toBe(true);
  expect(r.entry).toBeDefined();
  const entry = r.entry!;
  expect(env.revert.last('s1')).toEqual(entry);
  const res = await env.revert.restore('s1', entry.id, {});
  expect(res.ok, res.message + (res.detail ?? '')).toBe(true);
  for (const f of files) {
    const b = before.get(f);
    if (b === null) expect(exists(env.repo, f)).toBe(false);
    else expect(read(env.repo, f).equals(b!)).toBe(true);
  }
  expect(env.stage()).toBe(stageBefore);
  expect(env.revert.last('s1')).toBeNull();
}

describe('FileRevert 仅未提交口径', () => {
  it('修改文件回到 HEAD，备份写在 undo 目录下，恢复后逐字节一致', async () => {
    const env = setup();
    write(env.repo, 'a.txt', 'l1\nCHANGED\n');
    await env.tracker.getChanges('s1');
    const plan = await env.revert.plan('s1', 'a.txt');
    expect(plan).toMatchObject({ paths: ['a.txt'], untracked: false, largeBytes: 0, busy: false });
    expect(plan.command).toBe(`git restore --source=${env.base.slice(0, 7)} --staged --worktree -- a.txt`);
    const r = await env.revert.revert('s1', 'a.txt', undefined);
    expect(r.ok).toBe(true);
    expect(read(env.repo, 'a.txt').toString()).toBe('l1\nl2\nl3\n');
    expect(fs.existsSync(path.join(env.home, 'undo', 's1', r.entry!.id, 'manifest.json'))).toBe(true);
    expect(r.steps[0].display).toContain('restore');
    const res = await env.revert.restore('s1', r.entry!.id);
    expect(res.ok).toBe(true);
    expect(read(env.repo, 'a.txt').toString()).toBe('l1\nCHANGED\n');
  });

  it('暂存修改、二进制、CRLF、中文路径：往返一致，暂存区一致', async () => {
    const env = setup();
    write(env.repo, 'a.txt', 'staged\n');
    sh(env.repo, 'add', 'a.txt');
    write(env.repo, 'a.txt', 'staged\nand more\n');
    await roundTrip(env, 'a.txt', ['a.txt']);
    write(env.repo, 'bin.dat', Buffer.from([9, 0, 9, 0, 13]));
    await roundTrip(env, 'bin.dat', ['bin.dat']);
    write(env.repo, 'crlf.txt', 'x\r\nz\r\n\r\n');
    await roundTrip(env, 'crlf.txt', ['crlf.txt']);
    write(env.repo, '目录/中文 文件.txt', '改过的中文\r\n');
    await roundTrip(env, '目录/中文 文件.txt', ['目录/中文 文件.txt']);
  });

  it('暂存的新增文件从暂存区与磁盘一起移除，恢复后重新出现在暂存区', async () => {
    const env = setup();
    write(env.repo, 'new.txt', 'brand new\n');
    sh(env.repo, 'add', 'new.txt');
    await env.tracker.getChanges('s1');
    const r = await env.revert.revert('s1', 'new.txt', undefined);
    expect(r.ok).toBe(true);
    expect(exists(env.repo, 'new.txt')).toBe(false);
    expect(env.stage()).not.toContain('new.txt');
    await env.revert.restore('s1', r.entry!.id);
    expect(read(env.repo, 'new.txt').toString()).toBe('brand new\n');
    expect(env.stage()).toContain('new.txt');
  });

  it('未跟踪文件撤销即删除，恢复后回来', async () => {
    const env = setup();
    write(env.repo, 'note.md', '笔记\n');
    await env.tracker.getChanges('s1');
    const plan = await env.revert.plan('s1', 'note.md');
    expect(plan).toMatchObject({ untracked: true, source: '', command: '删除 note.md（未被 git 跟踪）' });
    await roundTrip(env, 'note.md', ['note.md']);
  });

  it('删除的文件撤销后回来；重命名的新旧两个路径一起恢复', async () => {
    const env = setup();
    fs.rmSync(path.join(env.repo, 'gone.txt'));
    await roundTrip(env, 'gone.txt', ['gone.txt']);
    sh(env.repo, 'mv', 'old.txt', 'renamed.txt');
    await env.tracker.getChanges('s1');
    const plan = await env.revert.plan('s1', 'renamed.txt');
    expect(plan.paths).toEqual(['renamed.txt', 'old.txt']);
    const stageBefore = env.stage();
    const r = await env.revert.revert('s1', 'renamed.txt', undefined);
    expect(r.ok).toBe(true);
    expect(exists(env.repo, 'renamed.txt')).toBe(false);
    expect(read(env.repo, 'old.txt').toString()).toBe('rename me\nline2\nline3\n');
    expect(sh(env.repo, 'status', '--porcelain')).not.toMatch(/old.txt|renamed.txt/);
    await env.revert.restore('s1', r.entry!.id);
    expect(exists(env.repo, 'old.txt')).toBe(false);
    expect(read(env.repo, 'renamed.txt').toString()).toBe('rename me\nline2\nline3\n');
    expect(env.stage()).toBe(stageBefore);
  });
});

describe('FileRevert 相对基线口径', () => {
  it('已提交的改动回到 baseCommit 并暂存；基线后新增的文件被移除；恢复后回到撤销前', async () => {
    const env = setup({ worktree: true });
    write(env.repo, 'a.txt', 'committed change\n');
    write(env.repo, 'later.txt', 'added after base\n');
    sh(env.repo, 'add', '.');
    sh(env.repo, 'commit', '-q', '-m', 'work');
    await env.tracker.getChanges('s1', 'base');
    const plan = await env.revert.plan('s1', 'a.txt', 'base');
    expect(plan.source).toBe(env.base.slice(0, 7));
    const r = await env.revert.revert('s1', 'a.txt', 'base');
    expect(r.ok).toBe(true);
    expect(read(env.repo, 'a.txt').toString()).toBe('l1\nl2\nl3\n');
    // 仅未提交口径下表现为一条已暂存的回退改动
    expect(sh(env.repo, 'status', '--porcelain')).toBe('M  a.txt');
    await roundTrip(env, 'later.txt', ['later.txt'], 'base');
    const r2 = await env.revert.revert('s1', 'later.txt', 'base');
    expect(r2.ok).toBe(true);
    expect(exists(env.repo, 'later.txt')).toBe(false);
    expect(env.stage()).not.toContain('later.txt');
  });
});

describe('FileRevert 确认与拒绝', () => {
  it('撤销之后又被修改：恢复先要求确认覆盖，确认后才写回', async () => {
    const env = setup();
    write(env.repo, 'a.txt', 'mine\n');
    await env.tracker.getChanges('s1');
    const r = await env.revert.revert('s1', 'a.txt', undefined);
    write(env.repo, 'a.txt', 'claude edited again\n');
    const res = await env.revert.restore('s1', r.entry!.id);
    expect(res).toMatchObject({ ok: false, needConfirm: 'overwrite', message: '撤销之后该文件又被修改过，恢复会覆盖这些修改' });
    expect(read(env.repo, 'a.txt').toString()).toBe('claude edited again\n');
    const ok = await env.revert.restore('s1', r.entry!.id, { overwrite: true });
    expect(ok.ok).toBe(true);
    expect(read(env.repo, 'a.txt').toString()).toBe('mine\n');
    expect((await env.revert.restore('s1', r.entry!.id, { overwrite: true })).message).toBe('这次撤销已经恢复过了');
  });

  it('冲突文件、上跳路径、不在列表里的路径、只读会话一律拒绝', async () => {
    const env = setup();
    sh(env.repo, 'checkout', '-q', '-b', 'other');
    write(env.repo, 'a.txt', 'other side\n');
    sh(env.repo, 'commit', '-q', '-am', 'other');
    sh(env.repo, 'checkout', '-q', 'main');
    write(env.repo, 'a.txt', 'main side\n');
    sh(env.repo, 'commit', '-q', '-am', 'main');
    try { sh(env.repo, 'merge', 'other'); } catch { /* 预期冲突 */ }
    await env.tracker.getChanges('s1');
    expect(await env.revert.revert('s1', 'a.txt', undefined)).toMatchObject({ ok: false, message: '冲突文件不能撤销，请先解决冲突' });
    expect((await env.revert.revert('s1', '../a.txt', undefined)).message).toBe('非法路径');
    expect((await env.revert.revert('s1', 'crlf.txt', undefined)).message).toBe('文件不在改动列表中');
    expect((await env.revert.revert('nope', 'a.txt', undefined)).message).toBe('会话不存在');
    expect((await env.revert.restore('s1', '../../x')).message).toBe('参数无效');

    const ro = setup({ readOnly: true });
    write(ro.repo, 'a.txt', 'x\n');
    await ro.tracker.getChanges('s1');
    const plan = await ro.revert.plan('s1', 'a.txt');
    expect(plan.blocked).toBe('此会话由其他面板实例运行，只能查看，不能执行写操作');
    expect((await ro.revert.revert('s1', 'a.txt', undefined)).ok).toBe(false);
    expect(read(ro.repo, 'a.txt').toString()).toBe('x\n');
  });

  it('会话正忙时需要再确认，确认后执行', async () => {
    const env = setup();
    write(env.repo, 'a.txt', 'busy edit\n');
    await env.tracker.getChanges('s1');
    env.setBusy(true);
    expect((await env.revert.plan('s1', 'a.txt')).busy).toBe(true);
    const r = await env.revert.revert('s1', 'a.txt', undefined);
    expect(r).toMatchObject({ ok: false, needConfirm: 'busy' });
    expect(read(env.repo, 'a.txt').toString()).toBe('busy edit\n');
    const r2 = await env.revert.revert('s1', 'a.txt', undefined, { force: true });
    expect(r2.ok).toBe(true);
    expect((await env.revert.restore('s1', r2.entry!.id)).needConfirm).toBe('busy');
    expect((await env.revert.restore('s1', r2.entry!.id, { force: true })).ok).toBe(true);
  });

  it('index.lock 被占：git 失败、文件不变、本次备份被删，并报告锁文件', async () => {
    const env = setup();
    write(env.repo, 'a.txt', 'locked edit\n');
    await env.tracker.getChanges('s1');
    const lock = path.join(env.repo, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    const r = await env.revert.revert('s1', 'a.txt', undefined);
    expect(r).toMatchObject({ ok: false, message: '撤销失败，文件未改动' });
    expect(r.lockFile && path.resolve(r.lockFile)).toBe(path.resolve(lock));
    expect(r.detail).toContain('另一个 git 进程正在操作');
    expect(read(env.repo, 'a.txt').toString()).toBe('locked edit\n');
    const dir = path.join(env.home, 'undo', 's1');
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    expect(env.revert.last('s1')).toBeNull();
    expect(env.log.list('s1').some(c => !c.ok && c.display.includes('restore'))).toBe(true);
    fs.rmSync(lock);
  });

  it('超大文件：先要求确认，撤销后不能恢复', async () => {
    const env = setup({ maxBackupBytes: 8 });
    write(env.repo, 'a.txt', 'this content is larger than eight bytes\n');
    await env.tracker.getChanges('s1');
    const plan = await env.revert.plan('s1', 'a.txt');
    expect(plan.largeBytes).toBe(40);
    const r = await env.revert.revert('s1', 'a.txt', undefined);
    expect(r).toMatchObject({ ok: false, needConfirm: 'large', message: '文件过大（40B），不备份，撤销后无法恢复' });
    const r2 = await env.revert.revert('s1', 'a.txt', undefined, { large: true });
    expect(r2.ok).toBe(true);
    expect(r2.entry!.restorable).toBe(false);
    expect(read(env.repo, 'a.txt').toString()).toBe('l1\nl2\nl3\n');
    expect((await env.revert.restore('s1', r2.entry!.id)).message).toBe('文件过大，撤销时未备份，无法恢复');
  });
});

describe('撤销备份清理', () => {
  it('单会话保留最近 10 次，超过 7 天的删除', async () => {
    const env = setup();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      write(env.repo, 'a.txt', `edit ${i}\n`);
      await env.tracker.getChanges('s1');
      const r = await env.revert.revert('s1', 'a.txt', undefined);
      expect(r.ok).toBe(true);
      ids.push(r.entry!.id);
      env.tick(1000);
    }
    const left = env.revert.store.list('s1').map(m => m.id);
    expect(left).toEqual(ids.slice(2).reverse());
    expect(env.revert.last('s1')?.id).toBe(ids[11]);
    env.tick(7 * 24 * 60 * 60 * 1000 + 1);
    expect(env.revert.prune()).toBe(10);
    expect(env.revert.store.list('s1')).toEqual([]);
    expect(fs.existsSync(path.join(env.home, 'undo', 's1'))).toBe(false);
  });

  it('总量超过上限时从最旧的开始删；残缺目录一并清掉', async () => {
    const env = setup();
    for (let i = 0; i < 3; i++) {
      write(env.repo, 'a.txt', `${'x'.repeat(1000)}${i}\n`);
      await env.tracker.getChanges('s1');
      await env.revert.revert('s1', 'a.txt', undefined);
      env.tick(1000);
    }
    fs.mkdirSync(path.join(env.home, 'undo', 's2', 'broken'), { recursive: true });
    const all = env.revert.store.list('s1');
    const removed = env.revert.store.prune({ keepPerSession: 10, maxAgeMs: 1e12, maxTotalBytes: 2500 });
    // 每份约 1.7KB（1KB 文件加清单），上限 2500 字节只能留下最新的一份；残缺目录另算一个
    expect(removed).toBe(3);
    expect(env.revert.store.list('s1').map(m => m.id)).toEqual([all[0].id]);
    expect(fs.existsSync(path.join(env.home, 'undo', 's2'))).toBe(false);
  });
});

