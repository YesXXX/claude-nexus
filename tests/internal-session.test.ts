import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionManager } from '../src/main/session-manager';
import { PromptInjector } from '../src/main/prompt-injector';
import { FAILED_REASON, INITIAL_NOT_READY_TEXT, InternalSessions, NOT_READY_TEXT } from '../src/main/internal-session';
import type { PtyFactory, PtyProcess } from '../src/shared/types';

class MockPty implements PtyProcess {
  written: string[] = [];
  private dataCbs: Array<(c: string) => void> = [];
  private exitCbs: Array<(c: number | null) => void> = [];
  readonly pid = 7100;
  constructor(public file: string, public args: string[], public options: { cwd: string; env: Record<string, string> }) {}
  write(d: string): void { this.written.push(d); }
  kill(): void { /* 测试里不需要 */ }
  onData(cb: (c: string) => void): void { this.dataCbs.push(cb); }
  onExit(cb: (c: number | null) => void): void { this.exitCbs.push(cb); }
  emitData(chunk: string): void { this.dataCbs.forEach(cb => cb(chunk)); }
}

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-internal-'));
process.env.CLAUDE_PANEL_HOME = TEST_HOME;

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

function setup(readyTimeoutMs = 5000) {
  const ptys: MockPty[] = [];
  const factory: PtyFactory = {
    spawn: (file, args, options) => {
      const p = new MockPty(file, args, options);
      ptys.push(p);
      return p;
    },
  };
  const manager = new SessionManager({
    ptyFactory: factory, hookClientPath: 'x', mockClaudePath: 'y',
    pendingPrompt: id => internal?.promptState(id),
  });
  const notices: Array<{ id: string; message: string }> = [];
  const counter = { changed: 0 };
  let internal!: InternalSessions;
  const injector = new PromptInjector({
    host: manager, quietMs: 100, settleMs: 0, enterDelayMs: 5,
    onSent: item => internal.onSent(item),
    onDropped: (item, reason) => internal.onDropped(item, reason),
  });
  internal = new InternalSessions({
    manager, injector: () => injector, readyTimeoutMs,
    notice: (id, message) => notices.push({ id, message }),
    changed: () => { counter.changed++; },
  });
  return { manager, injector, internal, ptys, notices, counter };
}

describe('内部会话的初始提示词', () => {
  it('cwd 与标签按传入值创建；提示词在收到 SessionStart 且粘贴模式开启、输出静默后才写入', async () => {
    const env = setup();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-internal-cwd-'));
    const r = env.internal.start('解决冲突：任务一', cwd, '第一行\n第二行', { reason: 'conflict' });
    if ('error' in r) throw new Error(r.error);
    expect(r.label).toBe('解决冲突：任务一');
    expect(r.cwd).toBe(cwd);
    expect(r.worktree).toBeUndefined();
    const pty = env.ptys[0];
    expect(pty.options.cwd).toBe(cwd);
    expect(env.injector.get(r.id)).toMatchObject({ reason: 'conflict', waitFor: 'ready' });

    pty.emitData('\x1b[?2004h欢迎');
    await wait(150);
    expect(pty.written).toEqual([]);
    pty.emitData('提示行');
    await wait(30);
    env.manager.handleHookMessage({ sessionId: r.id, event: { type: 'session_started', source: 'startup' } });
    await wait(10);
    expect(pty.written).toEqual([]);
    await wait(150);
    expect(pty.written[0]).toBe('\x1b[200~第一行\r第二行\x1b[201~');
    expect(pty.written[1]).toBe('\r');
    expect(env.injector.get(r.id)).toBeUndefined();
    expect(env.internal.pendingOf(r.id)).toBeUndefined();
    expect(env.notices).toEqual([]);
  });

  it('就绪超时：提示词保留为待发送并提示，可手动发送', async () => {
    const env = setup(60);
    const r = env.internal.start('解决冲突：x', TEST_HOME, '修冲突', { reason: 'conflict' });
    if ('error' in r) throw new Error(r.error);
    await wait(150);
    expect(env.injector.get(r.id)).toBeUndefined();
    expect(env.internal.pendingOf(r.id)).toBe('conflict');
    expect(env.notices).toEqual([{ id: r.id, message: NOT_READY_TEXT }]);
    expect(env.ptys[0].written).toEqual([]);
    const sent = env.internal.sendPending(r.id, 'now');
    expect(sent.ok).toBe(true);
    expect(env.ptys[0].written[0]).toContain('修冲突');
    expect(env.internal.pendingOf(r.id)).toBeUndefined();
    expect(env.internal.sendPending(r.id, 'now').message).toBe('没有待发送的提示词');
  });

  it('待发送的提示词可放弃；会话被结束时一并丢弃', async () => {
    const env = setup(30);
    const a = env.internal.start('a', TEST_HOME, 'p1');
    const b = env.internal.start('b', TEST_HOME, 'p2');
    if ('error' in a || 'error' in b) throw new Error('create failed');
    await wait(100);
    expect(env.internal.pendingOf(a.id)).toBe('prompt');
    expect(env.internal.discardPending(a.id)).toBe(true);
    expect(env.internal.pendingOf(a.id)).toBeUndefined();
    expect(env.internal.pendingOf(b.id)).toBe('prompt');
    env.manager.killSession(b.id);
    expect(env.internal.pendingOf(b.id)).toBeUndefined();
  });

  it('没有提示词时只创建会话；拉起失败返回可读错误', () => {
    const env = setup();
    const r = env.internal.start('plain', TEST_HOME);
    expect('error' in r).toBe(false);
    expect(env.injector.get((r as { id: string }).id)).toBeUndefined();
    const broken = new InternalSessions({
      manager: {
        createInternal: () => { throw new Error('spawn ENOENT'); },
        addListener: () => () => {},
      },
      injector: () => undefined,
      notice: () => {},
    });
    expect(broken.start('x', TEST_HOME, 'p')).toEqual({ error: '创建会话失败：spawn ENOENT' });
  });
});

describe('新建表单的首条提示词', () => {
  const sessionOf = (env: ReturnType<typeof setup>, id: string) => env.manager.getSessions().find(s => s.id === id);

  it('普通会话排队后合并为待发送状态，就绪后一次粘贴发出并清除状态', async () => {
    const env = setup();
    const s = env.manager.createSession({ label: '用户任务', cwd: TEST_HOME });
    env.internal.deliver(s.id, '  第一行\n第二行  ');
    expect(env.internal.promptState(s.id)).toEqual({ state: 'waiting' });
    expect(sessionOf(env, s.id)?.pendingPrompt).toEqual({ state: 'waiting' });
    expect(env.counter.changed).toBe(1);
    const pty = env.ptys[0];
    pty.emitData('\x1b[?2004h');
    env.manager.handleHookMessage({ sessionId: s.id, event: { type: 'session_started', source: 'startup' } });
    await wait(200);
    expect(pty.written[0]).toBe('\x1b[200~第一行\r第二行\x1b[201~');
    expect(pty.written[1]).toBe('\r');
    expect(env.internal.promptState(s.id)).toBeUndefined();
    expect(sessionOf(env, s.id)?.pendingPrompt).toBeUndefined();
    expect(env.counter.changed).toBe(2);
  });

  it('空提示词什么都不做', () => {
    const env = setup();
    const s = env.manager.createSession({ label: 'x', cwd: TEST_HOME });
    env.internal.deliver(s.id, '   ');
    expect(env.injector.get(s.id)).toBeUndefined();
    expect(env.counter.changed).toBe(0);
  });

  it('就绪超时转为未发送并提示；插入到输入框只粘贴不回车，随后状态清除', async () => {
    const env = setup(60);
    const s = env.manager.createSession({ label: 'y', cwd: TEST_HOME });
    env.internal.deliver(s.id, '多行\n提示词');
    await wait(150);
    expect(env.internal.promptState(s.id)).toEqual({ state: 'failed', reason: FAILED_REASON });
    expect(sessionOf(env, s.id)?.pendingPrompt?.state).toBe('failed');
    expect(env.notices).toEqual([{ id: s.id, message: INITIAL_NOT_READY_TEXT }]);
    const pty = env.ptys[0];
    // 粘贴模式未开启时多行插入被拒绝，状态保留
    expect(env.internal.insertPending(s.id).ok).toBe(false);
    expect(env.internal.promptState(s.id)?.state).toBe('failed');
    pty.emitData('\x1b[?2004h');
    await wait(50);
    expect(env.internal.insertPending(s.id)).toEqual({ ok: true });
    await wait(30);
    expect(pty.written).toEqual(['\x1b[200~多行\r提示词\x1b[201~']);
    expect(env.internal.promptState(s.id)).toBeUndefined();
    expect(env.internal.insertPending(s.id)).toEqual({ ok: false, reason: '没有待发送的提示词' });
  });

  it('等待中的会话被结束：等待状态清除并刷新列表', () => {
    const env = setup();
    const s = env.manager.createSession({ label: 'z', cwd: TEST_HOME });
    env.internal.deliver(s.id, 'p');
    const before = env.counter.changed;
    env.manager.killSession(s.id);
    expect(env.internal.promptState(s.id)).toBeUndefined();
    expect(env.counter.changed).toBeGreaterThan(before);
  });
});
