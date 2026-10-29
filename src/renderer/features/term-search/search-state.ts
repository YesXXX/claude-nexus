/**
 * 终端搜索的纯逻辑：查询状态、传给 SearchAddon 的选项、正则校验与计数文本。
 * 不访问 DOM，可以在 node 中单测。
 */

export interface SearchQueryState {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
}

export const EMPTY_QUERY: SearchQueryState = { query: '', caseSensitive: false, regex: false, wholeWord: false };

/** 搜索框里的一次操作：改输入文本或切换三个开关之一 */
export type QueryChange =
  | { kind: 'text'; query: string }
  | { kind: 'toggle'; option: 'caseSensitive' | 'regex' | 'wholeWord' };

export function nextQueryState(s: SearchQueryState, change: QueryChange): SearchQueryState {
  if (change.kind === 'text') return { ...s, query: change.query };
  return { ...s, [change.option]: !s[change.option] };
}

/** 高亮颜色兜底值：xterm 的装饰只接受 #RRGGBB；当前项用更亮的底色加边框，与其他匹配区分。界面按 --search-* 变量覆盖 */
export const SEARCH_DECORATIONS = {
  matchBackground: '#4a3d12',
  matchOverviewRuler: '#c99a1e',
  activeMatchBackground: '#8a5d00',
  activeMatchBorder: '#ffd866',
  activeMatchColorOverviewRuler: '#ffd866',
};

export interface AddonSearchOptions {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
  /** 边输入边搜：从当前匹配位置原地扩展，而不是跳到下一个 */
  incremental: boolean;
  decorations: typeof SEARCH_DECORATIONS;
}

/** 传给 findNext / findPrevious 的选项；必须带 decorations，结果计数事件才会触发 */
export function buildSearchOptions(
  s: SearchQueryState, incremental = false, decorations: typeof SEARCH_DECORATIONS = SEARCH_DECORATIONS,
): AddonSearchOptions {
  return {
    caseSensitive: s.caseSensitive,
    regex: s.regex,
    wholeWord: s.wholeWord,
    incremental,
    decorations,
  };
}

/** 查询是否可以交给搜索插件：空串不搜；正则模式下语法错误返回原因，不抛异常 */
export function validateQuery(s: SearchQueryState): { ok: true } | { ok: false; empty: boolean; error?: string } {
  if (!s.query) return { ok: false, empty: true };
  if (!s.regex) return { ok: true };
  try {
    new RegExp(s.query, s.caseSensitive ? 'g' : 'gi');
    return { ok: true };
  } catch (err) {
    return { ok: false, empty: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 计数文本：插件找到的匹配数以高亮上限封顶，当前项不在已高亮的结果里时 resultIndex 为 -1。
 * 没有结果时返回「无结果」。
 */
export function formatCount(resultIndex: number, resultCount: number, limit: number): string {
  if (resultCount <= 0) return '无结果';
  const total = resultCount >= limit ? `${limit}+` : String(resultCount);
  return resultIndex < 0 ? `-/${total}` : `${resultIndex + 1}/${total}`;
}
