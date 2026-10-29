import type { DropZone, Edge, PaneLayout, PaneNode } from './pane-layout.js';
import { canSplit, findLeaf } from './pane-layout.js';

/**
 * 多窗格的几何计算：按布局树切分矩形、拖放区域命中、方向邻居、列行估算与自动退化判定。
 * 纯函数，不访问 DOM；像素尺寸与时间都由调用方传入。
 */

export interface Rect { x: number; y: number; w: number; h: number }
export interface GridSize { cols: number; rows: number }
export interface CellMetrics {
  /** 等宽字符宽（px），运行期由终端层实测 */
  charW: number;
  /** 行高（px），运行期实测，兜底 15 */
  lineH: number;
  /** 卡片宽度中不能放字符的部分：边框、宿主左右 padding 与滚动条，按实测 xterm 列数校准 */
  padX: number;
  /** 卡片高度扣除窗格头后不能放行的部分：宿主上下 padding，按实测 xterm 行数校准 */
  padY: number;
  /** 窗格头 30 + 卡片上下边框 2 */
  chromeH: number;
}

export const MIN_COLS = 60;
export const MIN_ROWS = 12;
export const DIVIDER_PX = 8;
/** 非焦点窗格内联批准条高度 */
export const APPROVE_BAR_PX = 33;
/** 退化后恢复需要额外富余的列数与行数，避免在阈值附近来回切换 */
export const HYST_COLS = 4;
export const HYST_ROWS = 1;
/** 两次退化状态切换之间的最短停留 */
export const MIN_DWELL_MS = 800;

/**
 * 13px Cascadia 终端字体的兜底度量，运行期以实测字宽与行高为准。
 * padX、padY 取自 1180~1920 宽窗口下四格、两格、最大化、退化各形态的 xterm 实际列行，
 * 用它们按卡片矩形估算的列行与 xterm 一致。
 */
export const DEFAULT_CELL_METRICS: CellMetrics = { charW: 7.6172, lineH: 15, padX: 16, padY: 10, chromeH: 32 };

export type SplitCheck =
  | { ok: true }
  | { ok: false; reason: 'full' | 'self' }
  | { ok: false; reason: 'small'; cols: number; rows: number };

export interface DegradeState { degraded: boolean; since: number; worst: GridSize | null }
export const INITIAL_DEGRADE: DegradeState = { degraded: false, since: 0, worst: null };

/** 按比例递归切分，子节点之间扣除分隔条宽度 */
export function layoutRects(root: PaneNode, box: Rect, divider = DIVIDER_PX): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const walk = (n: PaneNode, r: Rect): void => {
    if (n.t === 'leaf') { out.set(n.id, r); return; }
    const horiz = n.dir === 'row';
    const len = horiz ? r.w : r.h;
    const avail = Math.max(0, len - divider * (n.children.length - 1));
    let pos = horiz ? r.x : r.y;
    n.children.forEach((c, i) => {
      const size = avail * n.sizes[i];
      walk(c, horiz ? { x: pos, y: r.y, w: size, h: r.h } : { x: r.x, y: pos, w: r.w, h: size });
      pos += size + divider;
    });
  };
  walk(root, box);
  return out;
}

/** 窗格矩形可容纳的终端列行；extraTop 为内容区上方额外占用（如内联批准条） */
export function gridOf(rect: Rect, m: CellMetrics, extraTop = 0): GridSize {
  return {
    cols: Math.max(0, Math.floor((rect.w - m.padX) / m.charW)),
    rows: Math.max(0, Math.floor((rect.h - m.chromeH - extraTop - m.padY) / m.lineH)),
  };
}

/** 在 edge 一侧对半拆出新窗格后，原窗格与新窗格的矩形 */
export function splitRects(rect: Rect, edge: Edge, divider = DIVIDER_PX): { kept: Rect; added: Rect } {
  if (edge === 'left' || edge === 'right') {
    const half = Math.max(0, (rect.w - divider) / 2);
    const first = { x: rect.x, y: rect.y, w: half, h: rect.h };
    const second = { x: rect.x + half + divider, y: rect.y, w: half, h: rect.h };
    return edge === 'right' ? { kept: first, added: second } : { kept: second, added: first };
  }
  const half = Math.max(0, (rect.h - divider) / 2);
  const first = { x: rect.x, y: rect.y, w: rect.w, h: half };
  const second = { x: rect.x, y: rect.y + half + divider, w: rect.w, h: half };
  return edge === 'bottom' ? { kept: first, added: second } : { kept: second, added: first };
}

/** 按列再按行取最差的一个；空数组返回 null */
export function minGrid(sizes: readonly GridSize[]): GridSize | null {
  let worst: GridSize | null = null;
  for (const g of sizes) {
    if (!worst || g.cols < worst.cols || (g.cols === worst.cols && g.rows < worst.rows)) worst = g;
  }
  return worst;
}

function tooSmall(g: GridSize): boolean {
  return g.cols < MIN_COLS || g.rows < MIN_ROWS;
}

/**
 * 判断能否在目标窗格的 edge 一侧拆分：会话就在目标窗格为 self，名额已满为 full，
 * 拆分后任一侧不足 60 列 × 12 行为 small（带较小一侧的估算）。
 * 拖入会话的原窗格关闭后目标会变大，这里不计入，宁可多禁用。
 */
export function splitFeasible(
  layout: PaneLayout, paneId: string, edge: Edge,
  rects: ReadonlyMap<string, Rect>, m: CellMetrics, movingSid: string | null,
): SplitCheck {
  const leaf = findLeaf(layout.root, paneId);
  if (!leaf || (movingSid !== null && leaf.sid === movingSid)) return { ok: false, reason: 'self' };
  if (!canSplit(layout, movingSid)) return { ok: false, reason: 'full' };
  const r = rects.get(paneId);
  if (!r) return { ok: true };
  const { kept, added } = splitRects(r, edge);
  const worst = minGrid([gridOf(kept, m), gridOf(added, m)]) as GridSize;
  return tooSmall(worst) ? { ok: false, reason: 'small', cols: worst.cols, rows: worst.rows } : { ok: true };
}

function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** 相对坐标都在 [0.27, 0.73] 内为中央，否则取最近的边；点在矩形外返回 null */
export function dropZoneAt(rect: Rect, x: number, y: number): DropZone | null {
  if (rect.w <= 0 || rect.h <= 0 || !contains(rect, x, y)) return null;
  const rx = (x - rect.x) / rect.w;
  const ry = (y - rect.y) / rect.h;
  if (rx >= 0.27 && rx <= 0.73 && ry >= 0.27 && ry <= 0.73) return 'center';
  const dist: Array<[Edge, number]> = [['left', rx], ['right', 1 - rx], ['top', ry], ['bottom', 1 - ry]];
  let best = dist[0];
  for (const d of dist) if (d[1] < best[1]) best = d;
  return best[0];
}

export function paneAt(rects: ReadonlyMap<string, Rect>, x: number, y: number): string | null {
  for (const [id, r] of rects) if (contains(r, x, y)) return id;
  return null;
}

function centerDist(a: Rect, b: Rect): number {
  return Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));
}

/**
 * 方向邻居：候选为完全位于该方向一侧的窗格。优先与起点在垂直轴上有重叠的，
 * 按间距最小、重叠最长、中心距离最近排序；都不重叠时按中心距离最近。没有候选返回 null。
 */
export function neighborPane(rects: ReadonlyMap<string, Rect>, fromId: string, dir: Edge): string | null {
  const from = rects.get(fromId);
  if (!from) return null;
  const horiz = dir === 'left' || dir === 'right';
  const scored: Array<{ id: string; gap: number; overlap: number; dist: number }> = [];
  for (const [id, r] of rects) {
    if (id === fromId) continue;
    let gap: number;
    if (dir === 'right') gap = r.x - (from.x + from.w);
    else if (dir === 'left') gap = from.x - (r.x + r.w);
    else if (dir === 'bottom') gap = r.y - (from.y + from.h);
    else gap = from.y - (r.y + r.h);
    if (gap < -1) continue;
    const overlap = horiz
      ? Math.min(from.y + from.h, r.y + r.h) - Math.max(from.y, r.y)
      : Math.min(from.x + from.w, r.x + r.w) - Math.max(from.x, r.x);
    scored.push({ id, gap, overlap, dist: centerDist(from, r) });
  }
  const overlapping = scored.filter(c => c.overlap > 0);
  if (overlapping.length > 0) {
    overlapping.sort((a, b) => a.gap - b.gap || b.overlap - a.overlap || a.dist - b.dist);
    return overlapping[0].id;
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => a.dist - b.dist);
  return scored[0].id;
}

/** 子树满足最小 60 列 × 12 行所需的最小像素：同轴拆分求和加分隔条，异轴取最大 */
export function minExtent(node: PaneNode, m: CellMetrics, axis: 'w' | 'h', divider = DIVIDER_PX): number {
  if (node.t === 'leaf') {
    return axis === 'w' ? m.padX + MIN_COLS * m.charW : m.chromeH + m.padY + MIN_ROWS * m.lineH;
  }
  const parts = node.children.map(c => minExtent(c, m, axis, divider));
  const along = (node.dir === 'row') === (axis === 'w');
  return along ? parts.reduce((a, b) => a + b, 0) + divider * (parts.length - 1) : Math.max(...parts);
}

/**
 * 自动退化状态机。未退化时实测最差窗格不足 60 列或 12 行即退化；
 * 已退化时估算达到阈值加富余才恢复，期间 worst 跟随估算更新。两次切换之间至少停留 MIN_DWELL_MS。
 */
export function nextDegrade(
  prev: DegradeState, now: number, measured: GridSize | null, estimated: GridSize | null,
): DegradeState {
  const dwelled = now - prev.since >= MIN_DWELL_MS;
  if (!prev.degraded) {
    if (measured && tooSmall(measured) && dwelled) return { degraded: true, since: now, worst: measured };
    return prev;
  }
  if (!estimated) return prev;
  if (estimated.cols >= MIN_COLS + HYST_COLS && estimated.rows >= MIN_ROWS + HYST_ROWS && dwelled) {
    return { degraded: false, since: now, worst: null };
  }
  if (prev.worst && prev.worst.cols === estimated.cols && prev.worst.rows === estimated.rows) return prev;
  return { ...prev, worst: estimated };
}
