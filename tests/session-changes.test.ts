import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { createGitRunner } from '../src/main/git-runner';
import { SessionChanges, changeKey, type TrackedSession } from '../src/main/session-changes';
import type { RawHookPayload } from '../src/shared/types';
import type { SessionChangeSummary } from '../src/shared/session-change-types';

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function tmpDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function initRepo(prefix: string, files: Record<string, string>): string {
  const repo = tmpDir(prefix);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 't');
  sh(repo, 'config', 'core.autocrlf', 'false');
  for (const [rel, text] of Object.entries(files)) write(path.join(repo, ...rel.split('/')), text);
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeAll(() => {
  // 临时目录的上级（例如用户目录）若恰好是仓库，会让「普通目录」被识别成仓库
  const tmp = os.tmpdir();
  process.env.GIT_CEILING_DIRECTORIES = [tmp, fs.realpathSync.native(tmp)].join(path.delimiter);
});

function setup(cwd: string, opts: { maxBlobBytes?: number } = {}) {
  const home = tmpDir('panel-sc-home-');
  const session: TrackedSession = { cwd };
  const summaries: SessionChangeSummary[] = [];
  const make = () => new SessionChanges({
    home, git: createGitRunner(), getSession: id => (id === 's1' ? session : undefined),
    onSummary: (_id, s) => summaries.push(s), debounceMs: 10_000, maxBlobBytes: opts.maxBlobBytes,
  });
  const sc = make();
  const hook = (raw: RawHookPayload) => sc.preflight('s1', { cwd, ...raw });
  /** 模拟一次文件工具调用：PreToolUse 取快照后才执行写入，再上报 PostToolUse */
  const tool = async (name: string, file: string, act: () => void) => {
    await hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: { file_path: file } });
    act();
    await hook({ hook_event_name: 'PostToolUse', tool_name: name, tool_input: { file_path: file } });
  };
  /** 模拟一次 Bash：执行前后各取一次状态 */
  const bash = async (act: () => void) => {
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } });
    act();
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'x' } });
    await sleep(50);
  };
  return { home, sc, tool, bash, summaries, make };
}

describe('SessionChanges：普通目录', () => {
  it('Write 新建与 Edit 修改都列出，带完整地址与增删行数', async () => {
    const cwd = tmpDir('panel-sc-plain-');
    write(path.join(cwd, 'a.txt'), 'l1\nl2\n');
    const env = setup(cwd);
    const a = path.join(cwd, 'a.txt');
    const b = path.join(cwd, 'sub', 'b.txt');
    await env.tool('Edit', a, () => fs.appendFileSync(a, 'l3\n'));
    await env.tool('Write', b, () => write(b, 'x\ny\nz\n'));
    const list = await env.sc.list('s1');
    expect(list.files.map(f => f.rel)).toEqual(['a.txt', 'sub/b.txt']);
    const [fa, fb] = list.files;
    expect(fa).toMatchObject({ kind: 'modified', additions: 1, deletions: 0, repo: false, outside: false, baseline: 'exact', source: 'tool' });
    expect(fa.abs).toBe(a);
    expect(fa.root).toBe(cwd);
    expect(fb).toMatchObject({ kind: 'added', additions: 3, deletions: 0, baseline: 'exact' });
    expect(list.summary).toMatchObject({ files: 2, additions: 4, deletions: 0, roots: 1 });
    expect(list.roots).toEqual([{ root: cwd, repo: false, outside: false, files: 2 }]);
    expect(env.summaries.at(-1)?.files).toBe(2);
  });

  it('fileDiff 按改前快照对比；改回原样后不再列出', async () => {
    const cwd = tmpDir('panel-sc-plain-');
    const a = path.join(cwd, 'a.txt');
    write(a, 'one\ntwo\n');
    const env = setup(cwd);
    await env.tool('Edit', a, () => write(a, 'one\nTWO\n'));
    const d = await env.sc.fileDiff('s1', a);
    expect(d.error).toBeUndefined();
    const lines = d.hunks.flatMap(h => h.lines.map(l => `${l.kind}:${l.text}`));
    expect(lines).toContain('del:two');
    expect(lines).toContain('add:TWO');
    write(a, 'one\ntwo\n');
    expect((await env.sc.list('s1')).files).toEqual([]);
  });

  it('同一文件只取第一次改前的快照', async () => {
    const cwd = tmpDir('panel-sc-plain-');
    const a = path.join(cwd, 'a.txt');
    write(a, 'v1\n');
    const env = setup(cwd);
    await env.tool('Edit', a, () => write(a, 'v2\n'));
    await env.tool('Write', a, () => write(a, 'v3\n'));
    const [f] = (await env.sc.list('s1')).files;
    expect(f.tools).toEqual(['Edit', 'Write']);
    expect(fs.readFileSync(env.sc.baselinePath('s1', env.sc.entry('s1', a)!)!, 'utf8')).toBe('v1\n');
  });

  it('工具改完后文件又被改：标记 external', async () => {
    const cwd = tmpDir('panel-sc-plain-');
    const a = path.join(cwd, 'a.txt');
    write(a, 'v1\n');
    const env = setup(cwd);
    await env.tool('Edit', a, () => write(a, 'v2\n'));
    expect((await env.sc.list('s1')).files[0].external).toBeUndefined();
    write(a, 'v2 changed by user\n');
    expect((await env.sc.list('s1')).files[0].external).toBe(true);
  });

  it('Bash 在普通目录新建与修改文件：新建按不存在对比，修改没有改前内容', async () => {
    const cwd = tmpDir('panel-sc-plain-');
    const old = path.join(cwd, 'old.txt');
    write(old, 'keep\n');
    const env = setup(cwd);
    const created = path.join(cwd, 'gen', 'new.txt');
    await env.bash(() => {
      write(created, 'n1\nn2\n');
      fs.appendFileSync(old, 'more but bigger\n');
    });
    const list = await env.sc.list('s1');
    const byRel = new Map(list.files.map(f => [f.rel, f]));
    expect(byRel.get('gen/new.txt')).toMatchObject({ kind: 'added', source: 'bash', baseline: 'exact', additions: 2 });
    expect(byRel.get('old.txt')).toMatchObject({ kind: 'modified', source: 'bash', baseline: 'none', additions: null });
    const d = await env.sc.fileDiff('s1', old);
    expect(d.notice).toContain('没有改前内容');
  });

  it('改前内容超过上限：标记过大，diff 给出说明', async () => {
    const cwd = tmpDir('panel-sc-plain-');
    const a = path.join(cwd, 'big.txt');
    write(a, 'x'.repeat(200));
    const env = setup(cwd, { maxBlobBytes: 100 });
    await env.tool('Edit', a, () => write(a, 'y'.repeat(200)));
    const [f] = (await env.sc.list('s1')).files;
    expect(f.tooLarge).toBe(true);
    const d = await env.sc.fileDiff('s1', a);
    expect(d.notice).toContain('超过备份上限');
  });

  it('fileDiff 支持忽略空白：仅空白变化时差异消失并给提示', async () => {
    const cwd = tmpDir('panel-sc-ws-');
    const ws = path.join(cwd, 'ws.txt');
    const real = path.join(cwd, 'real.txt');
    write(ws, 'x\n');
    write(real, 'v1\n');
    const env = setup(cwd);
    await env.tool('Edit', ws, () => write(ws, ' x\n'));
    await env.tool('Edit', real, () => write(real, 'v2\n'));

    const plain = await env.sc.fileDiff('s1', ws);
    expect(plain.hunks).toHaveLength(1);
    const ignored = await env.sc.fileDiff('s1', ws, { ignoreWs: true });
    expect(ignored.hunks).toHaveLength(0);
    expect(ignored.emptyText).toContain('忽略空白后没有差异');

    const kept = await env.sc.fileDiff('s1', real, { ignoreWs: true });
    expect(kept.hunks).toHaveLength(1);
    expect(kept.hunks[0].lines).toEqual([
      { kind: 'del', oldNo: 1, text: 'v1' },
      { kind: 'add', newNo: 1, text: 'v2' },
    ]);
    // 列表统计不受忽略空白影响，两个文件照常带增删行数
    const list = await env.sc.list('s1');
    expect(list.files.map(f => f.rel)).toEqual(['real.txt', 'ws.txt']);
    expect(list.files.every(f => (f.additions ?? 0) === 1)).toBe(true);
  });

  it('只接受改动集里的绝对路径', async () => {
    const cwd = tmpDir('panel-sc-plain-');
    const a = path.join(cwd, 'a.txt');
    write(a, 'v1\n');
    const env = setup(cwd);
    await env.tool('Edit', a, () => write(a, 'v2\n'));
    expect(env.sc.entry('s1', a)).toBeDefined();
    expect(env.sc.entry('s1', 'a.txt')).toBeUndefined();
    expect(env.sc.entry('s1', path.join(cwd, 'other.txt'))).toBeUndefined();
    expect(env.sc.entry('nobody', a)).toBeUndefined();
    expect((await env.sc.fileDiff('s1', path.join(cwd, 'other.txt'))).error).toBe('文件不在本会话改动中');
  });

  it('清单落盘，新实例续接后仍能列出', async () => {
    const cwd = tmpDir('panel-sc-plain-');
    const a = path.join(cwd, 'a.txt');
    write(a, 'v1\n');
    const env = setup(cwd);
    await env.tool('Edit', a, () => write(a, 'v2\n'));
    await env.sc.list('s1');
    env.sc.dispose();
    const again = env.make();
    const list = await again.list('s1');
    expect(list.files.map(f => f.abs)).toEqual([a]);
    again.drop(['s1']);
    expect(fs.existsSync(path.join(env.home, 'changesets', 's1'))).toBe(false);
  });
});

describe('SessionChanges：仓库与跨目录', () => {
  it('跨仓库改动按仓库根分组，工作目录外的排在后面', async () => {
    const cwd = tmpDir('panel-sc-plain-');
    const inCwd = path.join(cwd, 'a.txt');
    write(inCwd, 'v1\n');
    const other = initRepo('panel-sc-other-', { 'src/x.ts': 'const x = 1;\n' });
    const outFile = path.join(other, 'src', 'x.ts');
    const env = setup(cwd);
    await env.tool('Edit', outFile, () => write(outFile, 'const x = 2;\n'));
    await env.tool('Edit', inCwd, () => write(inCwd, 'v2\n'));
    const list = await env.sc.list('s1');
    expect(list.files.map(f => [f.rel, f.outside, f.repo])).toEqual([
      ['a.txt', false, false],
      ['src/x.ts', true, true],
    ]);
    expect(changeKey(list.files[1].root)).toBe(changeKey(other));
    expect(list.roots.map(r => r.files)).toEqual([1, 1]);
    expect(list.summary.roots).toBe(2);
  });

  it('Bash 改动干净的已跟踪文件：以 HEAD 为改前内容；原本就有改动的只按 HEAD 对比', async () => {
    const repo = initRepo('panel-sc-repo-', { 'clean.txt': 'c1\n', 'dirty.txt': 'd1\n' });
    const dirty = path.join(repo, 'dirty.txt');
    write(dirty, 'd1\nlocal\n');
    const env = setup(repo);
    await env.bash(() => {
      fs.appendFileSync(path.join(repo, 'clean.txt'), 'c2\n');
      fs.appendFileSync(dirty, 'by bash longer\n');
      write(path.join(repo, 'fresh.txt'), 'f\n');
    });
    const byRel = new Map((await env.sc.list('s1')).files.map(f => [f.rel, f]));
    expect(byRel.get('clean.txt')).toMatchObject({ kind: 'modified', baseline: 'exact', source: 'bash', additions: 1, deletions: 0, repo: true });
    expect(byRel.get('dirty.txt')).toMatchObject({ baseline: 'head' });
    expect(byRel.get('fresh.txt')).toMatchObject({ kind: 'added', baseline: 'exact' });
    expect((await env.sc.fileDiff('s1', dirty)).notice).toContain('HEAD');
  });

  it('仓库里的 Edit 不受 HEAD 影响，按工具执行前的内容对比', async () => {
    const repo = initRepo('panel-sc-repo-', { 'a.txt': 'head\n' });
    const a = path.join(repo, 'a.txt');
    write(a, 'local\n');
    const env = setup(repo);
    await env.tool('Edit', a, () => write(a, 'local\nclaude\n'));
    const [f] = (await env.sc.list('s1')).files;
    expect(f).toMatchObject({ baseline: 'exact', additions: 1, deletions: 0 });
  });
});
