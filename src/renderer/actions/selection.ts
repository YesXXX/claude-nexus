import { dbg, short } from '../core/debug.js';
import { emit } from '../core/events.js';
import { hasPickTarget, isMultiPane, openSessionInLayout, setPickTarget } from '../core/panes.js';
import { saveCollapsed } from '../core/persist.js';
import { render } from '../core/render.js';
import { findSession, state } from '../core/state.js';
import { focusSessionInput } from '../term/terminals.js';

/**
 * 选中会话或子代理、折叠父会话、跳到待处理。
 * 选中变化后发出 selection-changed，命令面板等浮层据此自行关闭。
 */

export function selectSession(id: string): void {
  // 切到父会话：清掉子代理选中态
  const hadSubagent = state.selectedSubagent !== null;
  state.selectedSubagent = null;
  // 已在选这个父会话且无子代理选中态 → 仅聚焦终端（避免 render() 触发的不必要 fit/重绘）
  // 但若当时有子代理视图（点父条目回退到主视图）必须 render() 让 subPane.hidden=true；
  // 有空占位的拾取目标时也要继续，把会话放进目标窗格
  if (state.selectedId === id && !hadSubagent && !hasPickTarget()) {
    focusSessionInput(id);
    return;
  }
  openSessionInLayout(id);
  state.selectedId = id;
  // 多窗格时标签属于整个详情区，切换焦点窗格不换标签
  if (!isMultiPane()) state.paneTab = state.paneTabBySession.get(id) ?? 'term';
  emit('selection-changed', { sessionId: id });
  render();
}

export function selectSubagent(sessionId: string, agentId: string): void {
  if (!findSession(sessionId)) return;   // 父不在则忽略
  setPickTarget(null);
  if (state.selectedId === sessionId && state.selectedSubagent?.agentId === agentId) return;
  state.selectedId = sessionId;
  state.selectedSubagent = { sessionId, agentId };
  emit('selection-changed', { sessionId });
  render();
}

export function toggleCollapsed(sessionId: string): void {
  if (state.collapsedSessions.has(sessionId)) state.collapsedSessions.delete(sessionId);
  else state.collapsedSessions.add(sessionId);
  saveCollapsed(state.collapsedSessions);
  render();
}

/**
 * 跳到第一个需要人处理的会话（等待权限优先，其次等待输入）。
 * 命令面板与全局热键共用；找到返回 true。
 */
export function focusUrgent(): boolean {
  const target = state.sessions.find(s => s.status === 'waiting_permission' && !s.readOnly)
    ?? state.sessions.find(s => s.status === 'waiting_input' && !s.readOnly);
  if (!target) {
    dbg('hotkey', '跳到待处理：当前没有等待权限/等待输入的会话');
    return false;
  }
  dbg('hotkey', `跳到待处理：选中并聚焦 ${short(target.id)}（${target.label}，${target.status}）`);
  showTerminalTab(target.id);   // 待处理会话要在终端里输入或审批
  state.pendingFocusId = target.id;
  selectSession(target.id);
  return true;
}

/** 跳转类入口（待处理、系统通知）随后要在终端里操作：把该会话的标签切回终端。
 *  多窗格时标签属于整个详情区，同样回到窗格网格 */
export function showTerminalTab(id: string): void {
  state.paneTabBySession.set(id, 'term');
  if ((state.selectedId === id || isMultiPane()) && state.paneTab !== 'term') {
    state.paneTab = 'term';
    render();
  }
}
