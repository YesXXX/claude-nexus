import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VerifyRunner, type VerifyRunnerDeps } from '../src/main/verify-runner';
import type { VerifyChild } from '../src/main/verify-exec';
import type { Session } from '../src/shared/types';
import type { VerifyConfig, VerifyGlobal } from '../src/shared/verify-types';

/** 假的验证进程：测试里手动推输出、手动结束 */
class FakeChild implements VerifyChild {
  private dataCbs: Array<(c: Buffer) => void> = [];
  private exitCbs: Array<(code: number | null, error?: string) => void> = [];
  exited = false;
  constructor(readonly pid: number, readonly command: string, readonly cwd: string) {}
  onData(cb: (c: Buffer) => void): void { this.dataCbs.push(cb); }
  onExit(cb: (code: number | null, error?: string) => void): void { this.exitCbs.push(cb); }
  emit(s: string | Buffer): void { const b = typeof s === 'string' ? Buffer.from(s) : s; for (const cb of this.dataCbs) cb(b); }
  exit(code: number | null, error?: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitCbs) cb(code, error);
  }
}

function tmpDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-vrun-')));
}

function session(id: string, cwd: string, status: Session['status'] = 'completed'): Session {
  return { id, label: id, cwd, status, statusSince: 0, createdAt: 0, escalated: false };
}

interface Harness {
  runner: VerifyRunner;
  sessions: Map<string, Session>;
  configs: Map<string, VerifyConfig | null>;
  children: FakeChild[];
  killed: number[];
  killedSync: number[];
  finished: Array<{ id: string; status: string }>;
  global: VerifyGlobal;
  fp: { value: string | null };
  logDir: string;
}

function harness(over: Partial<VerifyRunnerDeps> = {}): Harness {
  const sessions = new Map<string, Session>();
  const configs = new Map<string, VerifyConfig | null>();
  const children: FakeChild[] = [];
  const killed: number[] = [];
  const killedSync: number[] = [];
  const finished: Array<{ id: string; status: string }> = [];
  const global: VerifyGlobal = { maxConcurrent: 2, notifyOnFail: true };
  const fp = { value: null as string | null };
  const logDir = path.join(tmpDir(), 'logs');
  let pid = 1000;
  const runner = new VerifyRunner({
    getSession: id => sessions.get(id),
    resolveConfig: async id => (sessions.has(id) ? { key: id, config: configs.get(id) ?? null } : null),
    global: () => global,
    fingerprint: async () => fp.value,
    spawn: (command, { cwd }) => { const c = new FakeChild(++pid, command, cwd); children.push(c); return c; },
    killTree: async p => {
      killed.push(p);
      const c = children.find(x => x.pid === p);
      setTimeout(() => c?.exit(null), 0);
    },
    killTreeSync: p => { killedSync.push(p); },
    logDir,
    onSummary: () => undefined,
    onFinished: (id, s) => finished.push({ id, status: s.status }),
    startDelayMs: 1500,
    ...over,
  });
  return { runner, sessions, configs, children, killed, killedSync, finished, global, fp, logDir };
}

const cfg = (over: Partial<VerifyConfig> = {}): VerifyConfig =>
  ({ command: 'npm test', enabled: true, timeoutSec: 60, skipUnchanged: true, ...over });

function add(h: Harness, id: string, cwd = `C:/w/${id}`, config: VerifyConfig | null = cfg()): void {
  h.sessions.set(id, session(id, cwd));
  h.configs.set(id, config);
}

const tick = (ms: number): Promise<void> => vi.advanceTimersByTimeAsync(ms).then(() => undefined);

describe('VerifyRunner', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('一轮结束后延迟启动，通过后写摘要与详情', async () => {
    const h = harness();
    add(h, 's1');
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1000);
    expect(h.children).toHaveLength(0);
    await tick(600);
    expect(h.children).toHaveLength(1);
    expect(h.runner.getSummary('s1')?.status).toBe('running');
    h.children[0].emit('all good\n');
    h.children[0].exit(0);
    const s = h.runner.getSummary('s1')!;
    expect(s.status).toBe('passed');
    expect(s.exitCode).toBe(0);
    expect(h.runner.getDetail('s1')?.output).toBe('all good\n');
    expect(h.finished).toEqual([{ id: 's1', status: 'passed' }]);
  });

  it('非 0 退出为失败；未启用或未配置时不运行', async () => {
    const h = harness();
    add(h, 'a');
    add(h, 'b', 'C:/w/b', cfg({ enabled: false }));
    add(h, 'c', 'C:/w/c', null);
    for (const id of ['a', 'b', 'c']) h.runner.onEvent(id, { type: 'turn_completed' });
    await tick(1600);
    expect(h.children).toHaveLength(1);
    h.children[0].exit(3);
    expect(h.runner.getSummary('a')).toMatchObject({ status: 'failed', exitCode: 3 });
    expect(h.runner.getSummary('b')).toBeUndefined();
  });

  it('延迟期间开始新一轮则作废，不运行', async () => {
    const h = harness();
    add(h, 's1');
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(500);
    h.runner.onEvent('s1', { type: 'prompt_submitted' });
    await tick(3000);
    expect(h.children).toHaveLength(0);
  });

  it('延迟结束时会话不在空闲状态则不运行', async () => {
    const h = harness();
    add(h, 's1');
    h.runner.onEvent('s1', { type: 'turn_completed' });
    h.sessions.get('s1')!.status = 'running';
    await tick(2000);
    expect(h.children).toHaveLength(0);
  });

  it('运行中开始新一轮：结束进程树，结果为已取消', async () => {
    const h = harness();
    add(h, 's1');
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1600);
    const child = h.children[0];
    h.runner.onEvent('s1', { type: 'tool_started' });
    expect(h.killed).toEqual([child.pid]);
    expect(h.runner.getSummary('s1')).toMatchObject({ status: 'cancelled', message: 'Claude 开始了新一轮' });
    await tick(10);
    expect(h.runner.getSummary('s1')?.status).toBe('cancelled');
    expect(h.finished).toEqual([]);
    expect(h.runner.stats()).toEqual({ running: 0, queued: 0 });
  });

  it('同一会话新的一次取代旧的，旧结果被丢弃', async () => {
    const h = harness();
    add(h, 's1');
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1600);
    const first = h.children[0];
    h.runner.onEvent('s1', { type: 'turn_completed' });
    expect(h.killed).toEqual([first.pid]);
    await tick(1600);
    expect(h.children).toHaveLength(2);
    h.children[1].exit(0);
    expect(h.runner.getSummary('s1')?.status).toBe('passed');
    expect(h.finished).toEqual([{ id: 's1', status: 'passed' }]);
  });

  it('全局并发上限：超出的排队并给出排队位置，空出名额后启动', async () => {
    const h = harness();
    h.global.maxConcurrent = 1;
    add(h, 'a'); add(h, 'b'); add(h, 'c');
    for (const id of ['a', 'b', 'c']) h.runner.onEvent(id, { type: 'turn_completed' });
    await tick(1600);
    expect(h.children).toHaveLength(1);
    expect(h.runner.getSummary('b')).toMatchObject({ status: 'queued', queuePosition: 0 });
    expect(h.runner.getSummary('c')).toMatchObject({ status: 'queued', queuePosition: 1 });
    h.children[0].exit(0);
    expect(h.children).toHaveLength(2);
    expect(h.runner.getSummary('b')?.status).toBe('running');
    expect(h.runner.getSummary('c')).toMatchObject({ status: 'queued', queuePosition: 0 });
    h.runner.onEvent('c', { type: 'prompt_submitted' });
    expect(h.runner.getSummary('c')?.status).toBe('cancelled');
    expect(h.runner.stats()).toEqual({ running: 1, queued: 0 });
  });

  it('提高并发上限后 kick 立即启动排队的验证', async () => {
    const h = harness();
    h.global.maxConcurrent = 1;
    add(h, 'a'); add(h, 'b');
    h.runner.onEvent('a', { type: 'turn_completed' });
    h.runner.onEvent('b', { type: 'turn_completed' });
    await tick(1600);
    expect(h.children).toHaveLength(1);
    h.global.maxConcurrent = 2;
    h.runner.kick();
    expect(h.children).toHaveLength(2);
  });

  it('同一目录同一时刻只跑一个', async () => {
    const h = harness();
    add(h, 'a', 'C:/w/same');
    add(h, 'b', 'C:/W/same');
    h.runner.onEvent('a', { type: 'turn_completed' });
    h.runner.onEvent('b', { type: 'turn_completed' });
    await tick(1600);
    if (process.platform === 'win32') {
      expect(h.children).toHaveLength(1);
      h.children[0].exit(0);
      expect(h.children).toHaveLength(2);
    } else {
      expect(h.children).toHaveLength(2);
    }
  });

  it('工作区指纹不变时沿用上次结果；手动运行不跳过', async () => {
    const h = harness();
    add(h, 's1');
    h.fp.value = 'fp1';
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1600);
    h.children[0].exit(1);
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1600);
    expect(h.children).toHaveLength(1);
    expect(h.runner.getSummary('s1')).toMatchObject({ status: 'failed', reused: true });
    h.fp.value = 'fp2';
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1600);
    expect(h.children).toHaveLength(2);
    h.children[1].exit(0);
    h.fp.value = 'fp2';
    expect(await h.runner.run('s1')).toEqual({ ok: true });
    await tick(1);
    expect(h.children).toHaveLength(3);
  });

  it('关闭跳过或命令变化时即使指纹相同也重跑', async () => {
    const h = harness();
    add(h, 's1');
    h.fp.value = 'same';
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1600);
    h.children[0].exit(0);
    h.configs.set('s1', cfg({ command: 'npm run lint' }));
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1600);
    expect(h.children).toHaveLength(2);
    expect(h.children[1].command).toBe('npm run lint');
  });

  it('超时结束进程树，结果为超时', async () => {
    const h = harness();
    add(h, 's1', 'C:/w/s1', cfg({ timeoutSec: 10 }));
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1600);
    await tick(10000);
    expect(h.killed).toEqual([h.children[0].pid]);
    await tick(10);
    expect(h.runner.getSummary('s1')).toMatchObject({ status: 'timeout', message: '验证超时（10 秒）' });
    expect(h.finished).toEqual([{ id: 's1', status: 'timeout' }]);
  });
});

describe('VerifyRunner 准备命令、结束与手动操作', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('准备命令每个会话只执行一次，输出在同一份详情里', async () => {
    const h = harness();
    add(h, 's1', 'C:/w/s1', cfg({ setupCommand: 'npm ci', skipUnchanged: false }));
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1600);
    expect(h.children[0].command).toBe('npm ci');
    expect(h.runner.getSummary('s1')).toMatchObject({ status: 'running', setup: true });
    h.children[0].emit('installed\r\n');
    h.children[0].exit(0);
    expect(h.children[1].command).toBe('npm test');
    h.children[1].emit('ok');
    h.children[1].exit(0);
    expect(h.runner.getDetail('s1')?.output).toBe('$ npm ci\r\ninstalled\r\n\r\n$ npm test\r\nok');
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1600);
    expect(h.children[2].command).toBe('npm test');
  });

  it('准备命令失败时结果为错误，下次仍会重试准备命令', async () => {
    const h = harness();
    add(h, 's1', 'C:/w/s1', cfg({ setupCommand: 'npm ci', skipUnchanged: false }));
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1600);
    h.children[0].exit(1);
    expect(h.runner.getSummary('s1')).toMatchObject({ status: 'error', message: '准备命令失败（退出码 1）' });
    expect(h.children).toHaveLength(1);
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1600);
    expect(h.children[1].command).toBe('npm ci');
  });

  it('命令无法启动时结果为错误', async () => {
    const h = harness({ spawn: () => { throw new Error('ENOENT'); } });
    add(h, 's1');
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1600);
    expect(h.runner.getSummary('s1')).toMatchObject({ status: 'error', message: '命令无法启动：ENOENT' });
    expect(h.runner.stats().running).toBe(0);
  });

  it('会话被结束：取消运行中的验证并丢掉状态', async () => {
    const h = harness();
    add(h, 's1');
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1600);
    h.sessions.delete('s1');
    h.runner.onDetach('s1', 'killed');
    expect(h.killed).toEqual([h.children[0].pid]);
    await tick(10);
    expect(h.runner.getSummary('s1')).toBeUndefined();
    expect(h.runner.stats()).toEqual({ running: 0, queued: 0 });
  });

  it('进程退出事件取消验证', async () => {
    const h = harness();
    add(h, 's1');
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(1600);
    h.runner.onEvent('s1', { type: 'process_exit', code: 0 });
    expect(h.runner.getSummary('s1')).toMatchObject({ status: 'cancelled', message: '会话进程已退出' });
  });

  it('手动运行：忙碌或未配置时拒绝；手动取消', async () => {
    const h = harness();
    add(h, 's1');
    add(h, 's2', 'C:/w/s2', null);
    h.sessions.get('s1')!.status = 'running';
    expect(await h.runner.run('s1')).toEqual({ ok: false, reason: 'Claude 正忙，等这一轮结束再运行' });
    expect(await h.runner.run('s2')).toEqual({ ok: false, reason: '此仓库未配置验证命令' });
    expect(await h.runner.run('nope')).toEqual({ ok: false, reason: '会话不存在' });
    h.sessions.get('s1')!.status = 'waiting_input';
    h.configs.set('s1', cfg({ enabled: false }));
    expect(await h.runner.run('s1')).toEqual({ ok: true });
    await tick(1);
    expect(h.children).toHaveLength(1);
    expect(h.runner.cancelManual('s1')).toBe(true);
    expect(h.runner.getSummary('s1')).toMatchObject({ status: 'cancelled', message: '已手动取消' });
    expect(h.runner.cancelManual('s2')).toBe(false);
  });

  it('只读会话不验证', async () => {
    const h = harness();
    add(h, 's1');
    h.sessions.get('s1')!.readOnly = true;
    h.runner.onEvent('s1', { type: 'turn_completed' });
    await tick(2000);
    expect(h.children).toHaveLength(0);
  });

  it('disposeAll 同步结束全部进程树，之后不再接受新的验证', async () => {
    const h = harness();
    add(h, 'a'); add(h, 'b'); add(h, 'c');
    h.runner.onEvent('a', { type: 'turn_completed' });
    h.runner.onEvent('b', { type: 'turn_completed' });
    await tick(1600);
    h.runner.onEvent('c', { type: 'turn_completed' });
    expect(h.runner.disposeAll()).toBe(2);
    expect(h.killedSync.sort()).toEqual(h.children.map(c => c.pid).sort());
    await tick(3000);
    expect(h.children).toHaveLength(2);
    h.runner.onEvent('a', { type: 'turn_completed' });
    await tick(3000);
    expect(h.children).toHaveLength(2);
  });

  it('pruneLogs 清理临时文件与过期日志', () => {
    const h = harness({ now: () => 10 * 24 * 3600 * 1000 + Date.now() });
    fs.mkdirSync(h.logDir, { recursive: true });
    fs.writeFileSync(path.join(h.logDir, 'x-1.part'), '');
    fs.writeFileSync(path.join(h.logDir, 'old.log'), '');
    fs.writeFileSync(path.join(h.logDir, 'keep.txt'), '');
    expect(h.runner.pruneLogs()).toBe(2);
    expect(fs.readdirSync(h.logDir)).toEqual(['keep.txt']);
  });
});

describe('VerifyRunner 真实子进程', () => {
  function realHarness(cwd: string, command: string): { runner: VerifyRunner; done: Promise<string> } {
    let resolveDone: (s: string) => void = () => undefined;
    const done = new Promise<string>(r => { resolveDone = r; });
    const sessions = new Map([['r1', session('r1', cwd)]]);
    const runner = new VerifyRunner({
      getSession: id => sessions.get(id),
      resolveConfig: async () => ({ key: 'k', config: cfg({ command, timeoutSec: 30 }) }),
      global: () => ({ maxConcurrent: 2, notifyOnFail: false }),
      logDir: path.join(cwd, 'logs'),
      onSummary: () => undefined,
      onFinished: (_id, s) => resolveDone(s.status),
      startDelayMs: 0,
    });
    return { runner, done };
  }

  const node = JSON.stringify(process.execPath);

  it('退出码 0 为通过，非 0 为失败，日志落盘', async () => {
    const cwd = tmpDir();
    const ok = realHarness(cwd, `${node} -e "console.log('verify-ok')"`);
    ok.runner.onEvent('r1', { type: 'turn_completed' });
    expect(await ok.done).toBe('passed');
    const d = ok.runner.getDetail('r1')!;
    expect(d.output).toContain('verify-ok');
    expect(fs.readFileSync(d.logFile!, 'utf8')).toContain('verify-ok');
    const bad = realHarness(cwd, `${node} -e "process.exit(3)"`);
    bad.runner.onEvent('r1', { type: 'turn_completed' });
    expect(await bad.done).toBe('failed');
    expect(bad.runner.getSummary('r1')?.exitCode).toBe(3);
  }, 30000);

  it('GBK 输出被正确解码', async () => {
    const cwd = tmpDir();
    const r = realHarness(cwd, `${node} -e "process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]))"`);
    r.runner.onEvent('r1', { type: 'turn_completed' });
    expect(await r.done).toBe('passed');
    expect(r.runner.getDetail('r1')).toMatchObject({ output: '中文', encoding: 'gbk' });
  }, 30000);

  it('取消时结束真实进程树', async () => {
    const cwd = tmpDir();
    const r = realHarness(cwd, `${node} -e "setInterval(() => {}, 1000)"`);
    r.runner.onEvent('r1', { type: 'turn_completed' });
    const wait = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms));
    let end = Date.now() + 10000;
    while (r.runner.getSummary('r1')?.status !== 'running' && Date.now() < end) await wait(50);
    expect(r.runner.getSummary('r1')?.status).toBe('running');
    r.runner.onEvent('r1', { type: 'prompt_submitted' });
    end = Date.now() + 10000;
    while (r.runner.stats().running > 0 && Date.now() < end) await wait(50);
    expect(r.runner.stats().running).toBe(0);
    expect(r.runner.getSummary('r1')?.status).toBe('cancelled');
  }, 30000);
});
