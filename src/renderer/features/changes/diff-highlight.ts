import type { FileDiff } from '../../../shared/types';
import { lineText } from '../../../shared/diff-layout.js';
import type { DiffLine } from '../../../shared/types';
import { MAX_HIGHLIGHT_TOTAL, hunkTokenizer, langOf, type HunkTokenizer } from '../../../shared/syntax-tokenize.js';
import { intraline, mergeSegments, pairChanges, type LinePair, type Range } from '../../../shared/word-diff.js';
import { el } from '../../core/dom.js';
import type { CellSink, DiffSide } from './diff-render.js';

/**
 * diff 区的语法着色与词级差异：渲染时先写纯文本并登记文本单元，
 * 按 200 个单元一块，块接近可视区（上下 800px）时才把纯文本替换成着色片段；离开可视区不回收。
 * 分词按分块逐行推进到需要的行为止，词级差异按删增配对在第一次绘制时计算，结果都缓存。
 * 片段文本只用 textContent 写入。
 */

const CHUNK = 200;
/** 每隔这么多个单元放一个观察点，保证可视区附近总能命中 */
const SENTINEL_STEP = 10;
const ROOT_MARGIN = '800px 0px';

export const TOO_LARGE_NOTICE = '文件过大，已关闭语法高亮';

/** diff 正文总字符数，用于判定是否整体关闭高亮 */
export function diffTextSize(d: FileDiff): number {
  let n = 0;
  for (const h of d.hunks) for (const l of h.lines) n += l.text.length;
  return n;
}

export function tooLargeToHighlight(d: FileDiff): boolean {
  return diffTextSize(d) > MAX_HIGHLIGHT_TOTAL;
}

interface Cell { txt: HTMLElement; h: number; i: number; side: DiffSide }
interface HunkData {
  tokens?: HunkTokenizer;
  lines: DiffLine[];
  /** 行序号到所在删增配对 */
  partner: Map<number, LinePair>;
  /** 已算过的词级区间，空数组表示算过但不标记 */
  marks: Map<number, Range[]>;
}

export interface Highlighter {
  /** 交给渲染登记文本单元 */
  readonly sink: CellSink;
  /** 内容挂进滚动区后开始观察；没有 IntersectionObserver 时直接全部绘制 */
  start(root: HTMLElement): void;
  /** 断开观察，丢弃未绘制的单元 */
  dispose(): void;
}

/** syntax 为 false 时只画词级差异；未识别的扩展名同样只画词级差异 */
export function createHighlighter(d: FileDiff, syntax: boolean): Highlighter {
  const lang = syntax ? langOf(d.path) : undefined;
  const cache = new Map<number, HunkData>();
  let cells: Cell[] = [];
  const done = new Set<number>();
  const chunkOf = new Map<Element, number>();
  let io: IntersectionObserver | undefined;
  let disposed = false;

  const dataOf = (h: number): HunkData => {
    let x = cache.get(h);
    if (x) return x;
    const lines = d.hunks[h]?.lines ?? [];
    const partner = new Map<number, LinePair>();
    for (const p of pairChanges(lines)) {
      partner.set(p.del, p);
      partner.set(p.add, p);
    }
    x = { tokens: lang ? hunkTokenizer(lang, lines) : undefined, lines, partner, marks: new Map() };
    cache.set(h, x);
    return x;
  };

  /** 词级差异按删增配对懒计算，一对算一次，两侧共用 */
  const marksOf = (data: HunkData, i: number): Range[] => {
    const hit = data.marks.get(i);
    if (hit) return hit;
    const p = data.partner.get(i);
    if (!p) return [];
    const r = intraline(lineText(data.lines[p.del]), lineText(data.lines[p.add]));
    data.marks.set(p.del, r?.del ?? []);
    data.marks.set(p.add, r?.add ?? []);
    return data.marks.get(i) ?? [];
  };

  const paint = (c: Cell): void => {
    const line = d.hunks[c.h]?.lines[c.i];
    if (!line) return;
    const text = lineText(line);
    const data = dataOf(c.h);
    const toks = data.tokens?.at(c.i)[c.side] ?? [];
    const marks = marksOf(data, c.i);
    if (!toks.length && !marks.length) return;
    const frag = document.createDocumentFragment();
    for (const s of mergeSegments(text.length, toks, marks)) {
      const t = text.slice(s.s, s.e);
      if (!s.k && !s.mark) { frag.append(t); continue; }
      const cls = s.k && s.mark ? `syn-${s.k} chg-intra` : s.k ? `syn-${s.k}` : 'chg-intra';
      frag.append(el('span', cls, t));
    }
    c.txt.replaceChildren(frag);
  };

  const paintChunk = (k: number): void => {
    if (disposed || done.has(k)) return;
    done.add(k);
    const end = Math.min(cells.length, (k + 1) * CHUNK);
    for (let j = k * CHUNK; j < end; j++) {
      paint(cells[j]);
      if (io && (j % SENTINEL_STEP === 0 || j === cells.length - 1)) io.unobserve(cells[j].txt);
    }
  };

  return {
    sink(txt, h, i, side): void {
      if (!disposed) cells.push({ txt, h, i, side });
    },
    start(root: HTMLElement): void {
      if (disposed || cells.length === 0) return;
      if (typeof IntersectionObserver === 'undefined') {
        for (let k = 0; k * CHUNK < cells.length; k++) paintChunk(k);
        return;
      }
      io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const k = chunkOf.get(e.target);
          if (k !== undefined) paintChunk(k);
        }
      }, { root, rootMargin: ROOT_MARGIN });
      for (let j = 0; j < cells.length; j++) {
        if (j % SENTINEL_STEP !== 0 && j !== cells.length - 1) continue;
        chunkOf.set(cells[j].txt, Math.floor(j / CHUNK));
        io.observe(cells[j].txt);
      }
    },
    dispose(): void {
      disposed = true;
      io?.disconnect();
      io = undefined;
      cells = [];
      chunkOf.clear();
      cache.clear();
    },
  };
}
