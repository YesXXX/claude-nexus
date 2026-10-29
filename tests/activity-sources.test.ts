import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createActivitySources, LAUNCH_ECHO_MS, durationText, type ActivitySink } from '../src/main/activity-sources';
import { ActivityLog } from '../src/main/activity-log';
import { SessionManager } from '../src/main/session-manager';
import { SubagentTracker } from '../src/main/subagent-tracker';
import { parseHookPayload } from '../src/shared/status-engine';
import type { ActivityEvent, ActivityInput } from '../src/shared/activity';
import type { PanelEvent, PtyFactory, Session, SubagentEntry } from '../src/shared/types';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-activity-src-'));
process.env.CLAUDE_PANEL_HOME = TEST_HOME;
process.env.CLAUDE_PANEL_MOCK_CLAUDE = '1';

class FakeSink implements ActivitySink {
  reports: ActivityInput[] = [];
  tools: Array<{ sessionId: string; toolName?: string; summary?: string }> = [];
  report(input: ActivityInput): ActivityEvent | null {
    this.reports.push(input);
    return null;
  }
  recordTool(sessionId: string, toolName: string | undefined, summary?: string): ActivityEvent | null {
    this.tools.push({ sessionId, toolName, summary });
    return null;
  }
  closeToolBatch(): void { /* 映射测试不关心 */ }
}

function session(id = 's1', extra: Partial<Session> = {}): Session {
  return { id, label: 'L', cwd: 'D:\\w', status: 'running', statusSince: 1, createdAt: 1, escalated: false, ...extra };
}

function setup(quitting = false) {
  let clock = 1_000_000;
  const sink = new FakeSink();
  const src = createActivitySources(sink, { now: () => clock, isQuitting: () => quitting });
  return { sink, src, tick: (ms: number) => { clock += ms; } };
}

describe('活动来源映射', () => {
  it('生命周期：新建、重启、认领、结束分别映射，独立工作区带分支详情', () => {
    const { sink, src } = setup();
    src.onLifecycle('created', session('a', { worktree: { branch: 'wt/x' } as Session['worktree'] }));
    src.onLifecycle('restarted', session('a'));
    src.onLifecycle('adopted', session('b'));
    src.onLifecycle('killed', session('a'));
    expect(sink.reports.map(r => [r.type, r.sessionId, r.detail])).toEqual([
      ['session.start', 'a', '独立工作区 wt/x'],
      ['session.restart', 'a', undefined],
      ['session.adopt', 'b', undefined],
      ['session.end', 'a', '在面板中结束'],
    ]);
  });

  it('上下文重置：启动回报在 5 秒内不重复记，/clear 与 compact 照记，超时后的 startup 也记', () => {
    const { sink, src, tick } = setup();
    src.onLifecycle('created', session());
    src.onEvent('s1', { type: 'session_started', source: 'startup' });
    src.onEvent('s1', { type: 'session_started', source: 'clear' });
    src.onEvent('s1', { type: 'session_started', source: 'compact' });
    tick(LAUNCH_ECHO_MS + 1);
    src.onEvent('s1', { type: 'session_started', source: 'unknown' });
    const resets = sink.reports.filter(r => r.type === 'session.reset').map(r => (r.data as { source: string }).source);
    expect(resets).toEqual(['clear', 'compact', 'startup']);
  });

  it('重启续接时的 resume 回报不重复记', () => {
    const { sink, src } = setup();
    src.onLifecycle('restarted', session());
    src.onEvent('s1', { type: 'session_started', source: 'resume' });
    expect(sink.reports.filter(r => r.type === 'session.reset')).toHaveLength(0);
  });

  it('回合：发出指令带打码摘要，工具调用交给合并，本轮结束带工具数与用时', () => {
    const { sink, src, tick } = setup();
    src.onEvent('s1', { type: 'prompt_submitted', prompt: `修复登录 token=abc123secret\n${'x'.repeat(300)}` });
    src.onEvent('s1', { type: 'tool_started', toolName: 'Edit', commandText: 'src/a.ts' });
    src.onEvent('s1', { type: 'tool_started', toolName: 'Bash', commandText: 'npm test' });
    src.onEvent('s1', { type: 'tool_finished' });
    tick(75_000);
    src.onEvent('s1', { type: 'turn_completed' });
    const start = sink.reports[0];
    expect(start.type).toBe('turn.start');
    expect(start.detail!.length).toBeLessThanOrEqual(120);
    expect(start.detail).not.toContain('abc123secret');
    expect(start.detail).not.toContain('\n');
    expect(sink.tools).toEqual([
      { sessionId: 's1', toolName: 'Edit', summary: 'src/a.ts' },
      { sessionId: 's1', toolName: 'Bash', summary: 'npm test' },
    ]);
    expect(sink.reports[1]).toMatchObject({ type: 'turn.end', detail: '调用 2 次工具 · 用时 1 分' });
  });

  it('等待：批准带工具与摘要，输入等待单独一类', () => {
    const { sink, src } = setup();
    src.onEvent('s1', { type: 'permission_request', toolName: 'Bash', commandText: 'rm -rf dist' });
    src.onEvent('s1', { type: 'idle_prompt' });
    expect(sink.reports[0]).toMatchObject({
      type: 'wait.permission', detail: 'Bash：rm -rf dist', data: { toolName: 'Bash', summary: 'rm -rf dist' },
    });
    expect(sink.reports[1].type).toBe('wait.input');
  });

  it('AskUserQuestion 的等待批准摘要取第一个问题文本', () => {
    const { sink, src } = setup();
    const ev = parseHookPayload({
      hook_event_name: 'Notification', message: 'Claude needs your permission to use AskUserQuestion',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '要用哪种\n数据库？', options: [] }, { question: '第二个' }] },
    })!;
    src.onEvent('s1', ev);
    expect(sink.reports[0]).toMatchObject({ type: 'wait.permission', detail: 'AskUserQuestion：要用哪种 数据库？' });
  });

  it('进程退出：0 / 非 0 / null 分别为结束、出错、失联；退出中不记', () => {
    const { sink, src } = setup();
    const exits: PanelEvent[] = [{ type: 'process_exit', code: 0 }, { type: 'process_exit', code: 3 }, { type: 'process_exit', code: null }];
    for (const e of exits) src.onEvent('s1', e);
    expect(sink.reports.map(r => [r.type, r.detail])).toEqual([
      ['session.end', '退出码 0'], ['session.error', '退出码 3'], ['session.lost', '进程已不在'],
    ]);
    const q = setup(true);
    q.src.onEvent('s1', { type: 'process_exit', code: 1 });
    expect(q.sink.reports).toHaveLength(0);
  });

  it('子代理三阶段：带 agentId 与类型说明；退出中的中止不记', () => {
    const { sink, src } = setup();
    const entry = { agentId: 'ag1', agentType: 'Explore', description: '调研结构', status: 'running' } as SubagentEntry;
    src.onSubagent('s1', entry, 'start');
    src.onSubagent('s1', entry, 'stop');
    src.onSubagent('s1', entry, 'abort');
    expect(sink.reports.map(r => [r.type, r.agentId, r.detail, r.source])).toEqual([
      ['subagent.start', 'ag1', 'Explore · 调研结构', 'subagent'],
      ['subagent.stop', 'ag1', 'Explore · 调研结构', 'subagent'],
      ['subagent.abort', 'ag1', 'Explore · 调研结构', 'subagent'],
    ]);
    expect(sink.reports[0].data).toEqual({ agentType: 'Explore', description: '调研结构' });
    const q = setup(true);
    q.src.onSubagent('s1', entry, 'abort');
    expect(q.sink.reports).toHaveLength(0);
  });

  it('不产生活动的事件被忽略', () => {
    const { sink, src } = setup();
    src.onEvent('s1', { type: 'tool_finished' });
    src.onEvent('s1', { type: 'subagent_start', raw: {} } as PanelEvent);
    expect(sink.reports).toHaveLength(0);
  });

  it('durationText', () => {
    expect(durationText(4_400)).toBe('4 秒');
    expect(durationText(90_000)).toBe('2 分');
    expect(durationText(2 * 3600_000 + 5 * 60_000)).toBe('2 小时 5 分');
  });
});

class TracePty {
  private exitCbs: Array<(c: number | null) => void> = [];
  pid = Math.floor(100000 + Math.random() * 800000);
  write(): void { /* 不关心输入 */ }
  resize(): void { /* 不关心尺寸 */ }
  kill(): void { /* 退出由测试手动触发 */ }
  onData(): void { /* 不产生输出 */ }
  onExit(cb: (c: number | null) => void): void { this.exitCbs.push(cb); }
  emitExit(code: number | null): void { this.exitCbs.forEach(cb => cb(code)); }
}

describe('活动来源接入真 SessionManager（假 PTY）', () => {
  it('创建 → 指令 → 工具 → 等待批准 → 回合结束 → 进程退出，时间线顺序与合并符合预期', () => {
    const ptys: TracePty[] = [];
    const ptyFactory: PtyFactory = { spawn: () => { const p = new TracePty(); ptys.push(p); return p; } };
    let manager: SessionManager | undefined;
    const log = new ActivityLog({
      describeSession: id => {
        const s = manager?.getSession(id);
        return s ? { label: s.label, cwd: s.cwd, alive: manager!.isProcessAlive(id) } : undefined;
      },
    });
    const src = createActivitySources(log);
    const tracker = new SubagentTracker({ onLifecycle: (id, e, p) => src.onSubagent(id, e, p) });
    manager = new SessionManager({
      ptyFactory,
      hookClientPath: path.resolve(__dirname, '..', 'scripts', 'hook-client.js'),
      mockClaudePath: path.resolve(__dirname, '..', 'scripts', 'mock-claude.js'),
      nodePath: process.execPath,
      subagentTracker: tracker,
    });
    manager.addListener({ onEvent: (id, e) => src.onEvent(id, e), onLifecycle: (k, s) => src.onLifecycle(k, s) });

    const s = manager.createSession({ label: '活动接入', cwd: TEST_HOME });
    const hook = (raw: Record<string, unknown>): void => {
      const event = parseHookPayload(raw);
      if (event) manager!.handleHookMessage({ sessionId: s.id, event });
    };
    hook({ hook_event_name: 'SessionStart', source: 'startup' });
    hook({ hook_event_name: 'UserPromptSubmit', prompt: '整理目录' });
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.ts' } });
    hook({ hook_event_name: 'PostToolUse' });
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    hook({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', tool_name: 'Bash', tool_input: { command: 'rm x' } });
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm x' } });
    hook({ hook_event_name: 'Stop' });
    ptys[0].emitExit(0);

    const events = log.query().events.reverse();
    expect(events.map(e => e.type)).toEqual([
      'session.start', 'turn.start', 'tool.batch', 'wait.permission', 'tool.batch', 'turn.end', 'session.end',
    ]);
    expect(events[0]).toMatchObject({ sessionLabel: '活动接入', cwdTail: path.basename(TEST_HOME) });
    expect(events[2]).toMatchObject({ title: '调用 2 次工具', detail: 'Read×1 Bash×1' });
    expect(events[3].detail).toBe('Bash：rm x');
    expect(events[5].detail).toMatch(/^调用 3 次工具 · 用时/);
    expect(events[6]).toMatchObject({ level: 'info', detail: '退出码 0' });
    expect(log.sessions()).toEqual([{ id: s.id, label: '活动接入', alive: false }]);
    log.dispose();
  });
});
