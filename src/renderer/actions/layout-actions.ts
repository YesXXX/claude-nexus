import type { DropZone, Edge } from '../../shared/pane-layout.js';
import {
  closeLeaf, dropSession, equalizeAll, equalizeSplit, findLeaf, resizeSplit, splitLeaf,
} from '../../shared/pane-layout.js';
import { layoutRects, neighborPane } from '../../shared/pane-geometry.js';
import {
  commitLayout, focusedLeaf, isMaximized, isMultiPane, paneLayout, setMaximized,
} from '../core/panes.js';
import { render } from '../core/render.js';
import { state } from '../core/state.js';
import { selectSession } from './selection.js';

/**
 * 窗格布局的用户操作：聚焦、拆分、关闭、放置、最大化与调整比例。
 * 焦点变化一律通过 selectSession 落到 state.selectedId，保持「焦点窗格 = 选中会话」。
 */

/** 选中并聚焦会话（终端挂好后由 pendingFocusId 交给 xterm） */
function selectAndFocus(sid: string): void {
  if (state.selectedId === sid && !state.selectedSubagent) {
    render();
    return;
  }
  state.pendingFocusId = sid;
  selectSession(sid);
}

/** 聚焦窗格：有会话时选中它；空占位忽略 */
export function focusPane(paneId: string): void {
  const leaf = findLeaf(paneLayout().root, paneId);
  if (!leaf?.sid || (state.selectedId === leaf.sid && !state.selectedSubagent)) return;
  state.pendingFocusId = leaf.sid;
  selectSession(leaf.sid);
}

/** 按几何位置把焦点移到方向上的相邻窗格；空占位不作为目标。没有目标返回 false */
export function moveFocus(dir: Edge): boolean {
  const layout = paneLayout();
  const all = layoutRects(layout.root, { x: 0, y: 0, w: 1000, h: 1000 }, 0);
  const rects = new Map([...all].filter(([id]) => id === layout.focus || !!findLeaf(layout.root, id)?.sid));
  const target = neighborPane(rects, layout.focus, dir);
  if (!target) return false;
  focusPane(target);
  return true;
}

/** 在窗格一侧新开空占位；只检查数量，尺寸是否足够由调用方判断 */
export function splitPane(paneId: string, edge: Edge): boolean {
  const next = splitLeaf(paneLayout(), paneId, edge, null);
  if (!next) return false;
  setMaximized(false);
  commitLayout(next);
  render();
  return true;
}

/** 关闭窗格（会话继续在后台运行）；焦点变化时选中新焦点窗格的会话 */
export function closePane(paneId: string): void {
  const before = paneLayout();
  const next = closeLeaf(before, paneId);
  if (next === before) return;
  commitLayout(next);
  const sid = focusedLeaf().sid;
  if (sid && sid !== state.selectedId) {
    selectAndFocus(sid);
    return;
  }
  if (!sid && findLeaf(before.root, paneId)?.sid === state.selectedId) state.selectedId = null;
  render();
}

/** 把会话放到窗格的某个区域；放置成功后该会话成为焦点 */
export function dropOnPane(sid: string, paneId: string, zone: DropZone): boolean {
  const next = dropSession(paneLayout(), sid, paneId, zone);
  if (!next) return false;
  setMaximized(false);
  commitLayout(next);
  selectAndFocus(sid);
  return true;
}

export function toggleMaximize(): void {
  if (!isMultiPane()) return;
  setMaximized(!isMaximized());
  render();
}

/** 提示条上的会话标签：退出最大化、回到终端标签并聚焦该会话 */
export function restoreFromChip(sid: string): void {
  setMaximized(false);
  state.paneTab = 'term';
  selectAndFocus(sid);
}

export function setSplitRatio(path: number[], index: number, frac: number): void {
  const layout = paneLayout();
  if (commitLayout({ root: resizeSplit(layout.root, path, index, frac), focus: layout.focus })) render();
}

export function equalizeAt(path: number[]): void {
  const layout = paneLayout();
  if (commitLayout({ root: equalizeSplit(layout.root, path), focus: layout.focus })) render();
}

export function equalizeAllPanes(): void {
  const layout = paneLayout();
  if (commitLayout({ root: equalizeAll(layout.root), focus: layout.focus })) render();
}
