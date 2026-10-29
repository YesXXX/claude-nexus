import { Session, SessionStatus } from './types';

/** 列表分组键：异常退出与已失联合并一组，保证分组顺序与主进程排序优先级一致 */
export type GroupKey = 'perm' | 'input' | 'trouble' | 'running' | 'done' | 'suspended';

export interface SessionGroup {
  key: GroupKey;
  title: string;
  sessions: Session[];
}

const GROUP_OF: Record<SessionStatus, GroupKey> = {
  waiting_permission: 'perm',
  waiting_input: 'input',
  error: 'trouble',
  disconnected: 'trouble',
  running: 'running',
  completed: 'done',
  suspended: 'suspended',
};

const GROUP_ORDER: ReadonlyArray<[GroupKey, string]> = [
  ['perm', '等待权限'],
  ['input', '等待输入'],
  ['trouble', '异常 / 失联'],
  ['running', '运行中'],
  ['done', '已完成'],
  ['suspended', '待续接'],
];

/** 按状态分组（只返回非空组），组内保持传入顺序 */
export function groupSessions(list: readonly Session[]): SessionGroup[] {
  const buckets = new Map<GroupKey, Session[]>();
  for (const s of list) {
    const key = GROUP_OF[s.status];
    const bucket = buckets.get(key);
    if (bucket) bucket.push(s); else buckets.set(key, [s]);
  }
  const out: SessionGroup[] = [];
  for (const [key, title] of GROUP_ORDER) {
    const sessions = buckets.get(key);
    if (sessions) out.push({ key, title, sessions });
  }
  return out;
}

/** 分组后的展示顺序：列表序号、Ctrl+数字直达、J/K 切换都以此为准 */
export function orderForDisplay(list: readonly Session[]): Session[] {
  return groupSessions(list).flatMap(g => g.sessions);
}

/** 列表行用的紧凑时长：45秒 / 6分 / 2小时 / 3天 */
export function shortDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时`;
  return `${Math.floor(hour / 24)}天`;
}

/** 详情与属性面板用的完整时长：12 秒 / 6 分 12 秒 / 1 小时 3 分 / 2 天 4 小时 */
export function longDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分 ${sec % 60} 秒`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时 ${min % 60} 分`;
  return `${Math.floor(hour / 24)} 天 ${hour % 24} 小时`;
}

/** 工作目录的最后一级名称（兼容 / 与 \ 及末尾分隔符）；取不到时原样返回 */
export function cwdBaseName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** 命令面板搜索：查询按空白拆词，每个词都要（不区分大小写）出现在任一字段里 */
export function matchesQuery(query: string, ...fields: Array<string | undefined>): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields.filter((f): f is string => !!f).join('\n').toLowerCase();
  return words.every(w => hay.includes(w));
}

/** J/K 切换：在展示顺序中前后移动，到两端停住；当前未选中时 J 取第一项、K 取最后一项 */
export function stepSelection(ids: readonly string[], currentId: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const idx = currentId ? ids.indexOf(currentId) : -1;
  if (idx < 0) return delta > 0 ? ids[0] : ids[ids.length - 1];
  const next = Math.min(ids.length - 1, Math.max(0, idx + delta));
  return ids[next];
}
