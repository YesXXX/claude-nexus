import type { DiffLine } from './types';
import { CSS_SPEC, JAVA_SPEC, JSON_SPEC, JS_SPEC, PY_SPEC, SQL_SPEC, type CodeSpec } from './syntax-rules.js';
import { INITIAL_STATE, lexCode, type Lang, type LexState, type Token } from './syntax-lex.js';
import { lexMarkup, lexMd, lexVue } from './syntax-markup.js';
import { lineText } from './diff-layout.js';

/**
 * 语法分词入口：扩展名到语言的映射、逐行分词与按 diff 分块的双流分词。
 * 只输出 {起, 止, 类别} 区间，不碰 DOM；颜色只作辅助，文本始终原样显示。
 */

export { INITIAL_STATE };
export type { Lang, LexState, Token, TokenKind } from './syntax-lex.js';

/** 单行超过这个长度不着色（状态照常推进） */
export const MAX_HIGHLIGHT_LINE = 1000;
/** 单个文件 diff 文本总长超过这个值时整体关闭高亮 */
export const MAX_HIGHLIGHT_TOTAL = 400_000;

const EXT_LANG: Record<string, Lang> = {
  ts: 'js', tsx: 'js', mts: 'js', cts: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  java: 'java',
  py: 'py', pyw: 'py', pyi: 'py',
  vue: 'vue',
  json: 'json', jsonc: 'json', json5: 'json',
  sql: 'sql',
  css: 'css', scss: 'css', less: 'css',
  md: 'md', markdown: 'md',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', xhtml: 'markup',
};

const CODE_SPECS: Partial<Record<Lang, CodeSpec>> = {
  js: JS_SPEC, java: JAVA_SPEC, py: PY_SPEC, json: JSON_SPEC, sql: SQL_SPEC, css: CSS_SPEC,
};

/** 按扩展名识别语言，未识别返回 undefined（按纯文本显示） */
export function langOf(path: string): Lang | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 && !base.startsWith('.')) return undefined;
  return EXT_LANG[base.slice(dot + 1).toLowerCase()];
}

/** 分词一行：返回区间与下一行的起始状态；超长行不返回区间 */
export function tokenizeLine(lang: Lang, text: string, state: LexState): { tokens: Token[]; state: LexState } {
  const out: Token[] = [];
  let next: LexState;
  if (lang === 'vue') next = lexVue(text, state, out);
  else if (lang === 'md') next = lexMd(text, state, out);
  else if (lang === 'markup') next = lexMarkup(text, 0, text.length, state, out, false).st;
  else {
    const spec = CODE_SPECS[lang];
    next = spec ? lexCode(spec, text, 0, text.length, state, out) : state;
  }
  return { tokens: text.length > MAX_HIGHLIGHT_LINE ? [] : out, state: next };
}

/** 一行在旧版与新版两条流中的区间：删除行只有 old，新增行只有 new，上下文行两者都有，元信息行都没有 */
export interface LineTokens { old?: Token[]; new?: Token[]; }

function sameState(a: LexState, b: LexState): boolean {
  return a.mode === b.mode && a.depth === b.depth && a.quote === b.quote && a.embed === b.embed;
}

/**
 * 一个分块按「旧流 = 上下文 + 删除」「新流 = 上下文 + 新增」分别推进状态，
 * 删除行里没闭合的注释不会染到新增行；每个分块都从初始状态开始。
 * 按需推进：取第 i 行时只分词到第 i 行，供界面只画可视区附近时少做无用功。
 */
export interface HunkTokenizer { at(i: number): LineTokens; }

export function hunkTokenizer(lang: Lang, lines: DiffLine[]): HunkTokenizer {
  let os = INITIAL_STATE;
  let ns = INITIAL_STATE;
  const out: LineTokens[] = [];
  const step = (l: DiffLine): LineTokens => {
    if (l.kind === 'meta') return {};
    const text = lineText(l);
    if (l.kind === 'ctx' && sameState(os, ns)) {
      const r = tokenizeLine(lang, text, os);
      os = r.state;
      ns = r.state;
      return { old: r.tokens, new: r.tokens };
    }
    const res: LineTokens = {};
    if (l.kind !== 'add') {
      const r = tokenizeLine(lang, text, os);
      os = r.state;
      res.old = r.tokens;
    }
    if (l.kind !== 'del') {
      const r = tokenizeLine(lang, text, ns);
      ns = r.state;
      res.new = r.tokens;
    }
    return res;
  };
  return {
    at(i: number): LineTokens {
      while (out.length <= i && out.length < lines.length) out.push(step(lines[out.length]));
      return out[i] ?? {};
    },
  };
}

export function tokenizeHunk(lang: Lang, lines: DiffLine[]): LineTokens[] {
  const t = hunkTokenizer(lang, lines);
  return lines.map((_, i) => t.at(i));
}
