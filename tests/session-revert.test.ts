import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createGitRunner } from '../src/main/git-runner';
import { SessionChanges } from '../src/main/session-changes';
import { SessionRevert } from '../src/main/session-revert';
import { WriteGuard } from '../src/main/write-guard';
import type { RawHookPayload, Session } from '../src/shared/types';

function tmpDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeAll(() => {
  const tmp = os.tmpdir();
  process.env.GIT_CEILING_DIRECTORIES = [tmp, fs.realpathSync.native(tmp)].join(path.delimiter);
});

function setup(opts: { readOnly?: boolean; maxBlobBytes?: number; maxBackupBytes?: number } = {}) {
  const cwd = tmpDir('panel-sr-cwd-');
  const home = tmpDir('panel-sr-home-');
  const session = { id: 's1', label: 't', cwd, readOnly: opts.readOnly } as unknown as Session;
  const getSession = (id: string) => (id === 's1' ? session : undefined);
  const git = createGitRunner();
  const changes = new SessionChanges({ home, git, getSession, debounceMs: 10_000, maxBlobBytes: opts.maxBlobBytes });
  let busy = false;
  let clock = 1_700_000_000_000;
  const revert = new SessionRevert({
    home, guard: new WriteGuard(git), changes, getSession, isBusy: () => busy,
    now: () => (clock += 1000), maxBackupBytes: opts.maxBackupBytes,
  });
  const hook = (raw: RawHookPayload) => changes.preflight('s1', { cwd, ...raw });
  const tool = async (name: string, file: string, act: () => void) => {
    await hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: { file_path: file } });
    act();
    await hook({ hook_event_name: 'PostToolUse', tool_name: name, tool_input: { file_path: file } });
  };
  const bash = async (act: () => void) => {
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } });
    act();
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'x' } });
    await sleep(50);
  };
  return { cwd, home, changes, revert, tool, bash, setBusy: (v: boolean) => { busy = v; } };
}

describe('SessionRevert', () => {
  it('撤销修改：写回首次修改前的内容；恢复后回到撤销前', async () => {
    const env = setup();
    const a = path.join(env.cwd, 'a.txt');
    write(a, 'before\n');
    await env.tool('Edit', a, () => write(a, 'after\n'));
    await env.changes.list('s1');

    const plan = await env.revert.plan('s1', a);
    expect(plan.blocked).toBeUndefined();
    expect(plan).toMatchObject({ paths: [a], untracked: false, largeBytes: 0, busy: false });
    expect(plan.command).toContain('首次修改前');

    const r = await env.revert.revert('s1', a);
    expect(r.ok, r.message + (r.detail ?? '')).toBe(true);
    expect(fs.readFileSync(a, 'utf8')).toBe('before\n');
    expect(r.entry).toMatchObject({ scope: 'session', restorable: true, paths: [a] });
    expect((await env.changes.list('s1')).files).toEqual([]);

    const last = env.revert.last('s1');
    expect(last?.id).toBe(r.entry?.id);
    const back = await env.revert.restore('s1', last!.id);
    expect(back.ok, back.message).toBe(true);
    expect(fs.readFileSync(a, 'utf8')).toBe('after\n');
    expect(env.revert.last('s1')).toBeNull();
    expect((await env.changes.list('s1')).files.map(f => f.abs)).toEqual([a]);
  });

  it('撤销本会话新建的文件：删除；恢复后重新出现', async () => {
    const env = setup();
    const b = path.join(env.cwd, 'new', 'b.txt');
    await env.tool('Write', b, () => write(b, 'created\n'));
    const plan = await env.revert.plan('s1', b);
    expect(plan.untracked).toBe(true);
    expect(plan.command).toContain('本会话新建');
    const r = await env.revert.revert('s1', b);
    expect(r.ok, r.message).toBe(true);
    expect(fs.existsSync(b)).toBe(false);
    const back = await env.revert.restore('s1', r.entry!.id);
    expect(back.ok, back.message).toBe(true);
    expect(fs.readFileSync(b, 'utf8')).toBe('created\n');
  });

  it('撤销后文件又被改过：恢复需确认覆盖', async () => {
    const env = setup();
    const a = path.join(env.cwd, 'a.txt');
    write(a, 'v1\n');
    await env.tool('Edit', a, () => write(a, 'v2\n'));
    const r = await env.revert.revert('s1', a);
    expect(r.ok).toBe(true);
    write(a, 'v1 then user edit\n');
    const first = await env.revert.restore('s1', r.entry!.id);
    expect(first).toMatchObject({ ok: false, needConfirm: 'overwrite' });
    expect(fs.readFileSync(a, 'utf8')).toBe('v1 then user edit\n');
    const forced = await env.revert.restore('s1', r.entry!.id, { overwrite: true });
    expect(forced.ok, forced.message).toBe(true);
    expect(fs.readFileSync(a, 'utf8')).toBe('v2\n');
  });

  it('会话运行中：撤销需确认', async () => {
    const env = setup();
    const a = path.join(env.cwd, 'a.txt');
    write(a, 'v1\n');
    await env.tool('Edit', a, () => write(a, 'v2\n'));
    env.setBusy(true);
    expect((await env.revert.plan('s1', a)).busy).toBe(true);
    const r = await env.revert.revert('s1', a);
    expect(r).toMatchObject({ ok: false, needConfirm: 'busy' });
    expect(fs.readFileSync(a, 'utf8')).toBe('v2\n');
    const forced = await env.revert.revert('s1', a, { force: true });
    expect(forced.ok).toBe(true);
    expect(fs.readFileSync(a, 'utf8')).toBe('v1\n');
  });

  it('不能撤销的情况给出原因且不动文件', async () => {
    const env = setup({ maxBlobBytes: 100 });
    const big = path.join(env.cwd, 'big.txt');
    write(big, 'x'.repeat(200));
    await env.tool('Edit', big, () => write(big, 'y'.repeat(200)));
    expect((await env.revert.plan('s1', big)).blocked).toContain('超过备份上限');

    const old = path.join(env.cwd, 'old.txt');
    write(old, 'keep\n');
    await env.bash(() => fs.appendFileSync(old, 'more lines here\n'));
    expect((await env.revert.plan('s1', old)).blocked).toBe('没有改前内容，不能撤销');

    expect((await env.revert.plan('s1', path.join(env.cwd, 'none.txt'))).blocked).toBe('文件不在本会话改动中');

    const same = path.join(env.cwd, 'same.txt');
    write(same, 's\n');
    await env.tool('Edit', same, () => write(same, 't\n'));
    write(same, 's\n');
    expect((await env.revert.plan('s1', same)).blocked).toBe('文件已是改前内容');

    const r = await env.revert.revert('s1', old);
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(old, 'utf8')).toBe('keep\nmore lines here\n');
  });

  it('只读会话不能撤销', async () => {
    const env = setup({ readOnly: true });
    const a = path.join(env.cwd, 'a.txt');
    write(a, 'v1\n');
    await env.tool('Edit', a, () => write(a, 'v2\n'));
    expect((await env.revert.plan('s1', a)).blocked).toContain('只能查看');
  });

  it('文件超过备份上限：需确认，撤销后不可恢复', async () => {
    const env = setup({ maxBackupBytes: 10 });
    const a = path.join(env.cwd, 'a.txt');
    write(a, 'short\n');
    await env.tool('Edit', a, () => write(a, 'a much longer content line\n'));
    const r = await env.revert.revert('s1', a);
    expect(r).toMatchObject({ ok: false, needConfirm: 'large' });
    const forced = await env.revert.revert('s1', a, { large: true });
    expect(forced.ok).toBe(true);
    expect(forced.entry?.restorable).toBe(false);
    expect(fs.readFileSync(a, 'utf8')).toBe('short\n');
  });
});
