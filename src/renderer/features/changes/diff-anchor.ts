/**
 * 换视图时的滚动对齐：记下可视区第一行的新版行号（没有则旧版行号）与它离可视区顶部的距离，
 * 重绘后滚到同一行号所在的行，保持它在屏幕上的位置不变。
 */

export interface ScrollAnchor { attr: 'n' | 'o'; no: string; offset: number }

/** 往后最多看这么多行找带行号的行（跳过元信息行） */
const LOOKAHEAD = 50;

/** 可视区内第一行在行列表中的位置，按 offsetTop 二分查找 */
function firstVisible(rows: NodeListOf<HTMLElement>, top: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid];
    if (r.offsetTop + r.offsetHeight > top) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
}

/** 停在顶部时不记，重绘后自然仍在顶部 */
export function takeAnchor(scroll: HTMLElement): ScrollAnchor | undefined {
  const top = scroll.scrollTop;
  if (top <= 0) return undefined;
  const rows = scroll.querySelectorAll<HTMLElement>('.chg-ln');
  const start = firstVisible(rows, top);
  if (start < 0) return undefined;
  for (let k = start; k < rows.length && k < start + LOOKAHEAD; k++) {
    const r = rows[k];
    const attr = r.dataset.n ? 'n' : r.dataset.o ? 'o' : undefined;
    if (attr) return { attr, no: r.dataset[attr] as string, offset: r.offsetTop - top };
  }
  return undefined;
}

/** 找到同一行号的行则滚过去并返回 true；找不到时不改滚动位置 */
export function restoreAnchor(scroll: HTMLElement, a: ScrollAnchor): boolean {
  const row = scroll.querySelector<HTMLElement>(`.chg-ln[data-${a.attr}="${a.no}"]`);
  if (!row) return false;
  scroll.scrollTop = Math.max(0, row.offsetTop - a.offset);
  return true;
}
