import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'child_process';
import { commandLineOwns, takeoverOrphan, type TakeoverDeps, type TakeoverHost } from '../src/main/orphan-takeover';
import { isPidAlive, readCommandLine } from '../src/main/proc-tree';
import type { RestartResult, ResumeCheck, Session } from '../src/shared/types';

const ID = '3f2a9c1e-0000-4000-8000-000000000001';
const OWN_CMD = `"node.exe" mock.js --settings "C:\\Users\\a b\\.claude-session-panel\\sessions\\${ID}\\settings.json" --resume x`;

function session(over: Partial<Session> = {}): Session {
  return {
    id: ID, label: '孤儿', cwd: 'D:\\work', status: 'running', statusSince: 1, createdAt: 1, escalated: false,
    readOnly: true, claudeSessionId: 'c-1', ...over,
  };
}

const BUSY: ResumeCheck = { resumable: false, reason: 'busy', message: '进程仍在运行', transcript: 'found', canFresh: true, canFork: false };

function setup(opts: {
  s?: Session; pid?: number; alive?: boolean; cmd?: string | null; check?: ResumeCheck; dieOnKill?: boolean;
} = {}) {
  let alive = opts.alive ?? true;
  const s = opts.s ?? session();
  const host = {
    getSession: vi.fn(() => s),
    orphanPid: vi.fn(() => ('pid' in opts ? opts.pid : 4242)),
    checkTakeover: vi.fn(() => opts.check ?? BUSY),
    releaseOrphan: vi.fn(() => true),
    restartSession: vi.fn((): RestartResult => ({ ok: true, mode: 'resume' })),
  } satisfies TakeoverHost;
  const deps: TakeoverDeps = {
    host,
    readCommandLine: vi.fn(async () => ('cmd' in opts ? opts.cmd! : OWN_CMD)),
    isAlive: vi.fn(() => alive),
    killTree: vi.fn(async () => { if (opts.dieOnKill ?? true) alive = false; }),
    exitWaitMs: 200,
  };
  return { host, deps };
}

describe('commandLineOwns', () => {
  it('含本会话的 settings 路径即属于本会话，斜杠方向、大小写与引号不限', () => {
    expect(commandLineOwns(OWN_CMD, ID)).toBe(true);
    expect(commandLineOwns(`claude --settings /home/u/.claude-session-panel/sessions/${ID}/settings.json`, ID)).toBe(true);
    expect(commandLineOwns(OWN_CMD.toUpperCase(), ID)).toBe(true);
  });

  it('别的会话、只是碰巧含 id 或空 id 都不算', () => {
    expect(commandLineOwns(OWN_CMD, '3f2a9c1e-0000-4000-8000-000000000002')).toBe(false);
    expect(commandLineOwns(`notepad.exe ${ID}.txt`, ID)).toBe(false);
    expect(commandLineOwns(OWN_CMD, '')).toBe(false);
  });
});

describe('takeoverOrphan', () => {
  it('确认 pid 属于本会话后结束原进程、解除只读并续接', async () => {
    const { host, deps } = setup();
    const r = await takeoverOrphan(deps, ID);
    expect(r).toEqual({ ok: true, mode: 'resume' });
    expect(deps.readCommandLine).toHaveBeenCalledWith(4242);
    expect(deps.killTree).toHaveBeenCalledWith(4242);
    expect(host.releaseOrphan).toHaveBeenCalledWith(ID);
    expect(host.restartSession).toHaveBeenCalledWith(ID, { mode: 'resume' });
  });

  it('命令行不含本会话的配置路径（pid 被复用）：不结束任何进程', async () => {
    const { host, deps } = setup({ cmd: 'C:\\Windows\\notepad.exe' });
    const r = await takeoverOrphan(deps, ID);
    expect(r).toMatchObject({ ok: false, reason: 'unverified' });
    expect(r.message).toContain('未结束任何进程');
    expect(deps.killTree).not.toHaveBeenCalled();
    expect(host.releaseOrphan).not.toHaveBeenCalled();
    expect(host.restartSession).not.toHaveBeenCalled();
  });

  it('读不到命令行：不结束任何进程', async () => {
    const { deps } = setup({ cmd: null });
    const r = await takeoverOrphan(deps, ID);
    expect(r).toMatchObject({ ok: false, reason: 'unverified' });
    expect(deps.killTree).not.toHaveBeenCalled();
  });

  it('续接条件不满足时先拒绝，不读命令行也不结束原进程', async () => {
    const check: ResumeCheck = { resumable: false, reason: 'no_transcript', message: '找不到这段对话的记录', transcript: 'missing', canFresh: true, canFork: false };
    const { host, deps } = setup({ check });
    const r = await takeoverOrphan(deps, ID);
    expect(r).toMatchObject({ ok: false, reason: 'no_transcript', message: '找不到这段对话的记录，未结束原进程' });
    expect(deps.readCommandLine).not.toHaveBeenCalled();
    expect(deps.killTree).not.toHaveBeenCalled();
    expect(host.restartSession).not.toHaveBeenCalled();
  });

  it('原进程结束不了：不解除只读、不拉起', async () => {
    const { host, deps } = setup({ dieOnKill: false });
    const r = await takeoverOrphan(deps, ID);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('未能结束');
    expect(host.releaseOrphan).not.toHaveBeenCalled();
    expect(host.restartSession).not.toHaveBeenCalled();
  });

  it('原进程已经自行退出：不读命令行、不结束进程，直接续接', async () => {
    const { host, deps } = setup({ alive: false });
    expect((await takeoverOrphan(deps, ID)).ok).toBe(true);
    expect(deps.readCommandLine).not.toHaveBeenCalled();
    expect(deps.killTree).not.toHaveBeenCalled();
    expect(host.restartSession).toHaveBeenCalled();
  });

  it('不是认领会话或会话不存在：拒绝', async () => {
    const a = setup({ s: session({ readOnly: false }) });
    expect((await takeoverOrphan(a.deps, ID)).ok).toBe(false);
    expect(a.deps.killTree).not.toHaveBeenCalled();
    const b = setup();
    b.host.getSession.mockReturnValue(undefined as unknown as Session);
    expect(await takeoverOrphan(b.deps, ID)).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('同一会话正在接管时再次调用被拒，只结束一次进程', async () => {
    const { deps } = setup();
    const [r1, r2] = await Promise.all([takeoverOrphan(deps, ID), takeoverOrphan(deps, ID)]);
    expect([r1.ok, r2.ok].sort()).toEqual([false, true]);
    expect(deps.killTree).toHaveBeenCalledTimes(1);
  });
});

describe('readCommandLine', () => {
  it('读到真实子进程的完整命令行（含参数）', async () => {
    const marker = `sessions/${ID}/settings.json`;
    // -- 之后的参数交给脚本，否则 node 把 --settings 当成自己的选项直接报错退出
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--settings', marker], { stdio: 'ignore', windowsHide: true });
    try {
      const cmd = await readCommandLine(child.pid!);
      expect(cmd).not.toBeNull();
      expect(commandLineOwns(cmd!, ID)).toBe(true);
    } finally {
      child.kill();
    }
  }, 20_000);

  it('不存在的进程与无效 pid 返回 null', async () => {
    expect(await readCommandLine(-1)).toBeNull();
    let pid = 999_999;
    while (isPidAlive(pid)) pid++;
    expect(await readCommandLine(pid)).toBeNull();
  }, 20_000);
});
