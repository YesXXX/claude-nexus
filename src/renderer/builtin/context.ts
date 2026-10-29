import { api } from '../core/api.js';
import type { ActiveTerminal, AppContext } from '../core/context.js';
import { queryEl } from '../core/dom.js';
import { registry } from '../core/registry.js';
import { render, requestRender } from '../core/render.js';
import { state } from '../core/state.js';
import { choiceDialog, confirmDialog } from '../ui/dialogs.js';
import { toast } from '../ui/toast.js';
import type { TerminalEntry } from '../term/host.js';
import { applyTermTheme, subagentTermMap, termMap } from '../term/host.js';
import { focusSessionInput } from '../term/terminals.js';
import { focusUrgent, selectSession, selectSubagent, showTerminalTab } from '../actions/selection.js';
import { sendApprove } from '../actions/session-actions.js';
import { createSessionAndSelect } from '../actions/create-session.js';
import { setPaneTab } from '../views/detail-pane.js';
import { goHome } from '../views/home.js';
import { closePalette, openPalette } from '../views/palette.js';

/** 宿主里实际挂着的终端：实例存在且元素就在宿主中（切换会话时其他实例的元素会被移出） */
function attached(map: Map<string, TerminalEntry>, key: string, hostId: string): { entry: TerminalEntry; card: HTMLElement } | null {
  const entry = map.get(key);
  const host = queryEl(hostId);
  if (!entry || !host || !host.parentElement || entry.term.element?.parentElement !== host) return null;
  return { entry, card: host.parentElement };
}

function activeTerminal(): ActiveTerminal | null {
  const sid = state.selectedId;
  if (!sid) return null;
  const sub = state.selectedSubagent;
  if (sub && sub.sessionId === sid) {
    const key = sid + '\0' + sub.agentId;
    const hit = attached(subagentTermMap, key, 'subagent-terminal-host');
    return hit ? { key, kind: 'subagent', sessionId: sid, term: hit.entry.term, card: hit.card } : null;
  }
  if (state.paneTab !== 'term') return null;
  // 父会话终端可能挂在单窗格宿主或某个窗格宿主上：以元素实际所在、且可见的宿主为准
  const entry = termMap.get(sid);
  const host = entry?.term.element?.parentElement as HTMLElement | null | undefined;
  if (!entry || !host || !host.classList.contains('terminal-host') || !host.isConnected || host.closest('[hidden]')) return null;
  const card = host.parentElement;
  return card ? { key: sid, kind: 'session', sessionId: sid, term: entry.term, card } : null;
}

/** 装配安装上下文：把各层的实现收拢成功能模块可用的一个对象；入口启动时创建一次 */
export function createAppContext(): AppContext {
  return {
    api: api(),
    terminals: {
      active: activeTerminal,
      focus: t => { t.term.focus(); },
      refreshTheme: applyTermTheme,
    },
    state,
    render,
    requestRender,
    toast,
    confirm: confirmDialog,
    choice: choiceDialog,
    actions: {
      selectSession,
      selectSubagent,
      setPaneTab,
      focusSessionInput,
      showTerminalTab,
      focusUrgent,
      goHome,
      createSessionAndSelect,
      openPalette,
      approve: sendApprove,
      closePalette,
    },
    registry,
  };
}
