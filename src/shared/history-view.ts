import type { EndKind, ResumeBlockReason, SessionRecord } from './types';
import { endKindOf } from './session-records.js';

/** 历史面板的纯展示逻辑：时间范围、结束状态文字、提示词摘要、时长、工作区提示 */

export type HistoryRange = 'today' | '7d' | '30d' | 'all';

const DAY_MS = 24 * 60 * 60 * 1000;

export const RANGE_TEXT: Record<HistoryRange, string> = {
  today: '今天', '7d': '7 天', '30d': '30 天', all: '全部',
};

export const END_KIND_TEXT: Record<EndKind, string> = {
  killed: '主动结束',
  error: '异常退出',
  quit: '随面板结束',
  migrated: '旧版迁移',
};

/** 续接不可用原因的短文字，与续接模块的口径一致 */
export const BLOCK_REASON_TEXT: Record<ResumeBlockReason, string> = {
  no_id: '没有对话 id',
  no_transcript: '对话记录缺失',
  cwd_missing: '目录已不存在',
  worktree_missing: '工作区已删除',
  in_use: '对话正在别的会话中运行',
  busy: '进程仍在运行',
  readonly: '只读会话',
};

/** 时间范围的起点：今天从本地零点算，7 天与 30 天往前推整天数，全部不限 */
export function rangeSince(range: HistoryRange, now = Date.now()): number | undefined {
  if (range === 'all') return undefined;
  if (range === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return now - (range === '7d' ? 7 : 30) * DAY_MS;
}

export function endKindText(r: SessionRecord): string {
  return END_KIND_TEXT[endKindOf(r)];
}

/** 提示词摘要：压成一行，超长截断加省略号 */
export function promptSummary(text: string | undefined, max = 80): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** 结束时间：缺失时用最后更新时间兜底 */
export function recordEndTime(r: SessionRecord): number {
  return r.endedAt ?? r.updatedAt;
}

/** 会话时长：从创建到结束 */
export function recordDurationMs(r: SessionRecord): number {
  return Math.max(0, recordEndTime(r) - r.createdAt);
}

/** 月-日 时:分；跨年时带年份 */
export function formatStamp(ms: number, now = Date.now()): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/** 记录关联的工作区是否可能仍在磁盘上（删除记录不会删它，需要提示用户另行清理） */
export function worktreeLeft(r: SessionRecord): boolean {
  return !!r.worktree && r.worktreeRemoved !== true;
}

/** 删除记录的确认文字：工作区仍在时说明不会一并删除 */
export function deleteMessage(r: SessionRecord): string {
  const base = `只删除这条历史记录，Claude 自己的对话记录不受影响。`;
  return worktreeLeft(r)
    ? `${base}\n关联的工作区 ${r.worktree!.path} 不会被删除，可在命令面板「清理工作区」中处理。`
    : base;
}

/** 模板名：取标签，没有标签时用首条提示词摘要 */
export function templateNameOf(r: SessionRecord, max = 80): string {
  const base = r.label.trim() || promptSummary(r.firstPrompt, 40) || '历史会话';
  return base.length > max ? base.slice(0, max) : base;
}
