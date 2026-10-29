import type { Session } from '../../shared/types';
import { longDuration } from '../../shared/session-view.js';
import { byId, el, statusIcon } from '../core/dom.js';
import { projectName, STATUS_TEXT } from '../core/labels.js';
import type { DetailTab, DetailTabView } from '../core/registry.js';
import { detailTab, detailTabKey, detailTabs, paneActions, renderEach, termCovers } from '../core/registry.js';
import { render } from '../core/render.js';
import { isMultiPane } from '../core/panes.js';
import { selectedSession, state } from '../core/state.js';
import { renderRecent } from './home.js';
import { mountTerminal, setPaneFocusHandler } from '../term/terminals.js';
import { mountSubagentTerminal } from '../term/subagent-terms.js';
import { syncPaneChrome } from './pane-chrome.js';
import { hidePaneGrid, renderPaneGrid } from './pane-grid.js';
import { renderPermissionBar } from './permission-bar.js';
import { paneMenuOpenFor, renderPaneMenuButton } from './pane-menu.js';
import { renderSubagentPane } from './subagent-pane.js';

/** 父会话详情：页头、操作按钮、标签栏与标签宿主切换；子代理视图与空态也由这里分派 */

const TERM = 'term';

// 已创建的标签视图（按标签名）与当前展示中的标签和会话；null = 没有非终端标签在展示
const views = new Map<string, DetailTabView>();
let shown: { tab: string; session: string } | null = null;

export function renderMainPane(): void {
  const empty = byId('main-empty');
  const pane = byId('main-pane');
  const subPane = byId('subagent-pane');
  const s = selectedSession();

  if (!s) {
    hideActiveView();
    empty.hidden = false; pane.hidden = true; subPane.hidden = true;
    renderRecent();
    return;
  }
  // 子代理视图优先（点子条目进入；点父条目或换会话切回父视图）
  if (state.selectedSubagent && state.selectedSubagent.sessionId === s.id) {
    const sub = (s.subagents ?? []).find(x => x.agentId === state.selectedSubagent!.agentId);
    if (sub) {
      hideActiveView();
      empty.hidden = true; pane.hidden = true; subPane.hidden = false;
      renderSubagentPane(s, sub);
      mountSubagentTerminal(s, sub);
      return;
    }
    state.selectedSubagent = null;   // 子条目已被 tracker 清掉（kill/abort 触发）：回退到父视图
  }
  empty.hidden = true; pane.hidden = false; subPane.hidden = true;
  renderParentPane(s);
}

function renderParentPane(s: Session): void {
  const proj = byId('pane-project');
  proj.textContent = projectName(s);
  proj.title = `${s.cwd}\n点击复制路径`;
  proj.dataset.cwd = s.cwd;
  byId('pane-label').textContent = s.label;
  byId('pane-ro').hidden = !s.readOnly;
  const wtTag = byId('pane-wt');
  wtTag.hidden = !s.worktree;
  wtTag.textContent = s.worktree ? `⑂ ${s.worktree.branch}` : '';
  wtTag.title = s.worktree ? `独立工作区：${s.worktree.path}` : '';

  // 状态只写图标与文字，持续时间放进悬停提示（属性面板状态分区也有）
  const pill = byId('pane-status');
  pill.innerHTML = '';
  pill.appendChild(statusIcon(s.status));
  pill.append(STATUS_TEXT[s.status]);
  pill.title = `已持续 ${longDuration(Date.now() - s.statusSince)} · 进入当前状态于 ${new Date(s.statusSince).toLocaleString()}`;

  // 会话头右侧：续接类主操作由页头操作注册表生成，其余收进「⋯」菜单；菜单打开期间不重建，避免菜单被替换
  if (!paneMenuOpenFor(s.id)) {
    const more = renderPaneMenuButton(s);
    byId('pane-actions').replaceChildren(...renderEach(paneActions(), s, (a, x) => a.render(x)), ...(more ? [more] : []));
  }
  renderPermissionBar(s);

  const footer = byId('pane-footer');
  footer.hidden = !s.readOnly;
  if (s.readOnly && !footer.dataset.built) renderReadOnlyNote(footer);

  // 当前标签已注销或对该会话不可用时退回终端
  const tabs = detailTabs().filter(t => isAvailable(t, s));
  let active = tabs.find(t => detailTabKey(t) === state.paneTab);
  if (!active || !active.create) {
    if (state.paneTab !== TERM) state.paneTab = TERM;
    active = undefined;
  }
  syncTabButtons(s);
  const multi = isMultiPane();
  byId('main-pane').classList.toggle('mp-on', multi);
  for (const t of detailTabs()) {
    if (!t.create) continue;
    const host = document.getElementById(hostId(t));
    if (host) host.hidden = t !== active;
  }
  if (multi) {
    // 多窗格：终端标签显示窗格网格（续接卡片在各自窗格内）；其他标签占满详情区，网格保留在后台
    syncCover(null);
    byId('term-card').hidden = true;
    if (!active) {
      hideActiveView();
      renderPaneGrid();
      return;
    }
    hidePaneGrid(false);
    syncPaneChrome({ kind: 'tab', tab: detailTabKey(active), title: active.title });
  } else {
    hidePaneGrid(true);
    syncPaneChrome({ kind: 'single' });
    // 终端标签下若有替代内容（无进程的待续接行等），显示替代内容而不挂终端
    const cover = active ? null : renderEach(termCovers(), s, (c, x) => c.render(x))[0] ?? null;
    syncCover(cover);
    byId('term-card').hidden = !!active || !!cover;
    if (!active) {
      hideActiveView();
      if (!cover) mountTerminal(s);
      return;
    }
  }
  // 终端隐藏期间不挂载、不 fit（宿主 0×0 时 fit 会把 PTY 缩成极小尺寸），切回时由尺寸监听重新适配
  const key = detailTabKey(active);
  const view = ensureView(active);
  if (shown && shown.tab !== key) hideActiveView();
  if (!shown || shown.session !== s.id) {
    shown = { tab: key, session: s.id };
    view.show(s);
  } else {
    view.update(s);
  }
}

function isAvailable(t: DetailTab, s: Session): boolean {
  try { return t.available ? t.available(s) : true; } catch { return false; }
}

/** 只读会话的底部一行说明：「接管并续接」点击后转给页头的同名按钮，走同一套确认流程 */
function renderReadOnlyNote(footer: HTMLElement): void {
  footer.dataset.built = '1';
  footer.title = '面板重启后认领的孤儿会话：可查看状态，输入请回到原终端，或接管后在面板里继续';
  const link = el('button', 'ro-link', '接管并续接') as HTMLButtonElement;
  link.type = 'button';
  link.addEventListener('click', () => document.getElementById('pane-takeover')?.click());
  footer.replaceChildren(el('span', '', '只读 · 输入请回到原终端，或'), link);
}

/** 终端替代内容的宿主 #term-cover：按需创建在终端卡片之后；cover 为 null 时隐藏并清空 */
function syncCover(cover: HTMLElement | null): void {
  let host = document.getElementById('term-cover');
  if (!host) {
    if (!cover) return;
    host = el('div', 'term-cover');
    host.id = 'term-cover';
    byId('term-card').after(host);
  }
  host.hidden = !cover;
  host.replaceChildren(...(cover ? [cover] : []));
}

const hostId = (t: DetailTab): string => `${detailTabKey(t)}-host`;

/** 标签按钮按注册表生成，排在提示文字之前；id 固定为 tab-<名称>，数字区为 tab-<名称>-stat */
function syncTabButtons(s: Session | undefined): void {
  const bar = byId('pane-tabs');
  const keep = new Set<Element>();
  let prev: Element | null = null;
  for (const t of detailTabs()) {
    const key = detailTabKey(t);
    let btn = document.getElementById(`tab-${key}`);
    if (!btn) {
      btn = el('button', 'pane-tab', t.title);
      btn.id = `tab-${key}`;
      (btn as HTMLButtonElement).type = 'button';
      btn.setAttribute('role', 'tab');
      if (t.stat) btn.appendChild(el('span', 'tab-stat')).id = `tab-${key}-stat`;
      btn.addEventListener('click', () => setPaneTab(key));
    }
    // 只在位置不对时移动：移动会让按钮失去焦点
    const at: Element | null = prev ? prev.nextElementSibling : bar.firstElementChild;
    if (at !== btn) bar.insertBefore(btn, at);
    prev = btn;
    keep.add(btn);
    const on = state.paneTab === key;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-selected', String(on));
    if (!s) continue;
    btn.hidden = !isAvailable(t, s);
    const stat = document.getElementById(`tab-${key}-stat`);
    if (t.stat && stat) {
      const node = renderEach([t], s, (x, y) => x.stat!(y))[0];
      stat.replaceChildren(...(node ? [node] : []));
    }
    if (t.tooltip) btn.title = renderEach([t], s, (x, y) => x.tooltip!(y))[0] ?? '';
  }
  for (const b of [...bar.querySelectorAll('.pane-tab')]) if (!keep.has(b)) b.remove();
}

function ensureView(t: DetailTab): DetailTabView {
  const key = detailTabKey(t);
  let view = views.get(key);
  if (!view) {
    let host = document.getElementById(hostId(t));
    if (!host) {
      host = el('div', 'tab-host');
      host.id = hostId(t);
      byId('permission-bar').before(host);
    }
    view = t.create!(host);
    views.set(key, view);
  }
  return view;
}

function hideActiveView(): void {
  if (shown === null) return;
  const view = views.get(shown.tab);
  shown = null;
  view?.hide();
}

/** 切换详情标签；切到非终端标签时把键盘焦点交给标签内容，切回终端时聚焦终端 */
export function setPaneTab(tab: string): void {
  const s = selectedSession();
  if (!s) return;
  if (tab !== TERM && !detailTab(tab)?.create) return;
  // 子代理视图没有标签页：先回到父会话再切换
  const fromSubagent = state.selectedSubagent !== null;
  state.selectedSubagent = null;
  if (state.paneTab === tab && !fromSubagent) {
    if (tab !== TERM) views.get(tab)?.focus();
    return;
  }
  state.paneTab = tab;
  state.paneTabBySession.set(s.id, tab);
  if (tab === TERM) state.pendingFocusId = s.id;
  render();
  if (tab !== TERM) views.get(tab)?.focus();
}

/** 生成标签按钮，并把非终端标签的聚焦逻辑注入终端模块；内置标签注册后、启动时调用一次 */
export function initDetailPane(): void {
  syncTabButtons(undefined);
  // 非终端标签下终端隐藏，焦点交给该标签的内容
  setPaneFocusHandler(id => {
    if (!shown || state.paneTab !== shown.tab || shown.session !== id) return false;
    views.get(shown.tab)?.focus();
    return true;
  });
}
