import { PanelEvent, RawHookPayload, Session, SessionStartSource, SessionStatus } from './types';

export const COMMAND_TEXT_MAX = 200;

/** 原始 hook payload → 归一化事件；无法识别返回 null */
export function parseHookPayload(raw: unknown): PanelEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as RawHookPayload;
  switch (p.hook_event_name) {
    case 'Notification': {
      const msg = typeof p.message === 'string' ? p.message : '';
      if (/permission|权限/i.test(msg)) {
        return {
          type: 'permission_request',
          toolName: p.tool_name ?? extractToolFromMessage(msg) ?? '未知工具',
          commandText: toolInputBrief(p.tool_input),
        };
      }
      const text = msg.replace(/\s+/g, ' ').trim();
      if (!text) return { type: 'idle_prompt' };
      return { type: 'idle_prompt', message: text.length <= COMMAND_TEXT_MAX ? text : text.slice(0, COMMAND_TEXT_MAX) + '…' };
    }
    case 'PreToolUse':
      return typeof p.tool_name === 'string' && p.tool_name
        ? { type: 'tool_started', toolName: p.tool_name, commandText: toolInputBrief(p.tool_input) }
        : { type: 'tool_started' };
    case 'PostToolUse': return { type: 'tool_finished' };
    case 'Stop': return { type: 'turn_completed' };
    case 'SessionStart': return { type: 'session_started', source: sessionStartSource(p.source) };
    case 'UserPromptSubmit': {
      const prompt = typeof p.prompt === 'string' ? truncatePrompt(p.prompt) : '';
      return prompt ? { type: 'prompt_submitted', prompt } : { type: 'prompt_submitted' };
    }
    default: return null;
  }
}

/** 提示词事件携带的正文上限：历史与提示只需要摘要，完整内容不往下传 */
export const PROMPT_EVENT_MAX = 2000;

/** 按码点截断，不切断代理对 */
export function truncatePrompt(text: string, max = PROMPT_EVENT_MAX): string {
  if (text.length <= max) return text;
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

const START_SOURCES: readonly SessionStartSource[] = ['startup', 'resume', 'clear', 'compact'];

function sessionStartSource(v: unknown): SessionStartSource {
  return typeof v === 'string' && (START_SOURCES as readonly string[]).includes(v)
    ? v as SessionStartSource
    : 'unknown';
}

/**
 * 工具参数 → 单行摘要：按 command / file_path / path / url / pattern / description 取先命中的非空字符串，
 * 折叠空白后截断到 COMMAND_TEXT_MAX 字符；都没有返回空串。
 */
export function toolInputBrief(input: RawHookPayload['tool_input']): string {
  if (!input) return '';
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'description']) {
    const v = input[key];
    if (typeof v !== 'string') continue;
    const flat = v.replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    return flat.length <= COMMAND_TEXT_MAX ? flat : flat.slice(0, COMMAND_TEXT_MAX) + '…';
  }
  // AskUserQuestion：参数是问题列表，摘要取第一个问题的文本
  const questions = input.questions;
  if (Array.isArray(questions)) {
    const first = questions[0] as { question?: unknown } | undefined;
    const text = typeof first?.question === 'string' ? first.question.replace(/\s+/g, ' ').trim() : '';
    if (text) return text.length <= COMMAND_TEXT_MAX ? text : text.slice(0, COMMAND_TEXT_MAX) + '…';
  }
  return '';
}

/** 从 "Claude needs your permission to use Bash" 这类文本里抠工具名（含 mcp__server__tool 形式） */
function extractToolFromMessage(msg: string): string | null {
  const m = msg.match(/use ([\w-]+)$/);
  return m ? m[1] : null;
}

/** 纯函数状态流转；状态变化才刷新 statusSince。待续接的会话没有进程，任何事件都原样返回 */
export function transition(session: Session, event: PanelEvent, now: number): Session {
  if (session.status === 'suspended') return session;
  let next: SessionStatus;
  let pendingAction = session.pendingAction;
  let exitCode = session.exitCode;

  switch (event.type) {
    case 'permission_request':
      next = 'waiting_permission';
      pendingAction = { toolName: event.toolName, commandText: event.commandText };
      break;
    case 'tool_started':
    case 'tool_finished':
      next = 'running';
      pendingAction = undefined;
      break;
    case 'idle_prompt':
      next = 'waiting_input';
      pendingAction = undefined;
      break;
    case 'turn_completed':
      next = 'completed';
      pendingAction = undefined;
      break;
    case 'process_exit':
      // 0 = 正常结束；非 0 = 异常退出；null = 退出码未知（认领会话进程消失等），视为失联
      exitCode = event.code;
      next = event.code === 0 ? 'completed' : event.code === null ? 'disconnected' : 'error';
      pendingAction = undefined;
      break;
    case 'prompt_submitted':
      // 用户在终端直接提交提示词时，已完成 / 等待输入的会话也要及时回到运行中
      next = 'running';
      pendingAction = undefined;
      break;
    case 'subagent_start':
    case 'subagent_stop':
    case 'session_started':
      // 这几类事件由 SessionManager 先行分流，不改变会话状态；这里保留分支让 switch 保持穷尽
      return session;
    default: {
      // exhaustiveness: 任何未处理的 PanelEvent 会在编译期报错
      const _exhaustive: never = event;
      throw new Error(`未处理的 PanelEvent: ${JSON.stringify(_exhaustive)}`);
    }
  }

  const busy = busyAfter(event) ?? session.busy ?? false;
  if (next === session.status) {
    return { ...session, pendingAction, exitCode, busy };
  }
  return { ...session, status: next, statusSince: now, pendingAction, exitCode, escalated: false, busy };
}

/** 当前 hooks 配置版本：带 SessionStart 与 UserPromptSubmit 的配置为 2 */
export const HOOKS_VERSION = 2;

/**
 * 事件对忙碌标记的影响：提交提示词、工具开始 / 结束、权限请求置为忙碌；
 * 回合结束、等待输入、进程退出置为空闲；其余事件不改变（返回 undefined）。
 */
export function busyAfter(event: PanelEvent): boolean | undefined {
  switch (event.type) {
    case 'prompt_submitted':
    case 'tool_started':
    case 'tool_finished':
    case 'permission_request':
      return true;
    case 'turn_completed':
    case 'idle_prompt':
    case 'process_exit':
      return false;
    default:
      return undefined;
  }
}

/**
 * 发送消息前的忙碌判断：busy 为真，或会话的 hooks 配置早于当前版本（收不到提交提示词事件，
 * 只能靠工具事件推断，不可靠）时都视为可能正忙。
 */
export function maybeBusy(session: Session): boolean {
  return session.busy === true || (session.hooksVersion ?? 0) < HOOKS_VERSION;
}

/** 注意力优先级：数字越小越靠前 */
export const STATUS_SORT_PRIORITY: Record<SessionStatus, number> = {
  waiting_permission: 0,
  waiting_input: 1,
  error: 2,
  disconnected: 2,
  running: 3,
  completed: 4,
  suspended: 5,
};

export function compareByAttention(a: Session, b: Session): number {
  const p = STATUS_SORT_PRIORITY[a.status] - STATUS_SORT_PRIORITY[b.status];
  return p !== 0 ? p : a.statusSince - b.statusSince;
}
