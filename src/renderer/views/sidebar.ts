import type { Session, SubagentEntry } from '../../shared/types';
import type { FilterKey } from '../../shared/filters.js';
import { summarize } from '../../shared/filters.js';
import type { GroupKey } from '../../shared/session-view.js';
import { groupSessions, longDuration } from '../../shared/session-view.js';
import { api } from '../core/api.js';
import { dbg } from '../core/debug.js';
import { byId, el, statusIcon } from '../core/dom.js';
import { FILTER_LABELS, projectName, SUB_ICON_STATUS, SUBAGENT_STATUS_TEXT, subagentTitle } from '../core/labels.js';
import { dragSession, isMultiPane, paneOfSession } from '../core/panes.js';
import { render } from '../core/render.js';
import { toggleInspector } from '../core/review-layout.js';
import { state, visibleSessions } from '../core/state.js';
import { focusUrgent, selectSession, selectSubagent, toggleCollapsed } from '../actions/selection.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 侧栏：导航轨徽标、状态筛选、会话列表（分组、父子行）。
 * 会话行只显示状态图标与会话名，目录、时长、改动、验证等信息在右侧属性面板查看，悬停提示保留目录与时长。
 */

export function renderRail(): void {
  const waiting = state.sessions.filter(s =>
    (s.status === 'waiting_permission' || s.status === 'waiting_input') && !s.readOnly).length;
  const badge = byId('inbox-badge');
  badge.hidden = waiting === 0;
  badge.textContent = waiting > 9 ? '9+' : String(waiting);
}

/** 会话数达到这个值才常驻显示筛选条；列表本身已按状态分组，会话少时筛选与分组重复 */
export const FILTER_BAR_MIN = 9;

/**
 * 筛选条：会话不足 FILTER_BAR_MIN 个且没有生效的筛选时整条隐藏（命令面板「筛选：…」仍可用）；
 * 计数为 0 的筛选片不显示，「全部」与当前生效的筛选片例外。
 */
export function renderFilters(): void {
  const bar = byId('sidebar-filters');
  bar.innerHTML = '';
  bar.hidden = state.sessions.length < FILTER_BAR_MIN && state.activeFilter === 'all';
  const counts = summarize(state.sessions);
  for (const key of Object.keys(FILTER_LABELS) as FilterKey[]) {
    if (counts[key] === 0 && key !== 'all' && state.activeFilter !== key) continue;
    const chip = el('button', state.activeFilter === key ? 'on' : '') as HTMLButtonElement;
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(state.activeFilter === key));
    chip.append(FILTER_LABELS[key]);
    chip.appendChild(el('span', 'n', String(counts[key])));
    chip.addEventListener('click', () => {
      state.activeFilter = state.activeFilter === key ? 'all' : key;   // 再点同片取消回全部
      dbg('ui', `过滤 → ${state.activeFilter}`);
      render();
    });
    bar.appendChild(chip);
  }
}

export function renderSidebar(): void {
  const list = byId('session-list');
  const scrollTop = list.scrollTop;          // 整列表重建前先记滚动位置，重建后还原
  list.innerHTML = '';
  byId('sidebar-count').textContent = String(state.sessions.length);

  const vis = visibleSessions();
  if (vis.length === 0) {
    list.appendChild(el('div', 'list-empty',
      state.sessions.length === 0 ? '还没有会话\n在右侧输入任务即可新建' : '当前筛选下没有会话'));
    return;
  }

  for (const group of groupSessions(vis)) {
    list.appendChild(renderGroupHeader(group));
    for (const s of group.sessions) {
      list.appendChild(renderSessionItem(s, vis.indexOf(s)));
      // 折叠的父会话：跳过其子代理的渲染（不影响选中态/右侧视图）
      if (state.collapsedSessions.has(s.id)) continue;
      const subs = s.subagents ?? [];
      subs.forEach((sub, i) => list.appendChild(renderSubagentItem(s, sub, i === subs.length - 1)));
    }
  }
  list.scrollTop = scrollTop;
}

function renderGroupHeader(group: { key: GroupKey; title: string; sessions: Session[] }): HTMLElement {
  // 分组头只是一行弱化的「标题 计数」小字，与会话行在字号、颜色上拉开，不用图标与分隔线
  const head = el('div', 'gh');
  head.dataset.group = group.key;
  head.appendChild(el('span', 'gh-t', group.title));
  head.appendChild(el('span', 'c', String(group.sessions.length)));
  return head;
}

/** 行尾的窗格标记：网格小图标 */
function paneMark(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'mp-mark');
  svg.setAttribute('viewBox', '0 0 14 14');
  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = '正在窗格中显示';
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#s-mp-grid');
  svg.append(title, use);
  return svg;
}

/** 会话行；index 为该会话在当前可见列表里的位置，前 9 个在悬停提示里写出 Ctrl+数字 */
function renderSessionItem(s: Session, index: number): HTMLElement {
  const item = el('div', 'row');
  if (s.id === state.selectedId && !state.selectedSubagent) item.classList.add('sel');
  if (s.escalated) item.classList.add('escalated');
  if (s.readOnly) item.classList.add('readonly');
  item.dataset.sessionId = s.id;
  item.dataset.role = 'parent';

  item.appendChild(statusIcon(s.status));

  const subs = s.subagents ?? [];
  if (subs.length > 0) {
    const collapsed = state.collapsedSessions.has(s.id);
    const chev = el('button', `chev${collapsed ? ' collapsed' : ''}`) as HTMLButtonElement;
    chev.appendChild(chevIcon());
    chev.type = 'button';
    chev.title = collapsed ? `展开 ${subs.length} 个子代理` : '折叠子代理';
    chev.setAttribute('aria-expanded', String(!collapsed));
    chev.addEventListener('click', e => { e.stopPropagation(); toggleCollapsed(s.id); });
    item.appendChild(chev);
    if (!collapsed) item.classList.add('open');
  } else {
    item.appendChild(el('span', 'chev-sp'));
  }

  item.appendChild(el('span', 't', s.label));
  // 多窗格时正在某个窗格显示的会话，行尾显示网格小图标
  if (isMultiPane() && paneOfSession(s.id)) item.appendChild(paneMark());
  if (dragSession() === s.id) item.classList.add('mp-src');

  const subHint = subs.length > 0 ? ` · ${subs.length} 个子代理` : '';
  const wtHint = s.worktree ? ` · 独立工作区 ${s.worktree.branch}` : '';
  const keyHint = index >= 0 && index < 9 ? ` · Ctrl+${index + 1}` : '';
  item.title = `${projectName(s)} · ${s.cwd} · 当前状态已持续 ${longDuration(Date.now() - s.statusSince)}${subHint}${wtHint}${keyHint}`;
  item.addEventListener('click', () => selectSession(s.id));
  return item;
}

/** 折叠箭头：细线 V 形，展开朝下，折叠时由样式旋转朝右 */
function chevIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', 'M2.5 3.75 5 6.25l2.5-2.5');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.4');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p);
  return svg;
}

/** 子代理行：缩进挂在父会话下，左侧树形连线；last 为父会话下最后一个子代理，竖线在该行收尾 */
function renderSubagentItem(parent: Session, sub: SubagentEntry, last: boolean): HTMLElement {
  const isSelected = state.selectedSubagent?.sessionId === parent.id && state.selectedSubagent.agentId === sub.agentId;
  const item = el('div', `row kid${isSelected ? ' sel' : ''}${last ? ' last' : ''}`);
  item.dataset.sessionId = parent.id;
  item.dataset.agentId = sub.agentId;
  item.dataset.role = 'child';

  item.appendChild(statusIcon(SUB_ICON_STATUS[sub.status]));
  item.appendChild(el('span', 't', subagentTitle(sub)));

  // 已结束的条目才能手动关闭：运行中的交给 tracker 拒绝，这里直接不渲染按钮
  if (sub.status !== 'running') {
    const close = el('button', 'kid-close', '✕') as HTMLButtonElement;
    close.type = 'button';
    close.title = '关闭（从列表移除）';
    close.addEventListener('click', e => {
      e.stopPropagation();
      void api().dismissSubagent(parent.id, sub.agentId);
    });
    item.appendChild(close);
  }

  item.title = `${sub.agentType} · ${SUBAGENT_STATUS_TEXT[sub.status]} · 已持续 ${longDuration(Date.now() - sub.statusSince)}`;
  item.addEventListener('click', e => { e.stopPropagation(); selectSubagent(parent.id, sub.agentId); });
  return item;
}

/** 绑定导航轨按钮：命令面板、跳到待处理、属性面板显隐 */
export function initRail(onOpenPalette: () => void): void {
  byId('btn-palette').addEventListener('click', () => onOpenPalette());
  byId('btn-inbox').addEventListener('click', () => {
    if (!focusUrgent()) {
      state.activeFilter = 'attention';
      render();
    }
  });
  byId('btn-inspector').addEventListener('click', () => toggleInspector());
}
