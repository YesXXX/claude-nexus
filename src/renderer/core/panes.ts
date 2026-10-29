import type { PaneLayout, PaneLeaf } from '../../shared/pane-layout.js';
import {
  findLeaf, focusLeaf, layoutOrDefault, leafCount, leafOfSession, leaves, normalizeLayout,
  reconcileMissing, removeSessions, replaceSession, serializeLayout, singleLayout, withLabels,
} from '../../shared/pane-layout.js';
import { loadPaneLayoutRaw, savePaneLayoutRaw } from './persist.js';
import { findSession, state } from './state.js';

/**
 * 终端区窗格布局的唯一状态：布局树、最大化、空占位的拾取目标与拖动中的会话。
 * 不变量：选中父会话且未选子代理时，焦点窗格的会话就是 state.selectedId。
 * 这里的函数都是同步的且不调用 render，由调用方决定何时重绘。
 */

let layout: PaneLayout = singleLayout(null);
/** 最近一次写入存储的序列化串：相同则不重复写 */
let saved = '';
let maximized = false;
let pickTarget: string | null = null;
let dragging: string | null = null;

/** 读取持久化布局，坏数据回退单窗格；入口在首轮渲染前调用一次 */
export function initPaneLayout(): void {
  layout = layoutOrDefault(loadPaneLayoutRaw());
  saved = serializeLayout(layout);
}

export function paneLayout(): Readonly<PaneLayout> {
  return layout;
}

export function paneCount(): number {
  return leafCount(layout.root);
}

export function isMultiPane(): boolean {
  return layout.root.t === 'split';
}

export function focusedLeaf(): PaneLeaf {
  return findLeaf(layout.root, layout.focus) ?? leaves(layout.root)[0];
}

export function paneOfSession(sid: string): PaneLeaf | undefined {
  return leafOfSession(layout.root, sid);
}

/** 规范化后替换布局；序列化结果变化才写存储，回到单窗格时清除最大化。返回是否有变化 */
export function commitLayout(next: PaneLayout): boolean {
  const norm = normalizeLayout(next);
  if (norm === layout) return false;
  layout = norm;
  if (!isMultiPane()) maximized = false;
  if (pickTarget && !findLeaf(layout.root, pickTarget)) pickTarget = null;
  const json = serializeLayout(layout);
  if (json !== saved) {
    saved = json;
    savePaneLayoutRaw(json);
  }
  return true;
}

export function isMaximized(): boolean {
  return maximized && isMultiPane();
}

/** 单窗格时忽略 */
export function setMaximized(on: boolean): void {
  maximized = on && isMultiPane();
}

/** 空占位点「选择会话」后记住目标窗格，下一次选中会话时放进这个窗格 */
export function setPickTarget(paneId: string | null): void {
  pickTarget = paneId;
}

export function hasPickTarget(): boolean {
  return pickTarget !== null;
}

export function takePickTarget(): string | null {
  const t = pickTarget;
  pickTarget = null;
  return t;
}

export function setDragSession(sid: string | null): void {
  dragging = sid;
}

export function dragSession(): string | null {
  return dragging;
}

/**
 * 打开会话：有拾取目标时放进目标窗格；会话已在某个窗格时只把焦点移过去；
 * 否则在焦点窗格里替换为该会话。
 */
export function openSessionInLayout(sid: string): void {
  const target = takePickTarget();
  const leaf = leafOfSession(layout.root, sid);
  if (target && findLeaf(layout.root, target) && target !== leaf?.id) {
    commitLayout(focusLeaf(replaceSession(layout, target, sid), target));
  } else if (leaf) {
    commitLayout(focusLeaf(layout, leaf.id));
  } else {
    commitLayout(replaceSession(layout, layout.focus, sid));
  }
}

function refreshLabels(): void {
  commitLayout(withLabels(layout, sid => findSession(sid)?.label));
}

/**
 * 每轮渲染开头调用，幂等：直接改写 selectedId 的路径（新建会话、通知点击、刷新）
 * 由这里把布局焦点对齐到选中会话，并刷新窗格记住的会话名。
 */
export function syncLayoutWithSelection(): void {
  if (state.selectedId && !state.selectedSubagent) {
    const leaf = leafOfSession(layout.root, state.selectedId);
    if (leaf) {
      if (layout.focus !== leaf.id) commitLayout(focusLeaf(layout, leaf.id));
    } else {
      commitLayout(replaceSession(layout, layout.focus, state.selectedId));
    }
  }
  refreshLabels();
}

/** 启动后首次拿到会话列表时调用一次：已不存在的会话变为空占位并注明原会话名 */
export function reconcileLayoutOnBoot(alive: ReadonlySet<string>): void {
  commitLayout(reconcileMissing(layout, alive));
}

/**
 * 运行期会话被移除（结束、归档）：多窗格时关闭其窗格，单窗格时变为空占位。
 * 返回新的焦点会话；焦点为空占位时取第一个有会话的窗格，都没有返回 null。
 */
export function handleRemovedSessions(removed: readonly string[]): string | null {
  commitLayout(removeSessions(layout, new Set(removed)));
  const f = focusedLeaf();
  if (f.sid) return f.sid;
  return leaves(layout.root).find(l => l.sid !== null)?.sid ?? null;
}
