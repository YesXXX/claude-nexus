import type { CodeSpec } from './syntax-rules';

/**
 * 代码类语言的通用扫描器：逐字符推进，只产出着色区间，不建 DOM。
 * 跨行结构（块注释、三引号、模板字符串及其 ${} 嵌套、css 花括号深度）记在 LexState 里，
 * 由调用方按旧版 / 新版两条流分别传递。
 */

export type Lang = 'js' | 'java' | 'py' | 'vue' | 'json' | 'sql' | 'css' | 'md' | 'markup';
export type TokenKind =
  | 'kw' | 'str' | 'num' | 'com' | 'type' | 'fn' | 'prop'
  | 'tag' | 'attr' | 'punct' | 'meta' | 'head' | 'code' | 'link';

/** 一行内的着色区间，s 含 e 不含，按 s 升序且互不重叠 */
export interface Token { s: number; e: number; k: TokenKind; }

/**
 * 跨行状态，可序列化。mode：code 普通、com 块注释、str 跨行引号、tpl 模板字符串正文、
 * tag 标签内属性区、fence 代码围栏。quote：跨行引号本身；js 族里是 ${} 嵌套的花括号计数栈（逗号分隔）；
 * 标签内是待切换的内嵌标签名。depth：css 花括号深度。embed：vue 中所处的内嵌语言。
 */
export interface LexState { mode: string; depth?: number; quote?: string; embed?: Lang; }

export const INITIAL_STATE: LexState = Object.freeze({ mode: 'code' }) as LexState;

/** 追加区间：空区间忽略，与上一个同类且相邻的合并 */
export function pushTok(out: Token[], s: number, e: number, k: TokenKind): void {
  if (e <= s) return;
  const last = out[out.length - 1];
  if (last && last.k === k && last.e === s) { last.e = e; return; }
  out.push({ s, e, k });
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const CSS_IDENT = /-{0,2}[A-Za-z_][\w-]*/y;
const NUM = /(?:0[xX][\da-fA-F_]+|0[bBoO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[a-zA-Z%]*/y;
const HEX_COLOR = /#[\da-fA-F]{3,8}(?![\w-])/y;
/** 正则字面量可以出现在这些字符之后（其余情况 / 按除号处理） */
const REGEX_AFTER = '(,=:[!&|?{};+-*%<>~^';
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

function matchAt(re: RegExp, text: string, i: number, end: number): number {
  re.lastIndex = i;
  const m = re.exec(text);
  if (!m || m.index !== i) return -1;
  return Math.min(end, i + m[0].length);
}

function nextNonSpace(text: string, i: number, end: number): string {
  while (i < end && (text[i] === ' ' || text[i] === '\t')) i++;
  return i < end ? text[i] : '';
}

/** 从 i（引号之后）找成对的结束引号，支持反斜杠转义；找不到返回 -1 */
function findClose(text: string, i: number, end: number, q: string): number {
  while (i < end) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text.startsWith(q, i) && i + q.length <= end) return i + q.length;
    i++;
  }
  return -1;
}

/** 正则字面量的结束位置（含 flags）；同一行内没闭合返回 -1 */
function scanRegex(text: string, i: number, end: number): number {
  let inClass = false;
  for (let j = i + 1; j < end; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      j++;
      while (j < end && /[a-z]/.test(text[j])) j++;
      return j;
    }
  }
  return -1;
}

function isLineComment(spec: CodeSpec, text: string, i: number, pos: number): boolean {
  for (const lc of spec.lineCom) {
    if (!text.startsWith(lc, i)) continue;
    if (!spec.lineComAfterSpace || i === pos || /\s/.test(text[i - 1])) return true;
  }
  return false;
}

function identKind(spec: CodeSpec, word: string, afterDot: boolean, next: string, depth: number): TokenKind | undefined {
  if (spec.css) {
    if (word.startsWith('--') || word.startsWith('$')) return 'prop';
    if (depth > 0 && next === ':') return 'prop';
    if (next === '(') return 'fn';
    if (depth === 0) return 'tag';
    return spec.keywords.has(word) ? 'kw' : undefined;
  }
  const key = spec.caseInsensitive ? word.toLowerCase() : word;
  if (!afterDot && spec.keywords.has(key)) return 'kw';
  if (next === '(') return 'fn';
  if (!afterDot && spec.types.has(key)) return 'type';
  if (spec.capType && /^[A-Z]/.test(word) && /[a-z]/.test(word)) return 'type';
  return undefined;
}

/**
 * 扫描 text 的 [pos, end) 区段，区间写入 out，返回扫描结束时的状态。
 * 代码类语言总是扫到 end；vue 内嵌 script / style 时由调用方限定 end。
 */
export function lexCode(spec: CodeSpec, text: string, pos: number, end: number, st: LexState, out: Token[]): LexState {
  let mode = st.mode === 'com' || st.mode === 'str' || st.mode === 'tpl' ? st.mode : 'code';
  let quote = spec.template ? undefined : st.quote;
  const tpl: number[] = spec.template && st.quote ? st.quote.split(',').map(Number) : [];
  let depth = st.depth ?? 0;
  let prevSig = '';
  let prevWord = '';
  let lastWasWord = false;
  let i = pos;
  while (i < end) {
    if (mode === 'com') {
      const close = spec.blockCom?.[1] ?? '*/';
      const j = text.indexOf(close, i);
      if (j < 0 || j + close.length > end) { pushTok(out, i, end, 'com'); i = end; break; }
      pushTok(out, i, j + close.length, 'com');
      i = j + close.length;
      mode = 'code';
      continue;
    }
    if (mode === 'str') {
      const j = findClose(text, i, end, quote ?? '"""');
      if (j < 0) { pushTok(out, i, end, 'str'); i = end; break; }
      pushTok(out, i, j, 'str');
      i = j;
      mode = 'code';
      quote = undefined;
      continue;
    }
    if (mode === 'tpl') {
      let j = i;
      let stop = -1;
      while (j < end) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '`' || (text[j] === '$' && text[j + 1] === '{' && j + 1 < end)) { stop = j; break; }
        j++;
      }
      if (stop < 0) { pushTok(out, i, end, 'str'); i = end; break; }
      if (text[stop] === '`') {
        pushTok(out, i, stop + 1, 'str');
        i = stop + 1;
        mode = 'code';
        prevSig = '`';
      } else {
        pushTok(out, i, stop, 'str');
        pushTok(out, stop, stop + 2, 'punct');
        i = stop + 2;
        tpl.push(0);
        mode = 'code';
        prevSig = '{';
      }
      lastWasWord = false;
      continue;
    }
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (isLineComment(spec, text, i, pos)) { pushTok(out, i, end, 'com'); i = end; break; }
    if (spec.blockCom && text.startsWith(spec.blockCom[0], i)) {
      const close = spec.blockCom[1];
      const j = text.indexOf(close, i + spec.blockCom[0].length);
      if (j < 0 || j + close.length > end) { pushTok(out, i, end, 'com'); mode = 'com'; i = end; break; }
      pushTok(out, i, j + close.length, 'com');
      i = j + close.length;
      continue;
    }
    const mq = spec.multiQuotes.find(q => text.startsWith(q, i));
    if (mq) {
      const j = findClose(text, i + mq.length, end, mq);
      if (j < 0) { pushTok(out, i, end, 'str'); mode = 'str'; quote = mq; i = end; break; }
      pushTok(out, i, j, 'str');
      i = j;
      prevSig = '"';
      lastWasWord = false;
      continue;
    }
    if (spec.template && c === '`') {
      pushTok(out, i, i + 1, 'str');
      i++;
      mode = 'tpl';
      continue;
    }
    if (spec.quotes.includes(c)) {
      let j = i + 1;
      while (j < end && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      const stop = Math.min(end, j + 1);
      pushTok(out, i, stop, spec.keyStrings && nextNonSpace(text, stop, end) === ':' ? 'prop' : 'str');
      i = stop;
      prevSig = c;
      lastWasWord = false;
      continue;
    }
    if (spec.template && c === '/') {
      const ok = lastWasWord ? REGEX_AFTER_WORD.has(prevWord) : prevSig === '' || REGEX_AFTER.includes(prevSig);
      const j = ok ? scanRegex(text, i, end) : -1;
      if (j > 0) {
        pushTok(out, i, j, 'str');
        i = j;
        prevSig = '/';
        lastWasWord = false;
        continue;
      }
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(text[i + 1] ?? ''))) {
      const j = matchAt(NUM, text, i, end);
      if (j > i) {
        pushTok(out, i, j, 'num');
        i = j;
        prevSig = '0';
        lastWasWord = false;
        continue;
      }
    }
    if (spec.css) {
      if (c === '#' && depth > 0) {
        const j = matchAt(HEX_COLOR, text, i, end);
        if (j > i) { pushTok(out, i, j, 'num'); i = j; continue; }
      }
      if ((c === '.' || c === '#') && depth === 0) {
        const j = matchAt(CSS_IDENT, text, i + 1, end);
        if (j > i + 1) { pushTok(out, i, j, 'attr'); i = j; continue; }
      }
      if (c === '@' || c === '!' || c === '$') {
        const j = matchAt(CSS_IDENT, text, i + 1, end);
        if (j > i + 1) { pushTok(out, i, j, c === '$' ? 'prop' : 'kw'); i = j; continue; }
      }
    } else if (spec.annotation && c === '@') {
      const j = matchAt(IDENT, text, i + 1, end);
      if (j > i + 1) { pushTok(out, i, j, 'meta'); i = j; lastWasWord = false; prevSig = 'a'; continue; }
    }
    const wj = matchAt(spec.css ? CSS_IDENT : IDENT, text, i, end);
    if (wj > i) {
      const word = text.slice(i, wj);
      const afterDot = prevSig === '.' && !lastWasWord;
      const k = identKind(spec, word, afterDot, nextNonSpace(text, wj, end), depth);
      if (k) pushTok(out, i, wj, k);
      i = wj;
      prevWord = word;
      prevSig = word[word.length - 1];
      lastWasWord = true;
      continue;
    }
    if (c === '{') {
      if (spec.css) depth++;
      if (tpl.length) tpl[tpl.length - 1]++;
    } else if (c === '}') {
      if (spec.css) depth = Math.max(0, depth - 1);
      if (tpl.length) {
        if (tpl[tpl.length - 1] === 0) {
          tpl.pop();
          pushTok(out, i, i + 1, 'punct');
          i++;
          mode = 'tpl';
          continue;
        }
        tpl[tpl.length - 1]--;
      }
    }
    prevSig = c;
    lastWasWord = false;
    i++;
  }
  const next: LexState = { mode };
  if (spec.template) { if (tpl.length) next.quote = tpl.join(','); }
  else if (mode === 'str' && quote) next.quote = quote;
  if (spec.css && depth > 0) next.depth = depth;
  return next;
}
