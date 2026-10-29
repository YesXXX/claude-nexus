import type { ActivityEvent, ActivityInput, ActivityReporter } from '../shared/activity';
import { redact } from '../shared/redact';
import type { PanelEvent, Session, SubagentEntry } from '../shared/types';
import type { VerifySummary } from '../shared/verify-types';
import type { SessionLifecycle } from './session-manager';
import type { SubagentPhase } from './subagent-tracker';

/**
 * 会话与子代理信号到活动事件的映射：生命周期、状态机事件、子代理三阶段。
 * 只做映射与少量会话内状态（回合起点、本轮工具数、最近一次启动时间），记录、合并与落盘都交给活动日志。
 */

/** 活动日志里供来源映射使用的能力 */
export interface ActivitySink extends ActivityReporter {
  recordTool(sessionId: string, toolName: string | undefined, summary?: string, at?: number): ActivityEvent | null;
  closeToolBatch(sessionId: string): void;
}

export interface ActivitySourceOptions {
  now?: () => number;
  /** 面板正在退出：退出引发的进程结束、子代理中止不再记事件 */
  isQuitting?: () => boolean;
}

/** 面板拉起会话后 CLI 回报的 SessionStart 在该时间窗内不重复记为上下文重置 */
export const LAUNCH_ECHO_MS = 5000;
/** 发出指令的详情只保留前 120 个字符 */
export const PROMPT_DETAIL_MAX = 120;

export interface ActivitySources {
  onLifecycle(kind: SessionLifecycle, session: Session): void;
  onEvent(sessionId: string, event: PanelEvent): void;
  onSubagent(sessionId: string, entry: SubagentEntry, phase: SubagentPhase): void;
}

const LIFECYCLE_TYPES = {
  created: 'session.start',
  restarted: 'session.restart',
  adopted: 'session.adopt',
  killed: 'session.end',
} as const;

const SUBAGENT_TYPES = { start: 'subagent.start', stop: 'subagent.stop', abort: 'subagent.abort' } as const;

/** 时长文本：不足一分钟按秒，否则按分钟 */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} 分` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

export function createActivitySources(sink: ActivitySink, opts: ActivitySourceOptions = {}): ActivitySources {
  const now = opts.now ?? (() => Date.now());
  const quitting = (): boolean => opts.isQuitting?.() === true;
  /** 面板拉起（新建、重启、认领）的时间，用于识别 CLI 对启动的回报 */
  const launchedAt = new Map<string, number>();
  const turnStart = new Map<string, number>();
  const turnTools = new Map<string, number>();
  const source = 'session';

  const forget = (id: string): void => {
    launchedAt.delete(id);
    turnStart.delete(id);
    turnTools.delete(id);
  };

  return {
    onLifecycle(kind, session) {
      const type = LIFECYCLE_TYPES[kind];
      if (!type) return;
      if (kind === 'killed') {
        sink.report({ type, source, sessionId: session.id, detail: '在面板中结束' });
        forget(session.id);
        return;
      }
      launchedAt.set(session.id, now());
      turnStart.delete(session.id);
      turnTools.delete(session.id);
      const branch = session.worktree?.branch;
      sink.report({ type, source, sessionId: session.id, ...(branch ? { detail: `独立工作区 ${branch}` } : {}) });
    },

    onEvent(sessionId, event) {
      switch (event.type) {
        case 'session_started': {
          const src = event.source === 'unknown' ? 'startup' : event.source;
          const launched = launchedAt.get(sessionId);
          // 面板刚拉起时 CLI 会回报 startup（重启续接时为 resume），与会话开始重复，不另记
          if ((src === 'startup' || src === 'resume') && launched !== undefined && now() - launched <= LAUNCH_ECHO_MS) return;
          sink.report({ type: 'session.reset', source, sessionId, data: { source: src } });
          return;
        }
        case 'prompt_submitted': {
          turnStart.set(sessionId, now());
          turnTools.set(sessionId, 0);
          const prompt = event.prompt ? redact(event.prompt.replace(/\s+/g, ' ').trim(), PROMPT_DETAIL_MAX) : '';
          sink.report({ type: 'turn.start', source, sessionId, ...(prompt ? { detail: prompt } : {}) });
          return;
        }
        case 'tool_started':
          turnTools.set(sessionId, (turnTools.get(sessionId) ?? 0) + 1);
          sink.recordTool(sessionId, event.toolName, event.commandText);
          return;
        case 'permission_request': {
          const summary = event.commandText || '';
          sink.report({
            type: 'wait.permission', source, sessionId,
            detail: summary ? `${event.toolName}：${summary}` : event.toolName,
            data: summary ? { toolName: event.toolName, summary } : { toolName: event.toolName },
          });
          return;
        }
        case 'idle_prompt':
          sink.report(event.message
            ? { type: 'wait.input', source, sessionId, detail: event.message }
            : { type: 'wait.input', source, sessionId });
          return;
        case 'turn_completed': {
          const parts: string[] = [];
          const tools = turnTools.get(sessionId) ?? 0;
          if (tools > 0) parts.push(`调用 ${tools} 次工具`);
          const start = turnStart.get(sessionId);
          if (start !== undefined) parts.push(`用时 ${durationText(now() - start)}`);
          turnStart.delete(sessionId);
          turnTools.delete(sessionId);
          sink.report({ type: 'turn.end', source, sessionId, ...(parts.length ? { detail: parts.join(' · ') } : {}) });
          return;
        }
        case 'process_exit': {
          if (quitting()) return;
          const code = event.code;
          if (code === 0) sink.report({ type: 'session.end', source, sessionId, detail: '退出码 0' });
          else if (code === null) sink.report({ type: 'session.lost', source, sessionId, detail: '进程已不在' });
          else sink.report({ type: 'session.error', source, sessionId, detail: `退出码 ${code}` });
          forget(sessionId);
          return;
        }
        default:
          return;
      }
    },

    onSubagent(sessionId, entry, phase) {
      if (phase === 'abort' && quitting()) return;
      const type = SUBAGENT_TYPES[phase];
      if (!type) return;
      const desc = entry.description?.trim();
      sink.report({
        type, source: 'subagent', sessionId, agentId: entry.agentId,
        detail: desc ? `${entry.agentType} · ${desc}` : entry.agentType,
        ...(phase === 'start' ? { data: desc ? { agentType: entry.agentType, description: desc } : { agentType: entry.agentType } } : {}),
      });
    },
  };
}

/** 一次验证结果 → 活动上报输入：名称取验证命令，失败时摘要为退出码或错误说明 */
export function verifyResultInput(sessionId: string, s: VerifySummary): ActivityInput {
  const ok = s.status === 'passed';
  const summary = ok ? undefined : s.status === 'failed' ? `退出码 ${s.exitCode ?? '未知'}` : (s.message || s.status);
  const data: Record<string, unknown> = { ok, name: s.command };
  if (summary) data.summary = summary;
  if (typeof s.durationMs === 'number') data.durationMs = s.durationMs;
  if (typeof s.exitCode === 'number') data.exitCode = s.exitCode;
  const parts = [summary, typeof s.durationMs === 'number' ? `用时 ${durationText(s.durationMs)}` : undefined].filter(Boolean);
  return {
    type: 'verify.result', source: 'verify', sessionId, data,
    ...(parts.length ? { detail: parts.join(' · ') } : {}),
  };
}
