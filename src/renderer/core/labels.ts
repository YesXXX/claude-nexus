import type { Session, SubagentEntry } from '../../shared/types';
import type { FilterKey } from '../../shared/filters.js';
import type { GroupKey } from '../../shared/session-view.js';
import { cwdBaseName } from '../../shared/session-view.js';

/** 状态文案、图标与筛选、分组标签常量 */

export const STATUS_TEXT: Record<Session['status'], string> = {
  running: '运行中',
  waiting_permission: '等待权限',
  waiting_input: '等待输入',
  completed: '已完成',
  error: '异常退出',
  disconnected: '已失联',
  suspended: '待续接',
};

/** 子代理状态收敛到列表图标体系：终止视同失联（虚线圈） */
export const SUB_ICON_STATUS: Record<SubagentEntry['status'], Session['status']> = {
  running: 'running', completed: 'completed', aborted: 'disconnected',
};

export const SUBAGENT_STATUS_TEXT: Record<SubagentEntry['status'], string> = {
  running: '运行中', completed: '已完成', aborted: '已终止',
};

/** 子代理按 agentType 选图标 */
const SUBAGENT_ICON: Record<string, string> = {
  Explore: '🔍',
  Plan: '📐',
  fork: '🔱',
  general: '⚙',
};

export function subagentIcon(type: string): string {
  return SUBAGENT_ICON[type] ?? SUBAGENT_ICON.general ?? '⚙';
}

export function subagentTitle(sub: SubagentEntry): string {
  return sub.description?.trim() || `${sub.agentType} · ${sub.agentId.slice(0, 6)}`;
}

export const FILTER_LABELS: Record<FilterKey, string> = { all: '全部', attention: '待处理', running: '运行中', done: '已完成' };

/** 分组头与总览使用的静止状态图标 */
export const GROUP_ICON: Record<GroupKey, Session['status']> = {
  perm: 'waiting_permission', input: 'waiting_input', trouble: 'error', running: 'running', done: 'completed',
  suspended: 'suspended',
};

/** 项目名：工作区会话取主仓库目录名，否则取工作目录名（工作区路径末段是 nexus-xxxx，没有辨识度） */
export function projectName(s: Session): string {
  return cwdBaseName(s.worktree?.repoRoot ?? s.cwd);
}
