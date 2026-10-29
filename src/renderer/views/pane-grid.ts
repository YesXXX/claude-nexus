import type { Session } from '../../shared/types';
import { longDuration } from '../../shared/session-view.js';
import type { Edge, PaneLeaf, PaneNode } from '../../shared/pane-layout.js';
import { findLeaf, leaves, structureKey } from '../../shared/pane-layout.js';
import type { GridSize, Rect, SplitCheck } from '../../shared/pane-geometry.js';
import { APPROVE_BAR_PX, gridOf, layoutRects, minGrid, splitFeasible } from '../../shared/pane-geometry.js';
import { byId, el, statusIcon } from '../core/dom.js';
import { projectName, STATUS_TEXT } from '../core/labels.js';
import { isMaximized, isMultiPane, paneLayout, setPickTarget } from '../core/panes.js';
import { renderEach, termCovers } from '../core/registry.js';
import { render } from '../core/render.js';
import { findSession, state } from '../core/state.js';
import { claimHost, releaseHost } from '../term/host.js';
import { cellMetrics, measurePaneHost, observePaneHost, unobservePaneHost } from '../term/pane-fit.js';
import { mountTerminalIn } from '../term/terminals.js';
import { closePane, focusPane, splitPane, toggleMaximize } from '../actions/layout-actions.js';
import { syncPaneChrome } from './pane-chrome.js';
import { createDegradeWatch } from './pane-degrade.js';
import { bindDivider } from './pane-divider.js';
import { openPalette } from './palette.js';
import { inlineApproveKey, needsInlineApprove, renderInlineApprove } from './permission-bar.js';

/**
 * 终端区多窗格网格：按布局树渲染窗格与分隔条，每个窗格一个宿主挂各自会话的 xterm。
 * 每秒一次的渲染必须幂等：结构不变时不重建 DOM、不移动 xterm、不 fit，只更新文本与类名；
 * 窗格元素按窗格 id 缓存复用，结构变化时只重排容器，终端始终留在自己的宿主里。
 */

type Act = 'split-right' | 'split-down' | 'max' | 'close';
type Mode = 'grid' | 'max' | 'narrow';

interface PaneDom {
  root: HTMLElement;
  icon: SVGSVGElement;
  iconStatus: string;
  title: HTMLElement;
  proj: HTMLElement;
  st: HTMLElement;
  btn: Record<Act, HTMLButtonElement>;
  approve: HTMLElement;
  approveKey: string;
  host: HTMLElement;
  cover: HTMLElement;
  empty: HTMLElement;
  emptySub: HTMLElement;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const SPLIT_TITLE: Record<'right' | 'bottom', string> = {
  right: '向右拆出新窗格（也可把侧栏会话拖到窗格右缘）',
  bottom: '向下拆出新窗格（也可把侧栏会话拖到窗格下缘）',
};

const panes = new Map<string, PaneDom>();
const splitEls = new Map<string, HTMLElement>();
let lastKey = '';
let lastSig = '';
let disposed = true;
let areaRo: ResizeObserver | null = null;

const degrade = createDegradeWatch({ measure: measureVisible, estimate: estimateWorst, onChange: render });

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function icon(sym: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('viewBox', '0 0 14 14');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${sym}`);
  svg.appendChild(use);
  return svg;
}

function onAct(paneId: string, act: Act): void {
  if (act === 'split-right') splitPane(paneId, 'right');
  else if (act === 'split-down') splitPane(paneId, 'bottom');
  else if (act === 'close') closePane(paneId);
  else {
    if (paneLayout().focus !== paneId) focusPane(paneId);
    toggleMaximize();
  }
}

/** 空占位：记住目标窗格，打开命令面板的会话分组，选中的会话放进这个窗格 */
function pickFor(paneId: string): void {
  setPickTarget(paneId);
  openPalette({ section: '会话' });
}

/** 点击窗格即聚焦：按下时先切焦点，同一次点击随后照常落到 xterm 上 */
function onPanePointer(paneId: string, e: PointerEvent): void {
  if (e.button !== 0 || (e.target as HTMLElement | null)?.closest('button, .mp-empty-in')) return;
  const leaf = findLeaf(paneLayout().root, paneId);
  if (leaf?.sid && (leaf.sid !== state.selectedId || state.selectedSubagent)) focusPane(paneId);
}

function createPane(id: string): PaneDom {
  const root = el('div', 'term-card mp-pane');
  root.dataset.paneId = id;
  const head = el('div', 'mp-h');
  const ic = statusIcon('disconnected');
  const title = el('span', 'mp-t');
  const proj = el('span', 'mp-proj');
  const st = el('span', 'mp-st');
  head.append(ic, title, proj, st, el('span', 'mp-gap'));
  const mk = (act: Act, sym: string, tip: string, cls = ''): HTMLButtonElement => {
    const b = el('button', `mp-ib${cls}`);
    b.type = 'button';
    b.dataset.act = act;
    b.title = tip;
    b.appendChild(icon(sym));
    b.addEventListener('click', e => { e.stopPropagation(); onAct(id, act); });
    head.appendChild(b);
    return b;
  };
  const btn: Record<Act, HTMLButtonElement> = {
    'split-right': mk('split-right', 's-mp-r', SPLIT_TITLE.right),
    'split-down': mk('split-down', 's-mp-d', SPLIT_TITLE.bottom),
    max: mk('max', 's-mp-max', '最大化 / 还原（Ctrl ⇧ M）'),
    close: mk('close', 's-mp-x', '关闭窗格（会话继续在后台运行，不结束）', ' x'),
  };
  const approve = el('div', 'mp-approve');
  approve.hidden = true;
  const host = el('div', 'terminal-host');
  const cover = el('div', 'term-cover');
  cover.hidden = true;
  const empty = el('div', 'mp-empty');
  empty.hidden = true;
  const inner = el('div', 'mp-empty-in');
  const emptySub = el('span', 'mp-empty-sub');
  inner.append(el('span', 'mp-empty-plus', '＋'), el('span', '', '拖入会话或点此选择'), emptySub);
  inner.addEventListener('click', () => pickFor(id));
  empty.appendChild(inner);
  root.append(head, approve, host, cover, empty);
  root.addEventListener('pointerdown', e => onPanePointer(id, e), true);
  observePaneHost(host);
  const dom: PaneDom = { root, icon: ic, iconStatus: 'disconnected', title, proj, st, btn, approve, approveKey: '', host, cover, empty, emptySub };
  panes.set(id, dom);
  return dom;
}

/** 结构变化：移除已不存在的窗格，按树重建拆分容器与分隔条，复用已有窗格元素 */
function rebuild(area: HTMLElement, root: PaneNode): void {
  const live = new Set(leaves(root).map(l => l.id));
  for (const [id, dom] of panes) {
    if (live.has(id)) continue;
    unobservePaneHost(dom.host);
    releaseHost(dom.host);
    dom.root.remove();
    panes.delete(id);
  }
  splitEls.clear();
  const build = (node: PaneNode, path: number[]): HTMLElement => {
    if (node.t === 'leaf') return (panes.get(node.id) ?? createPane(node.id)).root;
    const key = path.join('.');
    const wrap = el('div', `mp-split mp-${node.dir}`);
    wrap.dataset.path = key;
    splitEls.set(key, wrap);
    node.children.forEach((c, i) => {
      if (i > 0) {
        const d = el('div', 'mp-div');
        d.dataset.path = key;
        d.dataset.index = String(i - 1);
        bindDivider(d);
        wrap.appendChild(d);
      }
      wrap.appendChild(build(c, [...path, i]));
    });
    return wrap;
  };
  area.replaceChildren(build(root, []));
}

function splitKids(wrap: HTMLElement): HTMLElement[] {
  return [...wrap.children].filter(c => !c.classList.contains('mp-div')) as HTMLElement[];
}

function writeGrow(node: PaneNode, path: number[]): void {
  if (node.t === 'leaf') return;
  const wrap = splitEls.get(path.join('.'));
  if (!wrap) return;
  const kids = splitKids(wrap);
  node.sizes.forEach((size, i) => {
    const k = kids[i];
    const v = String(size);
    if (k && k.dataset.grow !== v) {
      k.dataset.grow = v;
      k.style.flexGrow = v;
    }
  });
  node.children.forEach((c, i) => writeGrow(c, [...path, i]));
}

/** 最大化与退化时只保留焦点窗格及其祖先容器，其余窗格与分隔条隐藏（不移动 DOM） */
function applyVisibility(node: PaneNode, path: number[], visible: ReadonlySet<string>, grid: boolean): boolean {
  if (node.t === 'leaf') {
    const dom = panes.get(node.id);
    const vis = visible.has(node.id);
    if (dom && dom.root.hidden === vis) dom.root.hidden = !vis;
    return vis;
  }
  const wrap = splitEls.get(path.join('.'));
  let any = false;
  node.children.forEach((c, i) => { if (applyVisibility(c, [...path, i], visible, grid)) any = true; });
  if (wrap) {
    if (wrap.hidden === any) wrap.hidden = !any;
    for (const d of wrap.querySelectorAll<HTMLElement>(':scope > .mp-div')) if (d.hidden === grid) d.hidden = !grid;
  }
  return any;
}

function toRect(r: DOMRect): Rect {
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** 按布局树估算各窗格矩形：多窗格用网格区域，单窗格用终端卡片或续接卡片 */
function paneRects(): Map<string, Rect> {
  const layout = paneLayout();
  if (isMultiPane()) {
    const area = byId('pane-area');
    return area.hidden ? new Map() : layoutRects(layout.root, toRect(area.getBoundingClientRect()));
  }
  const target = singleTarget();
  return target ? new Map([[(layout.root as PaneLeaf).id, toRect(target.getBoundingClientRect())]]) : new Map();
}

function singleTarget(): HTMLElement | null {
  const card = byId('term-card');
  if (!card.hidden) return card;
  const cover = document.getElementById('term-cover');
  return cover && !cover.hidden ? cover : null;
}

function checkWith(rects: Map<string, Rect>, paneId: string, edge: Edge, movingSid: string | null): SplitCheck {
  return splitFeasible(paneLayout(), paneId, edge, rects, cellMetrics(), movingSid);
}

/** 在窗格某一侧拆分是否可行（数量与拆分后的尺寸）；拖放与窗格头按钮共用 */
export function splitCheck(paneId: string, edge: Edge, movingSid: string | null): SplitCheck {
  return checkWith(paneRects(), paneId, edge, movingSid);
}

function reasonText(c: SplitCheck): string {
  if (c.ok) return '';
  if (c.reason === 'full') return '已达 4 个窗格上限';
  if (c.reason === 'small') return `窗格太小，拆分后约 ${c.cols} 列 × ${c.rows} 行`;
  return '';
}

/** 非焦点窗格里的会话在等批准：显示内联批准条（焦点窗格仍用底部审批条） */
function isAttn(s: Session, isFocus: boolean): boolean {
  return !isFocus && s.id !== state.selectedId && needsInlineApprove(s);
}

function updatePane(leaf: PaneLeaf, isFocus: boolean, visible: boolean, rects: Map<string, Rect>): void {
  const dom = panes.get(leaf.id);
  if (!dom) return;
  const s = leaf.sid ? findSession(leaf.sid) : undefined;
  if (dom.root.dataset.sessionId !== (s?.id ?? '')) dom.root.dataset.sessionId = s?.id ?? '';
  const attn = !!s && isAttn(s, isFocus);
  dom.root.classList.toggle('focus', isFocus);
  dom.root.classList.toggle('attn', attn);
  dom.root.classList.toggle('empty', !s);

  const status = s ? s.status : 'disconnected';
  if (dom.iconStatus !== status) {
    const next = statusIcon(status);
    dom.icon.replaceWith(next);
    dom.icon = next;
    dom.iconStatus = status;
  }
  setText(dom.title, s ? s.label : '（空窗格）');
  // 窗格头只留状态图标与会话名；项目、目录、状态与时长放进悬停提示，等待批准与空占位才写出状态文字
  dom.title.title = s ? `${projectName(s)} · ${s.cwd} · ${STATUS_TEXT[s.status]} · ${longDuration(Date.now() - s.statusSince)}` : '';
  setText(dom.proj, '');
  setText(dom.st, s ? (attn ? STATUS_TEXT[s.status] : '') : leaf.lost ? '原会话已不存在' : '未放入会话');

  if (attn) {
    const key = inlineApproveKey(s);
    if (key !== dom.approveKey) {
      dom.approve.replaceChildren(...renderInlineApprove(s));
      dom.approveKey = key;
    }
    if (dom.approve.hidden) dom.approve.hidden = false;
  } else if (!dom.approve.hidden) {
    dom.approve.hidden = true;
    dom.approve.replaceChildren();
    dom.approveKey = '';
  }

  const cover = s ? renderEach(termCovers(), s, (c, x) => c.render(x))[0] ?? null : null;
  const body = !s ? 'empty' : cover ? 'cover' : 'term';
  if (dom.empty.hidden !== (body !== 'empty')) dom.empty.hidden = body !== 'empty';
  if (dom.cover.hidden !== (body !== 'cover')) dom.cover.hidden = body !== 'cover';
  if (dom.host.hidden !== (body !== 'term')) dom.host.hidden = body !== 'term';
  if (body === 'empty') {
    setText(dom.emptySub, leaf.lost ? `原会话「${leaf.lost}」已不存在` : '也可以把侧栏会话拖到这里');
    releaseHost(dom.host);
  } else if (body === 'cover') {
    dom.cover.replaceChildren(cover as HTMLElement);
    releaseHost(dom.host);
  } else if (s) {
    claimHost(dom.host, s.id);
    const host = dom.host;
    if (visible) mountTerminalIn(s, host, () => host.isConnected && host.dataset.owner === s.id && !host.closest('[hidden]'), 'observer');
  }

  dom.btn.max.hidden = body !== 'term';
  dom.btn.max.title = isMaximized() ? '还原窗格布局（Ctrl ⇧ M）' : '最大化当前窗格（Ctrl ⇧ M）';
  dom.btn['split-right'].hidden = body === 'cover';
  dom.btn['split-down'].hidden = body === 'cover';
  for (const [act, edge] of [['split-right', 'right'], ['split-down', 'bottom']] as const) {
    const b = dom.btn[act];
    const chk = checkWith(rects, leaf.id, edge, null);
    if (b.disabled === chk.ok) b.disabled = !chk.ok;
    const tip = chk.ok ? SPLIT_TITLE[edge] : `不能拆分：${reasonText(chk)}`;
    if (b.title !== tip) b.title = tip;
  }
}

/** 输入法组字框锚在焦点窗格宿主的左下角附近（单窗格时 CSS 变量未设置，沿用原值） */
function syncIme(): void {
  const dom = panes.get(paneLayout().focus);
  if (!dom || dom.host.hidden) return;
  const r = dom.host.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return;
  const app = byId('app');
  const left = `${Math.round(r.left + 19)}px`;
  const bottom = `${Math.round(window.innerHeight - r.bottom + 13)}px`;
  if (app.style.getPropertyValue('--ime-left') !== left) app.style.setProperty('--ime-left', left);
  if (app.style.getPropertyValue('--ime-bottom') !== bottom) app.style.setProperty('--ime-bottom', bottom);
}

function measureVisible(): GridSize[] {
  if (byId('pane-area').dataset.mode !== 'grid') return [];
  const m = cellMetrics();
  const out: GridSize[] = [];
  for (const dom of panes.values()) {
    if (dom.root.hidden || !dom.root.isConnected) continue;
    const measured = dom.host.hidden ? null : measurePaneHost(dom.host);
    if (measured) { out.push(measured); continue; }
    const r = dom.root.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.push(gridOf(toRect(r), m, dom.approve.hidden ? 0 : APPROVE_BAR_PX));
  }
  return out;
}

function estimateWorst(): GridSize | null {
  const area = byId('pane-area');
  if (area.hidden) return null;
  const r = area.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  const layout = paneLayout();
  const rects = layoutRects(layout.root, toRect(r));
  const m = cellMetrics();
  const sizes: GridSize[] = [];
  for (const leaf of leaves(layout.root)) {
    const rect = rects.get(leaf.id);
    if (!rect) continue;
    const s = leaf.sid ? findSession(leaf.sid) : undefined;
    const extra = s && isAttn(s, leaf.id === layout.focus) ? APPROVE_BAR_PX : 0;
    sizes.push(gridOf(rect, m, extra));
  }
  return minGrid(sizes);
}

function observeArea(area: HTMLElement): void {
  if (areaRo) return;
  areaRo = new ResizeObserver(() => {
    if (disposed) return;
    degrade.schedule();
    syncIme();
  });
  areaRo.observe(area);
}

/** 多窗格的终端标签：对账布局树并更新每个窗格 */
export function renderPaneGrid(): void {
  const area = byId('pane-area');
  releaseHost(byId('terminal-host'));
  if (area.hidden) area.hidden = false;
  disposed = false;
  observeArea(area);
  const layout = paneLayout();
  const key = structureKey(layout.root);
  if (key !== lastKey) {
    rebuild(area, layout.root);
    lastKey = key;
  }
  writeGrow(layout.root, []);
  const mode: Mode = degrade.degraded() ? 'narrow' : isMaximized() ? 'max' : 'grid';
  if (area.dataset.mode !== mode) area.dataset.mode = mode;
  const all = leaves(layout.root);
  const visible = new Set(mode === 'grid' ? all.map(l => l.id) : [layout.focus]);
  applyVisibility(layout.root, [], visible, mode === 'grid');
  const rects = paneRects();
  for (const leaf of all) updatePane(leaf, leaf.id === layout.focus, visible.has(leaf.id), rects);
  syncIme();
  syncPaneChrome(mode === 'narrow' ? { kind: 'narrow', worst: degrade.worst() } : { kind: mode });
  const attn = all.filter(l => panes.get(l.id)?.root.classList.contains('attn')).map(l => l.id);
  const sig = `${key}|${mode}|${[...visible].join(',')}|${attn.join(',')}`;
  if (sig !== lastSig) {
    lastSig = sig;
    degrade.schedule();
  }
}

/** 隐藏网格；dispose 时释放窗格宿主并销毁窗格 DOM（回到单窗格） */
export function hidePaneGrid(dispose: boolean): void {
  const area = byId('pane-area');
  if (!area.hidden) area.hidden = true;
  if (!dispose || disposed) return;
  disposed = true;
  for (const dom of panes.values()) {
    unobservePaneHost(dom.host);
    releaseHost(dom.host);
  }
  panes.clear();
  splitEls.clear();
  lastKey = '';
  lastSig = '';
  area.replaceChildren();
  delete area.dataset.mode;
  degrade.reset();
  const app = byId('app');
  app.style.removeProperty('--ime-left');
  app.style.removeProperty('--ime-bottom');
}

/** 拖放目标：多窗格为可见窗格，单窗格为终端卡片或续接卡片；非终端标签、子代理视图时为空 */
export function paneTargets(): Array<{ paneId: string; el: HTMLElement }> {
  if (!state.selectedId || state.selectedSubagent || state.paneTab !== 'term' || byId('main-pane').hidden) return [];
  if (isMultiPane()) {
    if (byId('pane-area').hidden) return [];
    return [...panes].filter(([, d]) => !d.root.hidden && d.root.isConnected).map(([paneId, d]) => ({ paneId, el: d.root }));
  }
  const target = singleTarget();
  return target ? [{ paneId: (paneLayout().root as PaneLeaf).id, el: target }] : [];
}
