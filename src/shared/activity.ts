/**
 * 活动事件的类型定义与纯函数：各模块通过 ActivityReporter 上报事件，由活动日志统一记录、
 * 去重并转交通知服务。上报方只依赖 ActivityReporter 接口；校验、缺省标题与过滤条件放在这里，
 * 主进程与渲染层共用。
 */

export type ActivityType =
  | 'session.start' | 'session.restart' | 'session.adopt' | 'session.end' | 'session.reset'
  | 'turn.start' | 'tool.batch' | 'turn.end'
  | 'wait.permission' | 'wait.input' | 'wait.overdue'
  | 'subagent.start' | 'subagent.stop' | 'subagent.abort'
  | 'session.error' | 'session.lost'
  | 'verify.result' | 'git.commit' | 'git.merge' | 'budget.alert';

export type ActivityLevel = 'info' | 'success' | 'warning' | 'error';

/** 外部模块上报时 data 的结构，按类型约束 */
export interface ActivityDataMap {
  'verify.result': { ok: boolean; name: string; summary?: string; durationMs?: number; exitCode?: number };
  'git.commit': { sha: string; subject: string; branch?: string; files?: number };
  'git.merge': { from: string; into: string; ok: boolean; sha?: string; conflicts?: number };
  /**
   * 上下文告警（类型名沿用旧称，保证历史记录兼容）。threshold 为档位百分比，context 用上下文百分比与 100（percent）；
   * session 与 daily 只出现在旧版本记下的预算告警里
   */
  'budget.alert': {
    scope: 'session' | 'daily' | 'context';
    used: number; limit: number; unit: 'usd' | 'tokens' | 'percent'; threshold: number;
  };
  'tool.batch': { count: number; tools: Record<string, number>; recent: string[]; lastAt: number };
  'wait.permission': { toolName: string; summary?: string };
  'session.reset': { source: 'clear' | 'compact' | 'resume' | 'startup' };
  'subagent.start': { agentType: string; description?: string };
  [k: string]: object | undefined;
}

export interface ActivityInput<T extends ActivityType = ActivityType> {
  type: T;
  /** 上报模块，如 usage、verify、git-finish、session */
  source: string;
  /** 全局事件可缺省 */
  sessionId?: string;
  agentId?: string;
  /** 缺省按类型推导 */
  level?: ActivityLevel;
  /** 缺省由活动日志按类型与 data 生成 */
  title?: string;
  detail?: string;
  data?: ActivityDataMap[T];
  at?: number;
  /** 同会话同 key 60 秒内只记一次 */
  dedupeKey?: string;
}

export interface ActivityEvent {
  id: string;
  /** 全局递增序号 */
  seq: number;
  /** 原地更新时递增 */
  rev: number;
  at: number;
  updatedAt: number;
  type: ActivityType;
  level: ActivityLevel;
  source: string;
  sessionId?: string;
  sessionLabel?: string;
  cwdTail?: string;
  agentId?: string;
  title: string;
  detail?: string;
  data?: object;
}

/** 上报入口：同步返回，不抛错；被去重或校验丢弃时返回 null */
export interface ActivityReporter {
  report(input: ActivityInput): ActivityEvent | null;
}

export const ACTIVITY_TYPES: readonly ActivityType[] = [
  'session.start', 'session.restart', 'session.adopt', 'session.end', 'session.reset',
  'turn.start', 'tool.batch', 'turn.end',
  'wait.permission', 'wait.input', 'wait.overdue',
  'subagent.start', 'subagent.stop', 'subagent.abort',
  'session.error', 'session.lost',
  'verify.result', 'git.commit', 'git.merge', 'budget.alert',
];

const TYPE_SET = new Set<string>(ACTIVITY_TYPES);
const LEVELS = new Set<string>(['info', 'success', 'warning', 'error']);

export function isActivityType(v: unknown): v is ActivityType {
  return typeof v === 'string' && TYPE_SET.has(v);
}

export function isActivityLevel(v: unknown): v is ActivityLevel {
  return typeof v === 'string' && LEVELS.has(v);
}

/** 标题、详情的长度上限（打码之后再截断） */
export const TITLE_MAX = 120;
export const DETAIL_MAX = 200;
/** data 序列化后超过该字节数整体丢弃，只保留标题与详情 */
export const DATA_MAX_BYTES = 2048;

type Data = Record<string, unknown>;

function okOf(data: Data | undefined): boolean | undefined {
  return typeof data?.ok === 'boolean' ? data.ok : undefined;
}

/** 按类型与 data 推导缺省级别 */
export function defaultActivityLevel(type: ActivityType, data?: object): ActivityLevel {
  const d = data as Data | undefined;
  switch (type) {
    case 'turn.end':
    case 'subagent.stop':
      return 'success';
    case 'wait.permission':
    case 'wait.overdue':
    case 'subagent.abort':
    case 'budget.alert':
      return 'warning';
    case 'session.error':
    case 'session.lost':
      return 'error';
    case 'verify.result':
    case 'git.merge':
      return okOf(d) === false ? 'error' : 'success';
    case 'git.commit':
      return 'success';
    default:
      return 'info';
  }
}

const RESET_TITLES: Record<string, string> = {
  clear: '上下文已清空（/clear）',
  compact: '上下文已压缩（compact）',
  resume: '恢复对话',
  startup: '会话启动',
};

const BUDGET_SCOPES: Record<string, string> = { session: '本会话预算', daily: '今日预算', context: '上下文' };

const STATIC_TITLES: Partial<Record<ActivityType, string>> = {
  'session.start': '会话开始',
  'session.restart': '会话重启',
  'session.adopt': '认领会话',
  'session.end': '会话已退出',
  'turn.start': '发出指令',
  'turn.end': '本轮结束',
  'wait.permission': '等待批准',
  'wait.input': '等待输入',
  'wait.overdue': '仍在等待',
  'subagent.start': '子代理开始',
  'subagent.stop': '子代理完成',
  'subagent.abort': '子代理中止',
  'session.error': '异常退出',
  'session.lost': '会话失联',
  'git.commit': '提交',
};

/** 缺省标题：上报方未给 title 时按类型与 data 生成，保证每条事件至少有一行可读内容 */
export function describeActivity(type: ActivityType, data?: object): string {
  const d = (data ?? {}) as Data;
  const str = (k: string): string => (typeof d[k] === 'string' ? (d[k] as string) : '');
  switch (type) {
    case 'session.reset':
      return RESET_TITLES[str('source')] ?? '上下文重置';
    case 'tool.batch':
      return `调用 ${typeof d.count === 'number' ? d.count : 0} 次工具`;
    case 'verify.result': {
      const name = str('name');
      return `${okOf(d) === false ? '验证失败' : '验证通过'}${name ? ` · ${name}` : ''}`;
    }
    case 'git.commit': {
      const sha = str('sha').slice(0, 7);
      return sha ? `提交 ${sha}` : '提交';
    }
    case 'git.merge': {
      const route = str('from') && str('into') ? ` ${str('from')} → ${str('into')}` : '';
      return `${okOf(d) === false ? '合并失败' : '合并完成'}${route}`;
    }
    case 'budget.alert': {
      const scope = BUDGET_SCOPES[str('scope')] ?? '预算';
      return typeof d.threshold === 'number' ? `${scope}达到 ${d.threshold}%` : `${scope}告警`;
    }
    default:
      return STATIC_TITLES[type] ?? type;
  }
}

/** 需关注：级别为 warning 或 error 的事件（等待批准、出错、失联、上下文告警、验证失败、合并失败等） */
export function isAttention(e: Pick<ActivityEvent, 'level'>): boolean {
  return e.level === 'warning' || e.level === 'error';
}

/** 时间线查询条件 */
export interface ActivityQuery {
  /** 只取 seq 小于该值的事件（向更早翻页） */
  beforeSeq?: number;
  /** 缺省 200，上限 500 */
  limit?: number;
  sessionIds?: string[];
  types?: ActivityType[];
  attentionOnly?: boolean;
}

export interface ActivityQueryResult {
  /** 按 seq 倒序（最新在前） */
  events: ActivityEvent[];
  hasMore: boolean;
  /** 当前日志中最大的 seq，无事件时为 0 */
  latestSeq: number;
}

/** 日志中出现过的会话，供过滤器列出已结束会话 */
export interface ActivitySessionInfo {
  id: string;
  label: string;
  alive: boolean;
}

/** 增量推送：同 id 只留最新版本 */
export interface ActivityPush {
  upserts: ActivityEvent[];
  /** 清空日志后为 true，渲染层丢弃本地列表 */
  cleared?: boolean;
}

/** 是否满足查询的过滤条件（不含分页），主进程查询与渲染层增量过滤共用 */
export function matchesActivityQuery(e: ActivityEvent, q: Pick<ActivityQuery, 'sessionIds' | 'types' | 'attentionOnly'>): boolean {
  if (q.sessionIds && q.sessionIds.length > 0 && (!e.sessionId || !q.sessionIds.includes(e.sessionId))) return false;
  if (q.types && q.types.length > 0 && !q.types.includes(e.type)) return false;
  if (q.attentionOnly && !isAttention(e)) return false;
  return true;
}
