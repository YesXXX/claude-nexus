import type { DiffLine } from './types';
import type { Token, TokenKind } from './syntax-lex';

/**
 * 词级差异：修改块配对、行内按词的 Myers 差异、相似度判定，以及语法区间与变化区间的合并。
 * 统一视图与分栏视图共用同一套配对，两种视图下的变化标记一致。
 */

export interface Range { s: number; e: number; }
/** 分块内行下标：第 k 个删除行与第 k 个新增行配对 */
export interface LinePair { del: number; add: number; }
export interface Segment { s: number; e: number; k?: TokenKind; mark?: boolean; }

/** 双方都不超过这个长度才做词级差异 */
export const MAX_INTRALINE = 500;
/** 词级编辑距离超过这个值即放弃 */
export const MAX_EDIT = 200;
/** 相同字符占比低于这个值视为整行重写，只整行着色 */
export const MIN_SIMILARITY = 0.4;

/** 一段连续删除与紧随的连续新增视为一个修改块，按序号一一配对，多出的行不配对；元信息行跳过 */
export function pairChanges(lines: DiffLine[]): LinePair[] {
  const pairs: LinePair[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== 'del') { i++; continue; }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < lines.length && (lines[i].kind === 'del' || lines[i].kind === 'meta')) {
      if (lines[i].kind === 'del') dels.push(i);
      i++;
    }
    while (i < lines.length && (lines[i].kind === 'add' || lines[i].kind === 'meta')) {
      if (lines[i].kind === 'add') adds.push(i);
      i++;
    }
    const n = Math.min(dels.length, adds.length);
    for (let k = 0; k < n; k++) pairs.push({ del: dels[k], add: adds[k] });
  }
  return pairs;
}

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
/** 中日韩文字逐字切分；其余字母数字连成一个词；空白连成一段；其他字符单独成词 */
const WORD_RE = new RegExp(`[${CJK}]|(?:(?![${CJK}])[\\p{L}\\p{N}_$])+|\\s+|[\\s\\S]`, 'gu');

export function splitWords(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

/** Myers 差异：返回两侧各词是否属于变化部分；编辑距离超过 maxD 返回 null */
function myers(a: string[], b: string[], maxD: number): { ka: boolean[]; kb: boolean[] } | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(maxD, n + m);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m, off);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], dEnd: number, n: number, m: number, off: number): { ka: boolean[]; kb: boolean[] } {
  const ka: boolean[] = new Array<boolean>(n).fill(false);
  const kb: boolean[] = new Array<boolean>(m).fill(false);
  let x = n;
  let y = m;
  for (let d = dEnd; d > 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = vv[off + prevK];
    const prevY = prevX - prevK;
    if (down) kb[prevY] = true;
    else ka[prevX] = true;
    x = prevX;
    y = prevY;
  }
  return { ka, kb };
}

function toRanges(words: string[], changed: boolean[]): Range[] {
  const out: Range[] = [];
  let pos = 0;
  words.forEach((w, i) => {
    const e = pos + w.length;
    if (changed[i]) {
      const last = out[out.length - 1];
      if (last && last.e === pos) last.e = e;
      else out.push({ s: pos, e });
    }
    pos = e;
  });
  return out;
}

/**
 * 一对删除 / 新增行的词级变化区间（字符下标）。
 * 任一侧超过 maxLen、编辑距离超限或相似度过低时返回 null，表示只整行着色。
 */
export function intraline(a: string, b: string, maxLen = MAX_INTRALINE): { del: Range[]; add: Range[] } | null {
  if (a.length > maxLen || b.length > maxLen) return null;
  if (a === b) return { del: [], add: [] };
  const wa = splitWords(a);
  const wb = splitWords(b);
  const r = myers(wa, wb, MAX_EDIT);
  if (!r) return null;
  let same = 0;
  wa.forEach((w, i) => { if (!r.ka[i]) same += w.length; });
  if ((2 * same) / (a.length + b.length) < MIN_SIMILARITY) return null;
  return { del: toRanges(wa, r.ka), add: toRanges(wb, r.kb) };
}

/**
 * 把语法区间与变化区间合并成覆盖 [0, len) 的连续片段，相邻且属性相同的片段合并。
 * 两组区间都要求升序、组内不重叠；越界部分截掉。
 */
export function mergeSegments(len: number, tokens: Token[], marks: Range[]): Segment[] {
  if (len <= 0) return [];
  const cuts = new Set<number>([0, len]);
  for (const t of tokens) { cuts.add(Math.max(0, Math.min(len, t.s))); cuts.add(Math.max(0, Math.min(len, t.e))); }
  for (const r of marks) { cuts.add(Math.max(0, Math.min(len, r.s))); cuts.add(Math.max(0, Math.min(len, r.e))); }
  const pts = [...cuts].sort((x, y) => x - y);
  const out: Segment[] = [];
  let ti = 0;
  let mi = 0;
  for (let p = 0; p + 1 < pts.length; p++) {
    const s = pts[p];
    const e = pts[p + 1];
    while (ti < tokens.length && tokens[ti].e <= s) ti++;
    while (mi < marks.length && marks[mi].e <= s) mi++;
    const t = tokens[ti];
    const mk = marks[mi];
    const k = t && t.s <= s && t.e >= e ? t.k : undefined;
    const mark = !!mk && mk.s <= s && mk.e >= e;
    const last = out[out.length - 1];
    if (last && last.k === k && !!last.mark === mark) { last.e = e; continue; }
    const seg: Segment = { s, e };
    if (k) seg.k = k;
    if (mark) seg.mark = true;
    out.push(seg);
  }
  return out;
}
