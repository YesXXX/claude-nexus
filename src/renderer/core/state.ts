import type { Session } from '../../shared/types';
import type { FilterKey } from '../../shared/filters.js';
import { filterGroup } from '../../shared/filters.js';
import { orderForDisplay } from '../../shared/session-view.js';

/**
 * 跨模块共享的界面状态：一个可变对象，修改后调用 render() 整体重绘。
 * 只有单个模块使用的状态留在该模块内部，不放进这里。
 * 导入时不读 localStorage，持久化的初始值由入口调用 initState() 载入。
 */
export interface AppState {
  sessions: Session[];
  selectedId: string | null;
  /** 选中子代理后右侧切到只读 xterm；点父条目、父消失、选中别的会话时清空 */
  selectedSubagent: { sessionId: string; agentId: string } | null;
  activeFilter: FilterKey;
  /** 折叠的父会话 id 集合：仅影响侧栏子代理可见性，不影响选中态与右侧视图 */
  collapsedSessions: Set<string>;
  /** 属性面板显隐（导航轨右下角按钮切换） */
  inspectorHidden: boolean;
  /** 父会话详情当前所在的标签 id，内置为 'term' 与 'changes' */
  paneTab: string;
  /** 按会话记住上次所在的标签：新会话默认终端，跳转待处理会话时回到终端 */
  paneTabBySession: Map<string, string>;
  /** 终端异步创建完成后需要聚焦的会话（热键、通知点击场景） */
  pendingFocusId: string | null;
  /** 审批防双发：已发出决定、等待状态推送确认的会话（3s 兜底超时防推送丢失永久卡死） */
  pendingApprove: { id: string; at: number } | null;
}

export const state: AppState = {
  sessions: [],
  selectedId: null,
  selectedSubagent: null,
  activeFilter: 'all',
  collapsedSessions: new Set(),
  inspectorHidden: false,
  paneTab: 'term',
  paneTabBySession: new Map(),
  pendingFocusId: null,
  pendingApprove: null,
};

/** 载入持久化的初始值；由入口在绑定界面之前调用一次 */
export function initState(init: { collapsedSessions: Set<string>; inspectorHidden: boolean }): void {
  state.collapsedSessions = init.collapsedSessions;
  state.inspectorHidden = init.inspectorHidden;
}

export function findSession(id: string): Session | undefined {
  return state.sessions.find(s => s.id === id);
}

/** 当前选中的父会话（选中子代理时为其父会话） */
export function selectedSession(): Session | undefined {
  return state.selectedId ? findSession(state.selectedId) : undefined;
}

/** 当前过滤下可见的会话（Ctrl+数字直达也以此为准，与侧栏编号所见即所得） */
export function visibleSessions(): Session[] {
  const filtered = state.activeFilter === 'all'
    ? state.sessions
    : state.sessions.filter(s => filterGroup(s.status) === state.activeFilter);
  return orderForDisplay(filtered);
}
