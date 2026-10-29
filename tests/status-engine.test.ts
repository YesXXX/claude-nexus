import { describe, it, expect } from 'vitest';
import {
  parseHookPayload, transition, compareByAttention, toolInputBrief, COMMAND_TEXT_MAX, busyAfter, maybeBusy, HOOKS_VERSION,
  PROMPT_EVENT_MAX, truncatePrompt,
} from '../src/shared/status-engine';
import { PanelEvent, Session } from '../src/shared/types';

const base: Session = {
  id: 's1', label: '测试任务', cwd: 'D:\\tmp', status: 'running',
  statusSince: 1000, createdAt: 1000, escalated: false,
};
const NOW = 9999;

describe('parseHookPayload', () => {
  it('权限类 Notification 解析出工具名与命令', () => {
    const ev = parseHookPayload({
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf node_modules' },
    });
    expect(ev).toEqual({
      type: 'permission_request', toolName: 'Bash', commandText: 'rm -rf node_modules',
    });
  });

  it('非权限类 Notification 解析为 idle_prompt，带压平后的提示文本', () => {
    const ev = parseHookPayload({ hook_event_name: 'Notification', message: 'Claude is waiting\n for your input' });
    expect(ev).toEqual({ type: 'idle_prompt', message: 'Claude is waiting for your input' });
    expect(parseHookPayload({ hook_event_name: 'Notification' })).toEqual({ type: 'idle_prompt' });
  });

  it('PreToolUse/PostToolUse/Stop 分别映射为对应事件', () => {
    expect(parseHookPayload({ hook_event_name: 'PreToolUse' })).toEqual({ type: 'tool_started' });
    expect(parseHookPayload({ hook_event_name: 'PostToolUse' })).toEqual({ type: 'tool_finished' });
    expect(parseHookPayload({ hook_event_name: 'Stop' })).toEqual({ type: 'turn_completed' });
  });

  it('SessionStart → session_started（source 不认识归 unknown）；UserPromptSubmit → prompt_submitted', () => {
    for (const source of ['startup', 'resume', 'clear', 'compact'] as const) {
      expect(parseHookPayload({ hook_event_name: 'SessionStart', source })).toEqual({ type: 'session_started', source });
    }
    expect(parseHookPayload({ hook_event_name: 'SessionStart', source: 'xx' })).toEqual({ type: 'session_started', source: 'unknown' });
    expect(parseHookPayload({ hook_event_name: 'SessionStart' })).toEqual({ type: 'session_started', source: 'unknown' });
    expect(parseHookPayload({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })).toEqual({ type: 'prompt_submitted', prompt: 'hi' });
    expect(parseHookPayload({ hook_event_name: 'UserPromptSubmit' })).toEqual({ type: 'prompt_submitted' });
    expect(parseHookPayload({ hook_event_name: 'UserPromptSubmit', prompt: '' })).toEqual({ type: 'prompt_submitted' });
  });

  it('提示词正文截断到 2000 个字符，不切断代理对', () => {
    const long = '中'.repeat(2500);
    const ev = parseHookPayload({ hook_event_name: 'UserPromptSubmit', prompt: long });
    expect(ev).toEqual({ type: 'prompt_submitted', prompt: '中'.repeat(PROMPT_EVENT_MAX) });
    const emoji = '🎉'.repeat(1500);
    expect(Array.from(truncatePrompt(emoji))).toHaveLength(1500);
    expect(Array.from(truncatePrompt('🎉'.repeat(2100)))).toHaveLength(2000);
    expect(truncatePrompt('短')).toBe('短');
  });

  it('session_started 不改变会话状态；prompt_submitted 把已完成 / 等待输入推回运行中并置忙碌', () => {
    const s = { ...base, status: 'waiting_input' as const };
    expect(transition(s, { type: 'session_started', source: 'resume' }, NOW)).toBe(s);
    const done = { ...base, status: 'completed' as const, statusSince: 5 };
    const next = transition(done, { type: 'prompt_submitted' }, NOW);
    expect(next.status).toBe('running');
    expect(next.statusSince).toBe(NOW);
    expect(next.busy).toBe(true);
    expect(next.pendingAction).toBeUndefined();
    expect(transition(s, { type: 'prompt_submitted' }, NOW).status).toBe('running');
  });

  it('busy 转换表：提交 / 工具 / 权限置真，回合结束 / 等待输入 / 退出置假，其余不变', () => {
    const table: Array<[PanelEvent, boolean | undefined]> = [
      [{ type: 'prompt_submitted' }, true],
      [{ type: 'tool_started' }, true],
      [{ type: 'tool_finished' }, true],
      [{ type: 'permission_request', toolName: 'Bash', commandText: '' }, true],
      [{ type: 'turn_completed' }, false],
      [{ type: 'idle_prompt' }, false],
      [{ type: 'process_exit', code: 0 }, false],
      [{ type: 'session_started', source: 'startup' }, undefined],
      [{ type: 'subagent_start', raw: {} }, undefined],
    ];
    for (const [ev, want] of table) {
      expect(busyAfter(ev), ev.type).toBe(want);
      if (want === undefined) continue;
      expect(transition({ ...base, busy: !want }, ev, NOW).busy, ev.type).toBe(want);
    }
    // 不改变 busy 的事件保留原值；缺省视为空闲
    expect(transition({ ...base, busy: true }, { type: 'session_started', source: 'clear' }, NOW).busy).toBe(true);
    expect(transition(base, { type: 'tool_started' }, NOW).busy).toBe(true);
  });

  it('maybeBusy：busy 为真或缺少当前版本的 hooks 配置都视为可能正忙', () => {
    expect(maybeBusy({ ...base, hooksVersion: HOOKS_VERSION, busy: false })).toBe(false);
    expect(maybeBusy({ ...base, hooksVersion: HOOKS_VERSION })).toBe(false);
    expect(maybeBusy({ ...base, hooksVersion: HOOKS_VERSION, busy: true })).toBe(true);
    expect(maybeBusy({ ...base, busy: false })).toBe(true);
    expect(maybeBusy({ ...base, hooksVersion: 1, busy: false })).toBe(true);
  });

  it('垃圾输入返回 null', () => {
    expect(parseHookPayload(null)).toBeNull();
    expect(parseHookPayload({})).toBeNull();
    expect(parseHookPayload({ hook_event_name: 'Whatever' })).toBeNull();
  });

  it('PreToolUse 携带工具名与参数摘要', () => {
    expect(parseHookPayload({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm  test\n--watch' } }))
      .toEqual({ type: 'tool_started', toolName: 'Bash', commandText: 'npm test --watch' });
    expect(parseHookPayload({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'D:\\a.ts', content: 'x' } }))
      .toEqual({ type: 'tool_started', toolName: 'Write', commandText: 'D:\\a.ts' });
    expect(parseHookPayload({ hook_event_name: 'PreToolUse', tool_name: 'Foo' }))
      .toEqual({ type: 'tool_started', toolName: 'Foo', commandText: '' });
  });

  it('权限提示文本可抠出 mcp 工具名', () => {
    expect(parseHookPayload({ hook_event_name: 'Notification', message: 'Claude needs your permission to use mcp__git__commit' }))
      .toEqual({ type: 'permission_request', toolName: 'mcp__git__commit', commandText: '' });
  });
});

describe('toolInputBrief', () => {
  it('按 command → file_path → path → url → pattern → description 取先命中的非空值', () => {
    expect(toolInputBrief(undefined)).toBe('');
    expect(toolInputBrief({ command: '  ', file_path: 'a.ts' })).toBe('a.ts');
    expect(toolInputBrief({ url: 'https://x', description: 'd' })).toBe('https://x');
    expect(toolInputBrief({ pattern: '**/*.ts' })).toBe('**/*.ts');
    expect(toolInputBrief({ content: 'x', count: 3 })).toBe('');
  });

  it('超长截断到 COMMAND_TEXT_MAX 并补省略号', () => {
    const out = toolInputBrief({ command: 'a'.repeat(COMMAND_TEXT_MAX + 50) });
    expect(out).toBe('a'.repeat(COMMAND_TEXT_MAX) + '…');
  });
});

describe('transition', () => {
  it('权限请求 → waiting_permission，记录 pendingAction', () => {
    const s = transition(base, { type: 'permission_request', toolName: 'Bash', commandText: 'npm i' }, NOW);
    expect(s.status).toBe('waiting_permission');
    expect(s.pendingAction).toEqual({ toolName: 'Bash', commandText: 'npm i' });
    expect(s.statusSince).toBe(NOW);
  });

  it('权限批准后工具开跑 → running，pendingAction 清除', () => {
    const waiting = { ...base, status: 'waiting_permission' as const,
      pendingAction: { toolName: 'Bash', commandText: 'npm i' } };
    const s = transition(waiting, { type: 'tool_started' }, NOW);
    expect(s.status).toBe('running');
    expect(s.pendingAction).toBeUndefined();
  });

  it('空闲提醒 → waiting_input；Stop → completed', () => {
    expect(transition(base, { type: 'idle_prompt' }, NOW).status).toBe('waiting_input');
    expect(transition(base, { type: 'turn_completed' }, NOW).status).toBe('completed');
  });

  it('进程退出：码 0 → completed；非 0 → error；码未知 → disconnected', () => {
    expect(transition(base, { type: 'process_exit', code: 0 }, NOW))
      .toMatchObject({ status: 'completed', exitCode: 0 });
    expect(transition(base, { type: 'process_exit', code: 1 }, NOW))
      .toMatchObject({ status: 'error', exitCode: 1 });
    expect(transition(base, { type: 'process_exit', code: null }, NOW))
      .toMatchObject({ status: 'disconnected', exitCode: null });
  });

  it('状态未变时 statusSince 不更新（返回新对象但时间戳保留）', () => {
    const running = { ...base, status: 'running' as const };
    const s = transition(running, { type: 'tool_finished' }, NOW);
    expect(s.statusSince).toBe(1000);
  });
});

describe('compareByAttention 注意力排序', () => {
  const mk = (status: Session['status'], statusSince: number): Session =>
    ({ ...base, status, statusSince });

  it('等待权限 > 等待输入 > 运行中 > 已完成', () => {
    const list = [mk('running', 1), mk('completed', 1), mk('waiting_permission', 1), mk('waiting_input', 1)];
    list.sort(compareByAttention);
    expect(list.map(s => s.status)).toEqual(
      ['waiting_permission', 'waiting_input', 'running', 'completed']);
  });

  it('同状态按进入时间早者优先', () => {
    const a = mk('waiting_permission', 2000);
    const b = mk('waiting_permission', 1000);
    expect([a, b].sort(compareByAttention)[0].statusSince).toBe(1000);
  });
});

describe('边界与回归', () => {
  it('parseHookPayload: tool_name 与 tool_input.command 都缺省时 fallback 字符串', () => {
    const ev = parseHookPayload({
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    expect(ev).toEqual({ type: 'permission_request', toolName: 'Bash', commandText: '' });
  });

  it('transition: escalated 状态被清零（状态变化时）', () => {
    const escalated = { ...base, status: 'waiting_permission' as const, escalated: true,
      pendingAction: { toolName: 'Bash', commandText: 'npm i' } };
    const s = transition(escalated, { type: 'tool_started' }, NOW);
    expect(s.status).toBe('running');
    expect(s.escalated).toBe(false);
  });

  it('compareByAttention: error/disconnected 同优先级时按时间排', () => {
    const list = [
      { ...base, status: 'running' as const, statusSince: 1 },
      { ...base, status: 'error' as const, statusSince: 100 },
      { ...base, status: 'disconnected' as const, statusSince: 50 },
    ];
    list.sort(compareByAttention);
    expect(list.map(s => s.status)).toEqual(['disconnected', 'error', 'running']);
  });
});

describe('待续接状态', () => {
  const sus: Session = { ...base, status: 'suspended', statusSince: 1 };

  it('排在已完成之后', () => {
    const list = [sus, { ...base, status: 'completed' as const }, { ...base, status: 'running' as const }];
    list.sort(compareByAttention);
    expect(list.map(s => s.status)).toEqual(['running', 'completed', 'suspended']);
  });

  it('没有进程，任何 hook 事件都不改变状态', () => {
    for (const ev of [
      { type: 'turn_completed' }, { type: 'permission_request', toolName: 'Bash' }, { type: 'process_exit', code: 1 },
      { type: 'tool_started' }, { type: 'idle_prompt' },
    ] as Parameters<typeof transition>[1][]) {
      expect(transition(sus, ev, NOW)).toBe(sus);
    }
  });
});
