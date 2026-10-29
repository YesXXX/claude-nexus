import type { ResumeCheck, ResumeFailure, Session } from '../shared/types';
import type { CliCapabilities } from './cli-capabilities';
import type { TranscriptLookup } from './claude-paths';

export const RESUME_MESSAGES = {
  readonly: '这是认领的外部会话，进程结束前不能续接',
  noId: '还没有拿到这段对话的 id，无法续接，只能全新开始',
  noTranscript: '找不到这段对话的记录，无法续接（可能从未发送过消息，或记录已被删除）',
  busy: '会话进程仍在运行，续接会先结束当前进程',
  found: '可以续接这段对话',
  unknown: '无法确认对话记录是否存在，可以尝试续接',
} as const;

export interface ResumeCheckInput {
  session: Session;
  /** 本会话进程是否仍存活（托管 PTY 未退出，或认领的孤儿 pid 仍在） */
  alive: boolean;
  /** 其他进程仍存活的会话：同一 Claude 会话 id 不允许被两个进程同时续接 */
  liveOthers: Session[];
  caps: CliCapabilities;
  exists: (p: string) => boolean;
  locate: (claudeId: string, hint?: string) => TranscriptLookup;
}

/**
 * 续接前检查。依次判断：只读认领 → 目录缺失 → 没有 id → 同一对话被占用 → 对话记录缺失 → 进程仍存活。
 * 进程存活放在最后：返回 busy 即表示「除了要先结束当前进程，其余条件都满足」，命令面板据此提供续接重启。
 */
export function evaluateResume(i: ResumeCheckInput): ResumeCheck {
  const s = i.session;
  const id = s.claudeSessionId;
  // 工作区还在、只是会话所在的子目录没了（未被跟踪的目录），回退到工作区根目录启动
  const fallback = s.worktree && i.exists(s.worktree.path) && !i.exists(s.cwd) ? s.worktree.path : undefined;
  const base = { claudeSessionId: id, ...(fallback ? { cwdFallback: fallback } : {}) };
  if (s.readOnly) {
    return { ...base, resumable: false, reason: 'readonly', message: RESUME_MESSAGES.readonly, transcript: 'unknown', canFresh: false, canFork: false };
  }
  if (s.worktree && !i.exists(s.worktree.path)) {
    return {
      ...base, resumable: false, reason: 'worktree_missing', transcript: 'unknown', canFresh: false, canFork: false,
      canRebuildWorktree: false, message: `工作区目录已不存在：${s.worktree.path}`,
    };
  }
  if (!fallback && !i.exists(s.cwd)) {
    return { ...base, resumable: false, reason: 'cwd_missing', message: `工作目录已不存在：${s.cwd}`, transcript: 'unknown', canFresh: false, canFork: false };
  }
  if (!id) {
    return { ...base, resumable: false, reason: 'no_id', message: RESUME_MESSAGES.noId, transcript: 'unknown', canFresh: true, canFork: false };
  }
  const lookup = i.locate(id, s.claudeTranscriptPath);
  const canFork = lookup.state === 'found' && i.caps.forkSession;
  if (lookup.state === 'found') Object.assign(base, { transcriptSize: lookup.size });
  const holder = i.liveOthers.find(o => o.claudeSessionId?.toLowerCase() === id.toLowerCase());
  if (holder) {
    return {
      ...base, resumable: false, reason: 'in_use', transcript: lookup.state, canFresh: true, canFork,
      message: `这段对话正在会话「${holder.label}」中运行`, inUseBy: { id: holder.id, label: holder.label },
    };
  }
  if (lookup.state === 'missing') {
    return { ...base, resumable: false, reason: 'no_transcript', message: RESUME_MESSAGES.noTranscript, transcript: 'missing', canFresh: true, canFork: false };
  }
  if (i.alive) {
    return { ...base, resumable: false, reason: 'busy', message: RESUME_MESSAGES.busy, transcript: lookup.state, canFresh: true, canFork };
  }
  return {
    ...base, resumable: true, transcript: lookup.state, canFresh: true, canFork,
    message: lookup.state === 'found' ? RESUME_MESSAGES.found : RESUME_MESSAGES.unknown,
  };
}

/** 去掉终端控制序列（CSI / OSC / 单字符转义）与其余不可见控制字符，保留换行 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

const FAILURE_TAIL_BYTES = 2048;
const FAILURE_DETAIL_CHARS = 400;

/** 续接确认前进程异常退出：按终端最后一段输出归类失败原因 */
export function classifyResumeFailure(rawOutput: string, exitCode: number | null, at: number): ResumeFailure {
  const tail = stripAnsi(rawOutput.slice(-FAILURE_TAIL_BYTES)).replace(/\r/g, '').trim();
  const reason: ResumeFailure['reason'] = /No conversation found/i.test(tail) ? 'no_transcript' : 'exited_early';
  const detail = tail.slice(-FAILURE_DETAIL_CHARS);
  return { reason, exitCode, at, ...(detail ? { detail } : {}) };
}
