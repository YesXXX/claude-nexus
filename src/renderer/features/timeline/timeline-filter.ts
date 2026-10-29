import { isAttention, matchesActivityQuery } from '../../../shared/activity.js';
import type { ActivityEvent, ActivityQuery, ActivityType } from '../../../shared/activity';

/**
 * 时间线的纯函数：类别划分、过滤条件到查询的转换、增量合并、分组与文本，不依赖 DOM。
 */

export type TimelineCategory = 'status' | 'turn' | 'subagent' | 'verify' | 'git' | 'budget';

export const CATEGORY_TEXT: Record<TimelineCategory, string> = {
  status: '状态',
  turn: '指令与工具',
  subagent: '子代理',
  verify: '验证',
  git: 'Git',
  budget: '上下文',
};

export const CATEGORIES: TimelineCategory[] = ['status', 'turn', 'subagent', 'verify', 'git', 'budget'];

const CATEGORY_TYPES: Record<TimelineCategory, ActivityType[]> = {
  status: [
    'session.start', 'session.restart', 'session.adopt', 'session.end', 'session.reset',
    'wait.permission', 'wait.input', 'wait.overdue', 'session.error', 'session.lost',
  ],
  turn: ['turn.start', 'tool.batch', 'turn.end'],
  subagent: ['subagent.start', 'subagent.stop', 'subagent.abort'],
  verify: ['verify.result'],
  git: ['git.commit', 'git.merge'],
  budget: ['budget.alert'],
};

export function typesOf(categories: TimelineCategory[]): ActivityType[] {
  return categories.flatMap(c => CATEGORY_TYPES[c] ?? []);
}

export interface TimelineFilter {
  sessionIds: string[];
  categories: TimelineCategory[];
  attentionOnly: boolean;
}

export function emptyFilter(): TimelineFilter {
  return { sessionIds: [], categories: [], attentionOnly: false };
}

export function isFilterEmpty(f: TimelineFilter): boolean {
  return f.sessionIds.length === 0 && f.categories.length === 0 && !f.attentionOnly;
}

/** 过滤条件 → 主进程查询（不含分页） */
export function toQuery(f: TimelineFilter): Pick<ActivityQuery, 'sessionIds' | 'types' | 'attentionOnly'> {
  const q: Pick<ActivityQuery, 'sessionIds' | 'types' | 'attentionOnly'> = {};
  if (f.sessionIds.length > 0) q.sessionIds = [...f.sessionIds];
  if (f.categories.length > 0) q.types = typesOf(f.categories);
  if (f.attentionOnly) q.attentionOnly = true;
  return q;
}

/** 增量推送按与主进程查询相同的条件过滤 */
export function matchesFilter(e: ActivityEvent, f: TimelineFilter): boolean {
  return matchesActivityQuery(e, toQuery(f));
}

const ICONS: Record<ActivityType, string> = {
  'session.start': '🟢',
  'session.restart': '🔄',
  'session.adopt': '📥',
  'session.end': '⏹',
  'session.reset': '🧹',
  'turn.start': '▶',
  'tool.batch': '🛠',
  'turn.end': '✅',
  'wait.permission': '🔐',
  'wait.input': '💬',
  'wait.overdue': '⏰',
  'subagent.start': '🧩',
  'subagent.stop': '🧩',
  'subagent.abort': '🧩',
  'session.error': '❌',
  'session.lost': '📡',
  'verify.result': '🧪',
  'git.commit': '📝',
  'git.merge': '🔀',
  'budget.alert': '📏',
};

export function iconOf(type: ActivityType): string {
  return ICONS[type] ?? '•';
}

export { isAttention };

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function clockText(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 行首时间：合并的工具调用显示起止时间段 */
export function timeText(e: Pick<ActivityEvent, 'type' | 'at' | 'updatedAt'>): string {
  if (e.type === 'tool.batch' && e.updatedAt - e.at >= 1000) return `${clockText(e.at)}–${clockText(e.updatedAt)}`;
  return clockText(e.at);
}

/** 本地日期键，用于按天分组 */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 分组标题：今天、昨天，其余为「M月D日」（跨年带年份） */
export function dayLabel(ts: number, now = Date.now()): string {
  const key = dayKey(ts);
  if (key === dayKey(now)) return '今天';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === dayKey(y.getTime())) return '昨天';
  const d = new Date(ts);
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

/**
 * 把增量并入按 seq 倒序的列表：同 id 替换，新事件按 seq 插到正确位置。
 * 返回新列表（不改入参）。
 */
export function mergeEvents(list: ActivityEvent[], upserts: ActivityEvent[]): ActivityEvent[] {
  if (upserts.length === 0) return list;
  const byId = new Map(list.map(e => [e.id, e]));
  for (const u of upserts) {
    const old = byId.get(u.id);
    if (!old || u.rev >= old.rev) byId.set(u.id, u);
  }
  return [...byId.values()].sort((a, b) => b.seq - a.seq);
}

/** 会话色点：按会话 id 散列出固定色相，同一会话在各行颜色一致 */
export function sessionHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** 合并的工具调用最近几条摘要 */
export function batchRecent(e: ActivityEvent): string[] {
  const r = (e.data as { recent?: unknown } | undefined)?.recent;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
}

/** 复制为文本：每行「日期 时间 会话 标题 详情」 */
export function eventsToText(events: ActivityEvent[]): string {
  return events.map(e => {
    const parts = [`${dayKey(e.at)} ${timeText(e)}`, e.sessionLabel ?? (e.sessionId ? e.sessionId.slice(0, 8) : '全局'), e.title];
    if (e.detail) parts.push(e.detail);
    return parts.join('  ');
  }).join('\n');
}
