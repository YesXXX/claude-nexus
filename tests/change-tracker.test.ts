import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { createGitRunner, GitRunner } from '../src/main/git-runner';
import { ChangeTracker, ChangeTrackerDeps, TrackedSession } from '../src/main/change-tracker';
import type { ChangeSummary, WorktreeInfo } from '../src/shared/types';

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function tmpDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initRepo(dir: string): void {
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'core.autocrlf', 'false');
}

function write(root: string, rel: string, content: string | Buffer): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const BIN_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
const BIN_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x09, 0x08, 0x07]);

/** 带一次初始提交的仓库 */
function makeRepo(): string {
  const dir = tmpDir('panel-ct-');
  initRepo(dir);
  write(dir, 'a.txt', 'l1\nl2\nl3\n');
  write(dir, 'c.txt', 'c1\nc2\n');
  write(dir, 'old.txt', 'r1\nr2\nr3\nr4\n');
  write(dir, 'keep.txt', 'k\n');
  write(dir, 'img.bin', BIN_A);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** 在 makeRepo 基础上制造各类改动 */
function makeDirtyRepo(): string {
  const dir = makeRepo();
  write(dir, 'a.txt', 'l1\nL2\nl3\n');
  write(dir, 'new.txt', 'n1\nn2\n');
  sh(dir, 'add', 'new.txt');
  fs.rmSync(path.join(dir, 'c.txt'));
  fs.mkdirSync(path.join(dir, '中文'));
  sh(dir, 'mv', 'old.txt', '中文/新名.txt');
  write(dir, 'img.bin', BIN_B);
  write(dir, 'docs/笔记.md', 'x\ny');
  write(dir, 'blob.dat', BIN_A);
  return dir;
}

interface Harness {
  tracker: ChangeTracker;
  sessions: Map<string, TrackedSession>;
  summaries: Array<{ id: string; s: ChangeSummary }>;
}

function harness(extra: Partial<ChangeTrackerDeps> = {}): Harness {
  const sessions = new Map<string, TrackedSession>();
  const summaries: Array<{ id: string; s: ChangeSummary }> = [];
  const tracker = new ChangeTracker({
    git: createGitRunner(),
    getSession: id => sessions.get(id),
    onSummary: (id, s) => summaries.push({ id, s }),
    ...extra,
  });
  return { tracker, sessions, summaries };
}

function worktreeOf(repo: string, baseCommit: string): WorktreeInfo {
  return { repoRoot: repo, path: repo, branch: 'main', baseRef: 'main', baseCommit };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 等到 onSummary 回调次数达到 n（超时则让断言失败） */
async function waitSummaries(h: Harness, n: number, timeoutMs = 10000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (h.summaries.length < n && Date.now() < until) await sleep(10);
}

describe('ChangeTracker 文件列表', () => {
  it('区分修改 / 暂存新增 / 删除 / 重命名 / 二进制 / 未跟踪，统计增删行数，中文路径正确', async () => {
    const repo = makeDirtyRepo();
    const h = harness({ countSharedCwd: () => 2 });
    h.sessions.set('s1', { cwd: repo });

    const list = await h.tracker.getChanges('s1');
    expect(list.summary.error).toBeUndefined();
    expect(list.summary.mode).toBe('working');
    expect(list.truncated).toBe(false);
    expect(list.sharedWith).toBe(2);
    expect(list.files.map(f => f.path)).toEqual([
      'a.txt', 'blob.dat', 'docs/笔记.md', 'img.bin', 'new.txt', '中文/新名.txt', 'c.txt',
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    const byPath = new Map(list.files.map(f => [f.path, f]));
    expect(byPath.get('a.txt')).toMatchObject({ kind: 'modified', additions: 1, deletions: 1, binary: false });
    expect(byPath.get('new.txt')).toMatchObject({ kind: 'added', additions: 2, deletions: 0 });
    expect(byPath.get('c.txt')).toMatchObject({ kind: 'deleted', additions: 0, deletions: 2 });
    expect(byPath.get('中文/新名.txt')).toMatchObject({ kind: 'renamed', oldPath: 'old.txt', additions: 0, deletions: 0 });
    expect(byPath.get('img.bin')).toMatchObject({ kind: 'modified', additions: null, deletions: null, binary: true });
    expect(byPath.get('docs/笔记.md')).toMatchObject({ kind: 'untracked', additions: 2, deletions: 0, binary: false });
    expect(byPath.get('blob.dat')).toMatchObject({ kind: 'untracked', additions: null, binary: true });

    expect(list.summary).toMatchObject({ files: 7, additions: 5, deletions: 3 });
    expect(h.tracker.getSummary('s1')).toEqual(list.summary);
    expect(h.summaries).toHaveLength(1);
    expect(h.tracker.getRepoRoot('s1')).toBe(path.resolve(repo));
    // 列表带上仓库根，渲染层据此拼出完整地址
    expect(list.root).toBe(path.resolve(repo));
  });

  it('会话 cwd 是仓库子目录时仍按仓库根统计', async () => {
    const repo = makeRepo();
    write(repo, 'sub/x.txt', '1\n');
    write(repo, 'a.txt', 'changed\n');
    const h = harness();
    h.sessions.set('s1', { cwd: path.join(repo, 'sub') });
    const list = await h.tracker.getChanges('s1');
    expect(list.files.map(f => f.path)).toEqual(['a.txt', 'sub/x.txt']);
    expect(list.root?.toLowerCase()).toBe(fs.realpathSync.native(repo).toLowerCase());
  });

  it('工作区会话：相对基线包含已提交改动，仅未提交只看工作区；口径被记住', async () => {
    const repo = makeRepo();
    const base = sh(repo, 'rev-parse', 'HEAD');
    write(repo, 'a.txt', 'l1\nl2\nl3\nl4\n');
    sh(repo, 'commit', '-q', '-am', 'work');
    write(repo, 'u.txt', 'u\n');
    write(repo, '.claude/settings.local.json', '{}');

    const h = harness({ countSharedCwd: () => 5 });
    h.sessions.set('wt', { cwd: repo, worktree: worktreeOf(repo, base) });

    const baseList = await h.tracker.getChanges('wt');
    expect(baseList.summary.mode).toBe('base');
    expect(baseList.sharedWith).toBe(0);
    // 面板复制进工作区的本地配置不计入
    expect(baseList.files.map(f => f.path)).toEqual(['a.txt', 'u.txt']);
    expect(baseList.files[0]).toMatchObject({ kind: 'modified', additions: 1, deletions: 0 });

    const diff = await h.tracker.getFileDiff('wt', 'a.txt');
    expect(diff.error).toBeUndefined();
    expect(diff.hunks[0].lines.filter(l => l.kind === 'add').map(l => l.text)).toEqual(['l4']);

    const working = await h.tracker.getChanges('wt', 'working');
    expect(working.summary.mode).toBe('working');
    expect(working.files.map(f => f.path)).toEqual(['u.txt']);
    expect((await h.tracker.getFileDiff('wt', 'a.txt', 'working')).error).toBe('文件不在改动列表中');

    // 后台刷新沿用最近一次指定的口径
    const s = await h.tracker.refresh('wt');
    expect(s).toMatchObject({ mode: 'working', files: 1 });

    // 普通会话请求相对基线时回落为仅未提交，且本地配置照常列出
    h.sessions.set('plain', { cwd: repo });
    const plain = await h.tracker.getChanges('plain', 'base');
    expect(plain.summary.mode).toBe('working');
    expect(plain.files.map(f => f.path)).toEqual(['.claude/settings.local.json', 'u.txt']);
  });

  it('仓库还没有提交时按空树口径统计', async () => {
    const repo = tmpDir('panel-ct-empty-');
    initRepo(repo);
    write(repo, 'x.txt', 'a\nb\n');
    sh(repo, 'add', 'x.txt');
    write(repo, 'y.txt', 'c\n');
    const h = harness();
    h.sessions.set('s1', { cwd: repo });
    const list = await h.tracker.getChanges('s1');
    expect(list.summary.error).toBeUndefined();
    expect(list.files).toEqual([
      { path: 'x.txt', kind: 'added', additions: 2, deletions: 0, binary: false },
      { path: 'y.txt', kind: 'untracked', additions: 1, deletions: 0, binary: false },
    ]);
    const diff = await h.tracker.getFileDiff('s1', 'x.txt');
    expect(diff.hunks[0].lines.map(l => l.text)).toEqual(['a', 'b']);
  });

  it('非仓库目录与会话不存在时给出错误摘要', async () => {
    const plain = tmpDir('panel-ct-plain-');
    const h = harness();
    h.sessions.set('s1', { cwd: plain });
    const list = await h.tracker.getChanges('s1');
    expect(list.summary).toMatchObject({ files: 0, additions: 0, deletions: 0, error: '不是 git 仓库' });
    expect(list.files).toEqual([]);

    const s = await h.tracker.refresh('s1');
    expect(s?.error).toBe('不是 git 仓库');
    expect(h.summaries.map(x => x.s.error)).toEqual(['不是 git 仓库', '不是 git 仓库']);

    expect((await h.tracker.getChanges('nope')).summary.error).toBe('会话不存在');
  });

  it('git 超时：摘要带超时说明', async () => {
    const repo = makeRepo();
    const real = createGitRunner();
    const git: GitRunner = {
      run(cwd, args, opts) {
        if (args[0] === 'status') {
          return Promise.resolve({ code: -2, stdout: '', stderr: '', ms: 15000, notFound: false, timedOut: true });
        }
        return real.run(cwd, args, opts);
      },
    };
    const h = harness({ git });
    h.sessions.set('s1', { cwd: repo });
    const s = await h.tracker.refresh('s1');
    expect(s?.error).toBe('git 执行超时（15 秒）');
    expect(s?.files).toBe(0);
  });

  it('文件数超过上限时截断，摘要仍报告总数', async () => {
    const repo = makeRepo();
    for (const n of ['e', 'a', 'd', 'b', 'c']) write(repo, `u/${n}.txt`, `${n}\n`);
    const h = harness({ maxFiles: 3 });
    h.sessions.set('s1', { cwd: repo });
    const list = await h.tracker.getChanges('s1');
    expect(list.truncated).toBe(true);
    expect(list.files.map(f => f.path)).toEqual(['u/a.txt', 'u/b.txt', 'u/c.txt']);
    expect(list.summary.files).toBe(5);
    expect(list.summary.additions).toBe(3);
  });

  it('remember 为 false：只计算，不改变会话当前的口径、摘要缓存，也不回调', async () => {
    const repo = makeRepo();
    const base = sh(repo, 'rev-parse', 'HEAD');
    write(repo, 'a.txt', 'l1\nl2\nl3\nl4\n');
    sh(repo, 'commit', '-q', '-am', 'work');
    write(repo, 'u.txt', 'u\n');
    const h = harness();
    h.sessions.set('wt', { cwd: repo, worktree: worktreeOf(repo, base) });

    const working = await h.tracker.getChanges('wt', 'working');
    expect(working.files.map(f => f.path)).toEqual(['u.txt']);
    const callbacks = h.summaries.length;

    const peek = await h.tracker.getChanges('wt', 'base', { remember: false });
    expect(peek.summary.mode).toBe('base');
    expect(peek.files.map(f => f.path)).toEqual(['a.txt', 'u.txt']);
    expect(h.summaries.length).toBe(callbacks);
    expect(h.tracker.getSummary('wt')).toMatchObject({ mode: 'working', files: 1 });
    expect(await h.tracker.refresh('wt')).toMatchObject({ mode: 'working', files: 1 });

    // 从未统计过的会话也不会因此留下缓存
    h.sessions.set('fresh', { cwd: repo, worktree: worktreeOf(repo, base) });
    const f = await h.tracker.getChanges('fresh', 'base', { remember: false });
    expect(f.summary.files).toBe(2);
    expect(h.tracker.getSummary('fresh')).toBeUndefined();
    expect((await h.tracker.getChanges('gone', 'base', { remember: false })).summary.error).toBe('会话不存在');
  });
});

describe('ChangeTracker 单文件 diff', () => {
  it('已跟踪修改、未跟踪、删除、二进制、重命名、非 UTF-8', async () => {
    const repo = makeDirtyRepo();
    write(repo, 'gbk.txt', Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]));
    const h = harness();
    h.sessions.set('s1', { cwd: repo });
    await h.tracker.getChanges('s1');

    const mod = await h.tracker.getFileDiff('s1', 'a.txt');
    expect(mod.error).toBeUndefined();
    expect(mod.binary).toBe(false);
    expect(mod.hunks).toHaveLength(1);
    expect(mod.hunks[0].lines).toEqual([
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'l1' },
      { kind: 'del', oldNo: 2, text: 'l2' },
      { kind: 'add', newNo: 2, text: 'L2' },
      { kind: 'ctx', oldNo: 3, newNo: 3, text: 'l3' },
    ]);

    const untracked = await h.tracker.getFileDiff('s1', 'docs/笔记.md');
    expect(untracked.error).toBeUndefined();
    expect(untracked.path).toBe('docs/笔记.md');
    expect(untracked.hunks[0].lines).toEqual([
      { kind: 'add', newNo: 1, text: 'x' },
      { kind: 'add', newNo: 2, text: 'y' },
      { kind: 'meta', text: 'No newline at end of file' },
    ]);

    const del = await h.tracker.getFileDiff('s1', 'c.txt');
    expect(del.error).toBeUndefined();
    expect(del.hunks[0].lines.map(l => `${l.kind}:${l.text}`)).toEqual(['del:c1', 'del:c2']);

    const bin = await h.tracker.getFileDiff('s1', 'img.bin');
    expect(bin).toMatchObject({ binary: true, hunks: [] });
    expect(bin.error).toBeUndefined();
    expect(await h.tracker.getFileDiff('s1', 'blob.dat')).toMatchObject({ binary: true, hunks: [] });

    const ren = await h.tracker.getFileDiff('s1', '中文/新名.txt');
    expect(ren.error).toBeUndefined();
    expect(ren.hunks).toEqual([]);   // 纯重命名没有内容差异

    const gbk = await h.tracker.getFileDiff('s1', 'gbk.txt');
    expect(gbk.notUtf8).toBe(true);
    expect(mod.notUtf8).toBeUndefined();
  });

  it('未跟踪大文件截断到 512KB', async () => {
    const repo = makeRepo();
    write(repo, 'big.txt', 'abcdefghij\n'.repeat(60000));   // 约 660KB
    const h = harness();
    h.sessions.set('s1', { cwd: repo });
    const diff = await h.tracker.getFileDiff('s1', 'big.txt');
    expect(diff.error).toBeUndefined();
    expect(diff.truncated).toBe(true);
    expect(diff.hunks[0].lines.length).toBeLessThanOrEqual(5000);
  });

  it('白名单：上跳路径、绝对路径、不在改动列表里的文件都拒绝', async () => {
    const repo = makeDirtyRepo();
    const h = harness();
    h.sessions.set('s1', { cwd: repo });
    await h.tracker.getChanges('s1');

    expect((await h.tracker.getFileDiff('s1', '../x')).error).toBe('非法路径');
    expect((await h.tracker.getFileDiff('s1', 'docs/../../x')).error).toBe('非法路径');
    expect((await h.tracker.getFileDiff('s1', path.join(repo, 'a.txt'))).error).toBe('非法路径');
    expect((await h.tracker.getFileDiff('s1', '/etc/passwd')).error).toBe('非法路径');
    expect((await h.tracker.getFileDiff('s1', 'keep.txt')).error).toBe('文件不在改动列表中');
    expect((await h.tracker.getFileDiff('s1', 'nope.txt')).error).toBe('文件不在改动列表中');
  });

  it('尚未拉取列表时按需取列表再校验；反斜杠路径等价于正斜杠', async () => {
    const repo = makeDirtyRepo();
    const h = harness();
    h.sessions.set('s1', { cwd: repo });
    const diff = await h.tracker.getFileDiff('s1', 'docs\\笔记.md');
    expect(diff.error).toBeUndefined();
    expect(diff.path).toBe('docs/笔记.md');
    // 白名单校验用的临时列表不写入摘要缓存
    expect(h.tracker.getSummary('s1')).toBeUndefined();
  });

  it('忽略空白：diff 内容忽略空白差异，仅空白变化的文件给提示，列表统计仍按原口径', async () => {
    const repo = tmpDir('panel-ct-ws-');
    initRepo(repo);
    write(repo, 'a.txt', 'l1\nl2\n');
    write(repo, 'ws.txt', 'x\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-q', '-m', 'init');
    write(repo, 'a.txt', 'l1\nL2\n');
    write(repo, 'ws.txt', ' x\n');
    const h = harness();
    h.sessions.set('s1', { cwd: repo });

    // 列表与统计不忽略空白：ws.txt 照常计 1 增 1 删
    const list = await h.tracker.getChanges('s1');
    const byPath = new Map(list.files.map(f => [f.path, f]));
    expect(byPath.get('ws.txt')).toMatchObject({ kind: 'modified', additions: 1, deletions: 1 });

    const plain = await h.tracker.getFileDiff('s1', 'ws.txt');
    expect(plain.hunks).toHaveLength(1);

    const ws = await h.tracker.getFileDiff('s1', 'ws.txt', undefined, { ignoreWs: true });
    expect(ws.error).toBeUndefined();
    expect(ws.hunks).toHaveLength(0);
    expect(ws.emptyText).toContain('忽略空白后没有差异');

    // 有实质内容变化的文件忽略空白后照常显示差异
    const wsA = await h.tracker.getFileDiff('s1', 'a.txt', undefined, { ignoreWs: true });
    expect(wsA.hunks).toHaveLength(1);
    expect(wsA.hunks[0].lines).toEqual([
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'l1' },
      { kind: 'del', oldNo: 2, text: 'l2' },
      { kind: 'add', newNo: 2, text: 'L2' },
    ]);
    expect(wsA.emptyText).toBeUndefined();
  });

  it('打开 / 定位用的路径解析与 diff 同一套白名单，已删除的文件同样能解析', async () => {
    const repo = makeDirtyRepo();
    const h = harness();
    h.sessions.set('s1', { cwd: path.join(repo, 'docs') });
    await h.tracker.getChanges('s1');

    expect(await h.tracker.resolveChangedPath('s1', '中文/新名.txt'))
      .toEqual({ abs: path.join(path.resolve(repo), '中文', '新名.txt') });
    expect(await h.tracker.resolveChangedPath('s1', 'c.txt')).toEqual({ abs: path.join(path.resolve(repo), 'c.txt') });
    expect(await h.tracker.resolveChangedPath('s1', '../a.txt')).toEqual({ error: '非法路径' });
    expect(await h.tracker.resolveChangedPath('s1', path.join(repo, 'a.txt'))).toEqual({ error: '非法路径' });
    expect(await h.tracker.resolveChangedPath('s1', 'keep.txt')).toEqual({ error: '文件不在改动列表中' });
    expect(await h.tracker.resolveChangedPath('nobody', 'a.txt')).toEqual({ error: '会话不存在' });
  });
});

describe('ChangeTracker 刷新调度', () => {
  it('防抖：连续多次工具事件只刷新一次，其他事件忽略', async () => {
    const repo = makeDirtyRepo();
    const h = harness({ debounceMs: 30 });
    h.sessions.set('s1', { cwd: repo });

    h.tracker.onEvent('s1', { type: 'idle_prompt' });
    h.tracker.onEvent('s1', { type: 'tool_started', toolName: 'Edit' });
    await sleep(80);
    expect(h.summaries).toHaveLength(0);

    for (let i = 0; i < 5; i++) h.tracker.onEvent('s1', { type: 'tool_finished' });
    h.tracker.onEvent('s1', { type: 'turn_completed' });
    await waitSummaries(h, 1);
    await sleep(150);
    expect(h.summaries).toHaveLength(1);
    expect(h.summaries[0].s.files).toBe(7);
    h.tracker.dispose();
  });

  it('慢仓库降频：上次统计超过 1.5 秒后只在一轮结束时刷新', async () => {
    const repo = makeRepo();
    let clock = 0;
    let slow = true;
    const real = createGitRunner();
    const git: GitRunner = {
      async run(cwd, args, opts) {
        const r = await real.run(cwd, args, opts);
        if (slow) clock += 1000;
        return r;
      },
    };
    const h = harness({ git, debounceMs: 20, now: () => clock });
    h.sessions.set('s1', { cwd: repo });

    await h.tracker.refresh('s1');
    expect(h.summaries).toHaveLength(1);

    h.tracker.onEvent('s1', { type: 'tool_finished' });
    await sleep(120);
    expect(h.summaries).toHaveLength(1);

    slow = false;
    h.tracker.onEvent('s1', { type: 'turn_completed' });
    await waitSummaries(h, 2);
    expect(h.summaries).toHaveLength(2);

    // 统计恢复快速后，工具事件重新生效
    h.tracker.onEvent('s1', { type: 'tool_finished' });
    await waitSummaries(h, 3);
    expect(h.summaries).toHaveLength(3);
    h.tracker.dispose();
  });

  it('同一会话不并发统计：进行中的多次请求合并为结束后补跑一次', async () => {
    const repo = makeRepo();
    let active = 0;
    let maxActive = 0;
    let statusCalls = 0;
    const real = createGitRunner();
    const git: GitRunner = {
      async run(cwd, args, opts) {
        if (args[0] !== 'status') return real.run(cwd, args, opts);
        statusCalls++;
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          return await real.run(cwd, args, opts);
        } finally {
          active--;
        }
      },
    };
    const h = harness({ git });
    h.sessions.set('s1', { cwd: repo });
    const results = await Promise.all([h.tracker.refresh('s1'), h.tracker.refresh('s1'), h.tracker.refresh('s1')]);
    expect(statusCalls).toBe(2);
    expect(maxActive).toBe(1);
    expect(h.summaries).toHaveLength(2);
    for (const r of results) expect(r).toEqual(h.tracker.getSummary('s1'));
  });

  it('forget 清掉缓存与待执行的刷新', async () => {
    const repo = makeDirtyRepo();
    const h = harness({ debounceMs: 30 });
    h.sessions.set('s1', { cwd: repo });
    await h.tracker.getChanges('s1');
    expect(h.tracker.getSummary('s1')).toBeDefined();

    h.tracker.onEvent('s1', { type: 'turn_completed' });
    h.tracker.forget('s1');
    expect(h.tracker.getSummary('s1')).toBeUndefined();
    await sleep(120);
    expect(h.summaries).toHaveLength(1);
  });
});
