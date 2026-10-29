import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { createGitRunner } from '../src/main/git-runner';
import { SessionChanges, type TrackedSession } from '../src/main/session-changes';
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

beforeAll(() => {
  // 临时目录的上级若恰好是仓库，会让「普通目录」被识别成仓库
  const tmp = os.tmpdir();
  process.env.GIT_CEILING_DIRECTORIES = [tmp, fs.realpathSync.native(tmp)].join(path.delimiter);
});

function setup(cwd: string) {
  const home = tmpDir('panel-sc-home-');
  const session: TrackedSession = { cwd };
  const summaries: SessionChangeSummary[] = [];
  const sc = new SessionChanges({
    home, git: createGitRunner(), getSession: id => (id === 's1' ? session : undefined),
    onSummary: (_id, s) => summaries.push(s), debounceMs: 10_000,
  });
  const hook = (raw: RawHookPayload) => sc.preflight('s1', { cwd, ...raw });
  /** 模拟一次文件工具调用：PreToolUse 取快照后才执行写入，再上报 PostToolUse */
  const tool = async (name: string, file: string, act: () => void) => {
    await hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: { file_path: file } });
    act();
    await hook({ hook_event_name: 'PostToolUse', tool_name: name, tool_input: { file_path: file } });
  };
  const dir = path.join(home, 'changesets', 's1');
  const blobs = () => {
    try { return fs.readdirSync(path.join(dir, 'blobs')).sort(); } catch { return []; }
  };
  const manifest = () => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { bytes: number; entries: unknown[] };
  return { home, sc, tool, summaries, dir, blobs, manifest };
}

describe('SessionChanges：清除改动记录', () => {
  it('clearAll 清空记录与磁盘目录，摘要归零；之后再改同一文件以那时的内容为新基线', async () => {
    const cwd = tmpDir('panel-sc-plain-');
    const a = path.join(cwd, 'a.txt');
    const b = path.join(cwd, 'b.txt');
    write(a, 'a1\n');
    write(b, 'b1\n');
    const env = setup(cwd);
    await env.tool('Edit', a, () => write(a, 'a2\n'));
    await env.tool('Edit', b, () => write(b, 'b2\n'));
    expect((await env.sc.list('s1')).files).toHaveLength(2);

    expect(await env.sc.clearAll('s1')).toEqual({ removed: 2 });
    expect(fs.existsSync(env.dir)).toBe(false);
    expect((await env.sc.list('s1')).files).toEqual([]);
    expect(env.summaries.at(-1)).toMatchObject({ files: 0, additions: 0, deletions: 0 });

    await env.tool('Edit', a, () => write(a, 'a3\n'));
    const [f] = (await env.sc.list('s1')).files;
    expect(f).toMatchObject({ kind: 'modified', additions: 1, deletions: 1, baseline: 'exact' });
    const d = await env.sc.fileDiff('s1', a);
    const lines = d.hunks.flatMap(h => h.lines.map(l => `${l.kind}:${l.text}`));
    expect(lines).toContain('del:a2');
    expect(lines).toContain('add:a3');
  });

  it('clearAll 对未知会话或没有记录的会话返回 0', async () => {
    const env = setup(tmpDir('panel-sc-plain-'));
    expect(await env.sc.clearAll('nobody')).toEqual({ removed: 0 });
    expect(await env.sc.clearAll('s1')).toEqual({ removed: 0 });
  });

  it('dismiss 只删指定文件，回收失去引用的副本并重算字节数', async () => {
    const cwd = tmpDir('panel-sc-plain-');
    const a = path.join(cwd, 'a.txt');
    const b = path.join(cwd, 'b.txt');
    write(a, 'aaaa\n');
    write(b, 'bb\n');
    const env = setup(cwd);
    await env.tool('Edit', a, () => write(a, 'aaaa2\n'));
    await env.tool('Edit', b, () => write(b, 'bb2\n'));
    expect(env.blobs()).toHaveLength(2);
    expect(env.manifest().bytes).toBe(Buffer.byteLength('aaaa\n') + Buffer.byteLength('bb\n'));

    expect(await env.sc.dismiss('s1', [a])).toEqual({ removed: 1 });
    expect((await env.sc.list('s1')).files.map(f => f.abs)).toEqual([b]);
    expect(env.blobs()).toHaveLength(1);
    expect(env.manifest().bytes).toBe(Buffer.byteLength('bb\n'));
    expect(env.manifest().entries).toHaveLength(1);
    expect(env.sc.entry('s1', a)).toBeUndefined();
    expect((await env.sc.fileDiff('s1', a)).error).toBe('文件不在本会话改动中');
  });

  it('dismiss 忽略不在改动集里的路径、相对路径与非法参数', async () => {
    const cwd = tmpDir('panel-sc-plain-');
    const a = path.join(cwd, 'a.txt');
    write(a, 'v1\n');
    const env = setup(cwd);
    await env.tool('Edit', a, () => write(a, 'v2\n'));
    expect(await env.sc.dismiss('s1', [path.join(cwd, 'nope.txt'), 'a.txt', ''])).toEqual({ removed: 0 });
    expect(await env.sc.dismiss('nobody', [a])).toEqual({ removed: 0 });
    expect((await env.sc.list('s1')).files).toHaveLength(1);
  });

  it('两个文件改前内容相同时共用一个副本，删一个不会误删副本', async () => {
    const cwd = tmpDir('panel-sc-plain-');
    const a = path.join(cwd, 'a.txt');
    const b = path.join(cwd, 'b.txt');
    write(a, 'same\n');
    write(b, 'same\n');
    const env = setup(cwd);
    await env.tool('Edit', a, () => write(a, 'a2\n'));
    await env.tool('Edit', b, () => write(b, 'b2\n'));
    expect(env.blobs()).toHaveLength(1);

    await env.sc.dismiss('s1', [a]);
    expect(env.blobs()).toHaveLength(1);
    expect(env.manifest().bytes).toBe(Buffer.byteLength('same\n'));
    const d = await env.sc.fileDiff('s1', b);
    expect(d.error).toBeUndefined();
    expect(d.hunks.flatMap(h => h.lines.map(l => `${l.kind}:${l.text}`))).toContain('del:same');

    await env.sc.dismiss('s1', [b]);
    expect(env.blobs()).toHaveLength(0);
    expect(env.manifest().bytes).toBe(0);
  });

  it('dismissRoot 按分组清除：工作目录内外互不影响，不受列表截断限制', async () => {
    const cwd = tmpDir('panel-sc-plain-');
    const inA = path.join(cwd, 'src', 'a.txt');
    const inB = path.join(cwd, 'src', 'deep', 'b.txt');
    write(inA, '1\n');
    write(inB, '1\n');
    const other = initRepo('panel-sc-other-', { 'x.ts': 'x1\n', 'y.ts': 'y1\n' });
    const outX = path.join(other, 'x.ts');
    const outY = path.join(other, 'y.ts');
    const env = setup(cwd);
    for (const f of [inA, inB, outX, outY]) await env.tool('Edit', f, () => write(f, '2\n'));

    const before = await env.sc.list('s1');
    expect(before.files).toHaveLength(4);
    const outRoot = before.files.find(f => f.outside)!.root;

    expect(await env.sc.dismissRoot('s1', outRoot, true)).toEqual({ removed: 2 });
    expect((await env.sc.list('s1')).files.map(f => f.abs).sort()).toEqual([inA, inB].sort());

    // 同一个根目录下，把 outside 误传成 false 不会删到工作目录外（此时已清空）也不会误删目录内的文件
    expect(await env.sc.dismissRoot('s1', outRoot, false)).toEqual({ removed: 0 });
    expect((await env.sc.list('s1')).files).toHaveLength(2);

    expect(await env.sc.dismissRoot('s1', cwd, false)).toEqual({ removed: 2 });
    expect((await env.sc.list('s1')).files).toEqual([]);
    expect(env.blobs()).toHaveLength(0);
    expect(env.manifest().bytes).toBe(0);
  });

  it('清除后落盘：新实例续接看不到已清除的记录', async () => {
    const cwd = tmpDir('panel-sc-plain-');
    const a = path.join(cwd, 'a.txt');
    const b = path.join(cwd, 'b.txt');
    write(a, '1\n');
    write(b, '1\n');
    const env = setup(cwd);
    await env.tool('Edit', a, () => write(a, '2\n'));
    await env.tool('Edit', b, () => write(b, '2\n'));
    await env.sc.dismiss('s1', [a]);
    env.sc.dispose();

    const again = new SessionChanges({
      home: env.home, git: createGitRunner(), getSession: id => (id === 's1' ? { cwd } : undefined), debounceMs: 10_000,
    });
    expect((await again.list('s1')).files.map(f => f.abs)).toEqual([b]);
  });
});
