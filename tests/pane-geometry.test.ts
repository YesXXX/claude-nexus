import { describe, it, expect } from 'vitest';
import type { PaneLayout, PaneLeaf, PaneNode, PaneSplit } from '../src/shared/pane-layout';
import {
  type CellMetrics, type DegradeState, type Rect,
  layoutRects, gridOf, splitRects, splitFeasible, dropZoneAt, paneAt, neighborPane, minExtent, minGrid,
  nextDegrade, INITIAL_DEGRADE, MIN_DWELL_MS, DIVIDER_PX,
} from '../src/shared/pane-geometry';

const leaf = (id: string, sid: string | null): PaneLeaf => ({ t: 'leaf', id, sid });
const split = (dir: 'row' | 'col', sizes: number[], children: PaneNode[]): PaneSplit => ({ t: 'split', dir, sizes, children });
/** 便于手算的度量：每列 10px、每行 20px，无额外占用 */
const M: CellMetrics = { charW: 10, lineH: 20, padX: 0, padY: 0, chromeH: 0 };
const BOX: Rect = { x: 0, y: 0, w: 1000, h: 1000 };

/** row[col[p1,p2], col[p3,p4]] */
function gridRoot(): PaneNode {
  return split('row', [0.5, 0.5], [
    split('col', [0.5, 0.5], [leaf('p1', 'B'), leaf('p2', 'C')]),
    split('col', [0.5, 0.5], [leaf('p3', 'A'), leaf('p4', 'D')]),
  ]);
}

describe('layoutRects', () => {
  it('单窗格铺满', () => {
    expect(layoutRects(leaf('p1', 'a'), BOX).get('p1')).toEqual(BOX);
  });

  it('row 对半扣除分隔条', () => {
    const r = layoutRects(split('row', [0.5, 0.5], [leaf('p1', 'a'), leaf('p2', 'b')]), BOX);
    expect(r.get('p1')).toEqual({ x: 0, y: 0, w: 496, h: 1000 });
    expect(r.get('p2')).toEqual({ x: 504, y: 0, w: 496, h: 1000 });
  });

  it('四格坐标', () => {
    const r = layoutRects(gridRoot(), BOX);
    expect(r.get('p1')).toEqual({ x: 0, y: 0, w: 496, h: 496 });
    expect(r.get('p2')).toEqual({ x: 0, y: 504, w: 496, h: 496 });
    expect(r.get('p3')).toEqual({ x: 504, y: 0, w: 496, h: 496 });
    expect(r.get('p4')).toEqual({ x: 504, y: 504, w: 496, h: 496 });
  });

  it('比例不等时按比例切分', () => {
    const r = layoutRects(split('row', [0.75, 0.25], [leaf('p1', 'a'), leaf('p2', 'b')]), { x: 0, y: 0, w: 408, h: 100 });
    expect(r.get('p1')?.w).toBe(300);
    expect(r.get('p2')).toEqual({ x: 308, y: 0, w: 100, h: 100 });
  });
});

describe('gridOf / splitRects / minGrid', () => {
  it('gridOf 向下取整，extraTop 减行，结果不为负', () => {
    const m: CellMetrics = { charW: 7.8, lineH: 17, padX: 34, padY: 16, chromeH: 32 };
    expect(gridOf({ x: 0, y: 0, w: 800, h: 400 }, m)).toEqual({ cols: 98, rows: 20 });
    expect(gridOf({ x: 0, y: 0, w: 800, h: 400 }, m, 33)).toEqual({ cols: 98, rows: 18 });
    expect(gridOf({ x: 0, y: 0, w: 10, h: 10 }, m)).toEqual({ cols: 0, rows: 0 });
  });

  it('splitRects 四个方向', () => {
    const r: Rect = { x: 0, y: 0, w: 208, h: 108 };
    expect(splitRects(r, 'right')).toEqual({ kept: { x: 0, y: 0, w: 100, h: 108 }, added: { x: 108, y: 0, w: 100, h: 108 } });
    expect(splitRects(r, 'left')).toEqual({ kept: { x: 108, y: 0, w: 100, h: 108 }, added: { x: 0, y: 0, w: 100, h: 108 } });
    expect(splitRects(r, 'bottom')).toEqual({ kept: { x: 0, y: 0, w: 208, h: 50 }, added: { x: 0, y: 58, w: 208, h: 50 } });
    expect(splitRects(r, 'top')).toEqual({ kept: { x: 0, y: 58, w: 208, h: 50 }, added: { x: 0, y: 0, w: 208, h: 50 } });
  });

  it('minGrid 按列再按行取最差，空数组为 null', () => {
    expect(minGrid([{ cols: 80, rows: 10 }, { cols: 60, rows: 30 }, { cols: 60, rows: 20 }])).toEqual({ cols: 60, rows: 20 });
    expect(minGrid([])).toBeNull();
  });
});

describe('splitFeasible', () => {
  const two: PaneLayout = { root: split('row', [0.5, 0.5], [leaf('p1', 'a'), leaf('p2', 'b')]), focus: 'p1' };

  it('会话就在目标窗格为 self', () => {
    expect(splitFeasible(two, 'p1', 'right', layoutRects(two.root, BOX), M, 'a')).toEqual({ ok: false, reason: 'self' });
  });

  it('满 4 格拖入新会话为 full；移动布局内会话在尺寸足够时为 ok', () => {
    const g: PaneLayout = { root: gridRoot(), focus: 'p1' };
    const big = layoutRects(g.root, { x: 0, y: 0, w: 4000, h: 4000 });
    expect(splitFeasible(g, 'p1', 'right', big, M, 'E')).toEqual({ ok: false, reason: 'full' });
    expect(splitFeasible(g, 'p1', 'right', big, M, 'D')).toEqual({ ok: true });
  });

  it('拆分后不足 60 × 12 为 small，带较小一侧的列行', () => {
    const rects = layoutRects(two.root, BOX);
    expect(splitFeasible(two, 'p2', 'right', rects, M, 'c')).toEqual({ ok: false, reason: 'small', cols: 24, rows: 50 });
    expect(splitFeasible(two, 'p2', 'bottom', rects, M, 'c')).toEqual({ ok: false, reason: 'small', cols: 49, rows: 24 });
    const wide = layoutRects(two.root, { x: 0, y: 0, w: 2000, h: 1000 });
    expect(splitFeasible(two, 'p2', 'bottom', wide, M, 'c')).toEqual({ ok: true });
  });
});

describe('dropZoneAt / paneAt', () => {
  const r: Rect = { x: 100, y: 100, w: 200, h: 100 };

  it('中心、四边、四角落到最近边、边界为中央、矩形外为 null', () => {
    expect(dropZoneAt(r, 200, 150)).toBe('center');
    expect(dropZoneAt(r, 105, 150)).toBe('left');
    expect(dropZoneAt(r, 295, 150)).toBe('right');
    expect(dropZoneAt(r, 200, 103)).toBe('top');
    expect(dropZoneAt(r, 200, 198)).toBe('bottom');
    expect(dropZoneAt(r, 102, 110)).toBe('left');
    expect(dropZoneAt(r, 150, 104)).toBe('top');
    expect(dropZoneAt({ x: 0, y: 0, w: 100, h: 100 }, 27, 27)).toBe('center');
    expect(dropZoneAt(r, 50, 150)).toBeNull();
  });

  it('paneAt 命中与未命中', () => {
    const rects = layoutRects(gridRoot(), BOX);
    expect(paneAt(rects, 700, 100)).toBe('p3');
    expect(paneAt(rects, 100, 900)).toBe('p2');
    expect(paneAt(rects, 2000, 100)).toBeNull();
  });
});

describe('neighborPane', () => {
  it('四格四个方向，边缘无邻居为 null', () => {
    const rects = layoutRects(gridRoot(), BOX);
    expect(neighborPane(rects, 'p1', 'right')).toBe('p3');
    expect(neighborPane(rects, 'p1', 'bottom')).toBe('p2');
    expect(neighborPane(rects, 'p4', 'left')).toBe('p2');
    expect(neighborPane(rects, 'p4', 'top')).toBe('p3');
    expect(neighborPane(rects, 'p1', 'left')).toBeNull();
    expect(neighborPane(rects, 'p1', 'top')).toBeNull();
    expect(neighborPane(rects, 'p9', 'top')).toBeNull();
  });

  it('选与起点重叠更多的那个', () => {
    const root = split('row', [0.5, 0.5], [leaf('a', 'x'), split('col', [0.3, 0.7], [leaf('b', 'y'), leaf('c', 'z')])]);
    const rects = layoutRects(root, BOX);
    expect(neighborPane(rects, 'a', 'right')).toBe('c');
    expect(neighborPane(rects, 'b', 'left')).toBe('a');
  });

  it('没有重叠的候选时按中心距离', () => {
    const rects = new Map<string, Rect>([
      ['a', { x: 0, y: 0, w: 100, h: 100 }],
      ['far', { x: 400, y: 400, w: 100, h: 100 }],
      ['near', { x: 150, y: 200, w: 100, h: 100 }],
    ]);
    expect(neighborPane(rects, 'a', 'right')).toBe('near');
  });
});

describe('minExtent', () => {
  it('叶子、row 求和、col 取最大与嵌套组合', () => {
    const m: CellMetrics = { charW: 10, lineH: 20, padX: 30, padY: 10, chromeH: 20 };
    const w = 30 + 600;
    const h = 20 + 10 + 240;
    expect(minExtent(leaf('p1', 'a'), m, 'w')).toBe(w);
    expect(minExtent(leaf('p1', 'a'), m, 'h')).toBe(h);
    const row = split('row', [0.5, 0.5], [leaf('p1', 'a'), leaf('p2', 'b')]);
    expect(minExtent(row, m, 'w')).toBe(w * 2 + DIVIDER_PX);
    expect(minExtent(row, m, 'h')).toBe(h);
    expect(minExtent(gridRoot(), m, 'w')).toBe(w * 2 + DIVIDER_PX);
    expect(minExtent(gridRoot(), m, 'h')).toBe(h * 2 + DIVIDER_PX);
  });
});

describe('nextDegrade', () => {
  const T = 10_000;

  it('测得 59 列退化，60 × 12 不退化，测量为 null 保持', () => {
    const d = nextDegrade(INITIAL_DEGRADE, T, { cols: 59, rows: 30 }, null);
    expect(d).toEqual({ degraded: true, since: T, worst: { cols: 59, rows: 30 } });
    expect(nextDegrade(INITIAL_DEGRADE, T, { cols: 60, rows: 12 }, null)).toBe(INITIAL_DEGRADE);
    expect(nextDegrade(INITIAL_DEGRADE, T, { cols: 80, rows: 11 }, null).degraded).toBe(true);
    expect(nextDegrade(INITIAL_DEGRADE, T, null, null)).toBe(INITIAL_DEGRADE);
  });

  it('停留未满不切换', () => {
    const recent: DegradeState = { degraded: false, since: T, worst: null };
    expect(nextDegrade(recent, T + MIN_DWELL_MS - 1, { cols: 40, rows: 30 }, null)).toBe(recent);
  });

  it('已退化：估算 63 列不恢复，64 列且 13 行恢复，worst 跟随估算', () => {
    const d: DegradeState = { degraded: true, since: T, worst: { cols: 48, rows: 10 } };
    const later = T + MIN_DWELL_MS;
    const hold = nextDegrade(d, later, null, { cols: 63, rows: 30 });
    expect(hold.degraded).toBe(true);
    expect(hold.worst).toEqual({ cols: 63, rows: 30 });
    expect(nextDegrade(d, later, null, { cols: 64, rows: 12 }).degraded).toBe(true);
    expect(nextDegrade(d, later, null, { cols: 64, rows: 13 })).toEqual({ degraded: false, since: later, worst: null });
    expect(nextDegrade(d, later, null, null)).toBe(d);
  });

  it('恢复后立刻测得不足但停留未满不回弹', () => {
    const restored: DegradeState = { degraded: false, since: T, worst: null };
    expect(nextDegrade(restored, T + 100, { cols: 58, rows: 30 }, null)).toBe(restored);
  });

  it('已退化且估算不变时返回同一对象', () => {
    const d: DegradeState = { degraded: true, since: T, worst: { cols: 50, rows: 20 } };
    expect(nextDegrade(d, T + 10, null, { cols: 50, rows: 20 })).toBe(d);
  });
});
