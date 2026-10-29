import { Session } from './types';

/** 侧栏过滤片的分组键 */
export type FilterKey = 'all' | 'attention' | 'running' | 'done';

/** 分组语义：待处理 = 需用户决策/关注；运行中 = 正常干活；已完成 = 收工（待续接也归这里，不占注意力） */
export function filterGroup(status: Session['status']): Exclude<FilterKey, 'all'> {
  switch (status) {
    case 'running': return 'running';
    case 'completed':
    case 'suspended': return 'done';
    default: return 'attention';  // waiting_permission / waiting_input / error / disconnected
  }
}

/** 全量统计：过滤片上的数字永远反映全部会话，不受当前过滤影响 */
export function summarize(sessions: Session[]): Record<FilterKey, number> {
  const out: Record<FilterKey, number> = { all: sessions.length, attention: 0, running: 0, done: 0 };
  for (const s of sessions) out[filterGroup(s.status)]++;
  return out;
}

/** 退出保护：还在干活的会话数（running + waiting_*，排除只读孤儿与已退出进程） */
export function countActiveSessions(sessions: Session[]): number {
  return sessions.filter(s =>
    !s.readOnly && (s.status === 'running' || s.status === 'waiting_permission' || s.status === 'waiting_input'),
  ).length;
}
