import type { DiffHunk } from '../../../shared/types';
import { buildSplitRows, type SplitCell } from '../../../shared/diff-layout.js';
import { el } from '../../core/dom.js';
import { codeBox, hunkHead, noCell, signText, textCell, type CellSink } from './diff-render.js';

/**
 * 分栏视图：左旧右新，每个视觉行是一个 .chg-ln，内含左右两个半栏，两侧同一 grid 行天然等高。
 * 行上的 data-h / data-i / data-o / data-n 与统一视图同义，批注按这些属性定位：
 * data-i 取新侧（右侧）行序号，右侧为空或只有元信息时取左侧；左右是一对删增时左侧行序号另记在 data-il。
 * 半栏带 data-ci（自己那一侧的行序号），行号栏点选时按点中的一侧选择。
 */

const isLine = (c: SplitCell): c is NonNullable<SplitCell> => !!c && c.line.kind !== 'meta';

function half(cell: SplitCell, side: 'l' | 'r', hunk: number, sink?: CellSink): HTMLElement {
  if (!cell) {
    const e = el('div', `chg-half ${side} k-empty`);
    e.append(el('span', 'chg-no'), el('span', 'chg-sign'), el('span', 'chg-txt'));
    return e;
  }
  const l = cell.line;
  const e = el('div', `chg-half ${side} k-${l.kind}`);
  const txt = textCell(l);
  if (l.kind === 'meta') {
    e.append(el('span', 'chg-no'), el('span', 'chg-sign'), txt);
    return e;
  }
  e.dataset.ci = String(cell.index);
  e.append(noCell(side === 'l' ? l.oldNo : l.newNo), el('span', 'chg-sign', signText(l.kind)), txt);
  sink?.(txt, hunk, cell.index, side === 'l' ? 'old' : 'new');
  return e;
}

export function buildSplit(hunks: DiffHunk[], sink?: CellSink): HTMLElement {
  const code = codeBox(hunks, 'chg-split');
  const frag = document.createDocumentFragment();
  for (const r of buildSplitRows(hunks)) {
    if (r.kind === 'hunk') {
      frag.append(hunkHead(hunks[r.hunk], r.hunk));
      continue;
    }
    const { left, right } = r;
    const main = isLine(right) ? right : isLine(left) ? left : (right ?? left);
    const row = el('div', isLine(left) || isLine(right) ? 'chg-ln split' : 'chg-ln split meta');
    row.dataset.h = String(r.hunk);
    if (main) row.dataset.i = String(main.index);
    if (isLine(left) && main && left.index !== main.index) row.dataset.il = String(left.index);
    if (left?.line.oldNo !== undefined) row.dataset.o = String(left.line.oldNo);
    if (right?.line.newNo !== undefined) row.dataset.n = String(right.line.newNo);
    row.append(half(left, 'l', r.hunk, sink), half(right, 'r', r.hunk, sink));
    frag.append(row);
  }
  code.append(frag);
  return code;
}
