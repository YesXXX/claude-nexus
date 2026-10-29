import type { PaneNode } from '../../shared/pane-layout.js';
import { nodeAt } from '../../shared/pane-layout.js';
import type { CellMetrics } from '../../shared/pane-geometry.js';
import { gridOf, layoutRects, minExtent } from '../../shared/pane-geometry.js';
import { el } from '../core/dom.js';
import { paneLayout } from '../core/panes.js';
import { cellMetrics, setFitSuspended } from '../term/pane-fit.js';
import { equalizeAt, setSplitRatio } from '../actions/layout-actions.js';

/**
 * 窗格之间的分隔条：拖动调整相邻两侧的比例，双击恢复该层等分。
 * 拖动中只改两侧 flexGrow 与提示框，挂起终端 fit，松手后写回布局并统一 fit，
 * 避免拖动期间 Claude TUI 随每个像素连续重绘。两侧都不小于各自子树满足 60 列 × 12 行所需的尺寸。
 */

function parsePath(raw: string | undefined): number[] {
  return raw ? raw.split('.').filter(Boolean).map(Number) : [];
}

/** 子树里最小窗格的列数（左右拆分）或行数（上下拆分） */
function worstOf(node: PaneNode, w: number, h: number, m: CellMetrics, horiz: boolean): number {
  const rects = layoutRects(node, { x: 0, y: 0, w, h });
  let worst = Infinity;
  for (const r of rects.values()) {
    const g = gridOf(r, m);
    worst = Math.min(worst, horiz ? g.cols : g.rows);
  }
  return Number.isFinite(worst) ? worst : 0;
}

export function bindDivider(div: HTMLElement): void {
  div.title = '拖动调整比例 · 双击恢复等分';
  div.addEventListener('dblclick', () => equalizeAt(parsePath(div.dataset.path)));
  div.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const path = parsePath(div.dataset.path);
    const index = Number(div.dataset.index);
    const node = nodeAt(paneLayout().root, path);
    const a$ = div.previousElementSibling as HTMLElement | null;
    const b$ = div.nextElementSibling as HTMLElement | null;
    if (!node || node.t !== 'split' || !a$ || !b$ || !node.children[index + 1]) return;
    e.preventDefault();
    const horiz = node.dir === 'row';
    const ra = a$.getBoundingClientRect();
    const rb = b$.getBoundingClientRect();
    const a = horiz ? ra.width : ra.height;
    const b = horiz ? rb.width : rb.height;
    const cross = horiz ? ra.height : ra.width;
    const total = a + b;
    if (total <= 0) return;
    const m = cellMetrics();
    const axis = horiz ? 'w' : 'h';
    const minA = Math.min(a, minExtent(node.children[index], m, axis));
    const minB = Math.min(b, minExtent(node.children[index + 1], m, axis));
    const growSum = node.sizes[index] + node.sizes[index + 1];
    const start = horiz ? e.clientX : e.clientY;
    let cur = a;

    const tip = el('span', 'mp-tip');
    const showTip = (): void => {
      const dims = (len: number): [number, number] => horiz ? [len, cross] : [cross, len];
      const n = worstOf(node.children[index], ...dims(cur), m, horiz);
      const k = worstOf(node.children[index + 1], ...dims(total - cur), m, horiz);
      const [p, q, unit] = horiz ? ['左', '右', '列'] : ['上', '下', '行'];
      tip.replaceChildren(`${p} `, el('b', '', String(n)), ` ${unit} · ${q} `, el('b', '', String(k)), ` ${unit} · 双击等分`);
    };
    const apply = (): void => {
      a$.style.flexGrow = String(growSum * cur / total);
      b$.style.flexGrow = String(growSum * (total - cur) / total);
    };

    try { div.setPointerCapture(e.pointerId); } catch { /* 指针已释放时忽略 */ }
    setFitSuspended(true);
    div.classList.add('on');
    div.appendChild(tip);
    document.body.classList.add('mp-resizing', horiz ? 'mp-row-resize' : 'mp-col-resize');
    showTip();

    const move = (ev: PointerEvent): void => {
      const d = (horiz ? ev.clientX : ev.clientY) - start;
      cur = Math.min(total - minB, Math.max(minA, a + d));
      apply();
      showTip();
    };
    const finish = (): void => {
      div.removeEventListener('pointermove', move);
      div.removeEventListener('pointerup', finish);
      div.removeEventListener('pointercancel', finish);
      div.classList.remove('on');
      tip.remove();
      document.body.classList.remove('mp-resizing', 'mp-row-resize', 'mp-col-resize');
      setFitSuspended(false);
      if (cur !== a) setSplitRatio(path, index, cur / total);
    };
    div.addEventListener('pointermove', move);
    div.addEventListener('pointerup', finish);
    div.addEventListener('pointercancel', finish);
  });
}
