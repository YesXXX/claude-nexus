import { CSS_SPEC, JS_SPEC } from './syntax-rules.js';
import { INITIAL_STATE, lexCode, pushTok, type LexState, type Token } from './syntax-lex.js';

/**
 * 标记类语言的扫描：html / xml 标签与属性、vue 单文件组件（script / style 段切换内嵌语言）、markdown。
 */

const TAG_OPEN = /<(\/?)([A-Za-z][\w:.-]*)/y;
const DECL = /<[!?][^>]*>?/y;
const ATTR = /[^\s"'=<>/]+/y;

function matchLen(re: RegExp, text: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  const m = re.exec(text);
  return m && m.index === i ? m : null;
}

/**
 * 扫描 [pos, end)。allowEmbed 为真时遇到 script / style 开始标签的结束 > 立即返回，
 * 返回的状态带 embed，由调用方切到内嵌语言继续扫描剩余部分。
 */
export function lexMarkup(
  text: string, pos: number, end: number, st: LexState, out: Token[], allowEmbed: boolean,
): { st: LexState; pos: number } {
  let mode = st.mode === 'com' || st.mode === 'tag' ? st.mode : 'code';
  let pending = mode === 'tag' ? st.quote : undefined;
  let afterEq = false;
  let i = pos;
  while (i < end) {
    if (mode === 'com') {
      const j = text.indexOf('-->', i);
      if (j < 0 || j + 3 > end) { pushTok(out, i, end, 'com'); i = end; break; }
      pushTok(out, i, j + 3, 'com');
      i = j + 3;
      mode = 'code';
      continue;
    }
    if (mode === 'tag') {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '>' || (c === '/' && text[i + 1] === '>')) {
        const len = c === '>' ? 1 : 2;
        pushTok(out, i, i + len, 'punct');
        i += len;
        mode = 'code';
        if (allowEmbed && pending && len === 1) {
          return { st: { mode: 'code', embed: pending === 'style' ? 'css' : 'js' }, pos: i };
        }
        pending = undefined;
        continue;
      }
      if (c === '"' || c === "'") {
        const j = text.indexOf(c, i + 1);
        const stop = j < 0 || j >= end ? end : j + 1;
        pushTok(out, i, stop, 'str');
        i = stop;
        afterEq = false;
        continue;
      }
      if (c === '=') { afterEq = true; i++; continue; }
      const m = matchLen(ATTR, text, i);
      if (m) {
        const stop = Math.min(end, i + m[0].length);
        pushTok(out, i, stop, afterEq ? 'str' : 'attr');
        i = stop;
        afterEq = false;
        continue;
      }
      i++;
      continue;
    }
    const j = text.indexOf('<', i);
    if (j < 0 || j >= end) { i = end; break; }
    i = j;
    if (text.startsWith('<!--', i)) {
      const k = text.indexOf('-->', i + 4);
      if (k < 0 || k + 3 > end) { pushTok(out, i, end, 'com'); mode = 'com'; i = end; break; }
      pushTok(out, i, k + 3, 'com');
      i = k + 3;
      continue;
    }
    const t = matchLen(TAG_OPEN, text, i);
    if (t) {
      const nameStart = i + 1 + t[1].length;
      const nameEnd = Math.min(end, i + t[0].length);
      pushTok(out, i, nameStart, 'punct');
      pushTok(out, nameStart, nameEnd, 'tag');
      i = nameEnd;
      mode = 'tag';
      afterEq = false;
      const name = t[2].toLowerCase();
      pending = !t[1] && (name === 'script' || name === 'style') ? name : undefined;
      continue;
    }
    const d = matchLen(DECL, text, i);
    if (d) {
      const stop = Math.min(end, i + d[0].length);
      pushTok(out, i, stop, 'meta');
      i = stop;
      continue;
    }
    i++;
  }
  const next: LexState = { mode };
  if (mode === 'tag' && pending) next.quote = pending;
  return { st: next, pos: i };
}

/** vue 单文件组件：标签区按标记规则，script 段按 js、style 段按 css，段落可在行中切换 */
export function lexVue(text: string, st: LexState, out: Token[]): LexState {
  let s = st;
  let pos = 0;
  const end = text.length;
  // 一行内切换次数有限，上限只防异常输入下的死循环
  for (let guard = 0; guard < 64; guard++) {
    if (s.embed) {
      const re = s.embed === 'css' ? /<\/style\s*>/gi : /<\/script\s*>/gi;
      re.lastIndex = pos;
      const m = re.exec(text);
      const stop = m ? m.index : end;
      const inner: LexState = { mode: s.mode };
      if (s.depth !== undefined) inner.depth = s.depth;
      if (s.quote !== undefined) inner.quote = s.quote;
      const after = lexCode(s.embed === 'css' ? CSS_SPEC : JS_SPEC, text, pos, stop, inner, out);
      if (!m) return { ...after, embed: s.embed };
      s = INITIAL_STATE;
      pos = stop;
      continue;
    }
    const r = lexMarkup(text, pos, end, s, out, true);
    s = r.st;
    pos = r.pos;
    if (!s.embed || pos >= end) return s;
  }
  return s;
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const MARKER = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])(?=\s)|^\s*(?:>\s*)+/;
const INLINE = /(`+)[^`]*?\1|!?\[[^\]\n]*\]\([^)\n]*\)|<https?:\/\/[^>\s]+>/g;

/** markdown：标题整行、围栏内整行（不再细分）、列表与引用符、行内代码与链接 */
export function lexMd(text: string, st: LexState, out: Token[]): LexState {
  const len = text.length;
  if (st.mode === 'fence') {
    const fence = st.quote ?? '```';
    if (text.trimStart().startsWith(fence)) { pushTok(out, 0, len, 'meta'); return INITIAL_STATE; }
    pushTok(out, 0, len, 'code');
    return st;
  }
  const f = FENCE.exec(text);
  if (f) {
    pushTok(out, 0, len, 'meta');
    return { mode: 'fence', quote: f[1] };
  }
  if (HEADING.test(text)) { pushTok(out, 0, len, 'head'); return INITIAL_STATE; }
  if (RULE.test(text)) { pushTok(out, 0, len, 'punct'); return INITIAL_STATE; }
  let from = 0;
  const mk = MARKER.exec(text);
  if (mk) {
    const s = mk[0].length - mk[0].trimStart().length;
    pushTok(out, s, mk[0].length, 'punct');
    from = mk[0].length;
  }
  INLINE.lastIndex = from;
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    pushTok(out, m.index, m.index + m[0].length, m[0].startsWith('`') ? 'code' : 'link');
  }
  return INITIAL_STATE;
}
