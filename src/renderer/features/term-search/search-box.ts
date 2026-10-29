import type { ActiveTerminal } from '../../core/context.js';
import { el } from '../../core/dom.js';
import type { QueryChange, SearchQueryState } from './search-state.js';
import { buildSearchOptions, EMPTY_QUERY, formatCount, nextQueryState, SEARCH_DECORATIONS, validateQuery } from './search-state.js';

/** 按样式表的 --search-* 变量取高亮颜色，读不到的项用兜底值，换肤后下一次搜索即生效 */
function searchDecorations(): typeof SEARCH_DECORATIONS {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  const d = SEARCH_DECORATIONS;
  const border = v('--search-active-border', d.activeMatchBorder);
  return {
    matchBackground: v('--search-match-bg', d.matchBackground),
    matchOverviewRuler: v('--search-match-ruler', d.matchOverviewRuler),
    activeMatchBackground: v('--search-active-bg', d.activeMatchBackground),
    activeMatchBorder: border,
    activeMatchColorOverviewRuler: border,
  };
}

/**
 * 终端搜索框：浮在终端卡片右上角，不进入终端宿主，因此不影响 fit 计算。
 * 每个终端实例各自持有一个 SearchAddon 与查询状态，第一次打开搜索框时才加载；
 * 搜索框按卡片复用（父会话一个、子代理一个），打开时绑定到当前可见的终端。
 */

// SearchAddon 由 index.html 中的 wrapper script 挂到 window
declare const SearchAddon: any;

/** 高亮上限：超过后计数显示「上限+」，避免长滚动历史里装饰过多拖慢渲染 */
const HIGHLIGHT_LIMIT = 1000;

interface TermSlot {
  term: any;
  addon: any;
  q: SearchQueryState;
  count: string;
  /** 输入框标红：无匹配或正则无效 */
  bad: boolean;
  error?: string;
  /** 当前匹配所在的选区，用于终端改变行数后恢复 */
  sel?: { x: number; y: number; length: number; cols: number };
}

/** 记下终端当前选区（搜索插件把当前匹配做成选区） */
function rememberSelection(slot: TermSlot): void {
  const r = slot.term.getSelectionPosition?.();
  if (!r) { slot.sel = undefined; return; }
  const cols = slot.term.cols as number;
  slot.sel = { x: r.start.x, y: r.start.y, length: (r.end.y - r.start.y) * cols + (r.end.x - r.start.x), cols };
}

interface BoxUi {
  root: HTMLDivElement;
  input: HTMLInputElement;
  count: HTMLSpanElement;
  toggles: Record<'caseSensitive' | 'regex' | 'wholeWord', HTMLButtonElement>;
}

export interface TermSearch {
  open(t: ActiveTerminal): void;
  /** refocus 为 true 时把焦点还给终端 */
  close(refocus: boolean): void;
  /** 搜索框是否正为该终端打开 */
  isOpenFor(t: ActiveTerminal | null): boolean;
  step(dir: 1 | -1): void;
  /** 删除已不存在的终端的状态 */
  prune(alive: (key: string) => boolean): void;
}

export function createTermSearch(focusTerm: (t: ActiveTerminal) => void): TermSearch {
  const slots = new Map<string, TermSlot>();
  const boxes = new Map<HTMLElement, BoxUi>();
  let cur: { t: ActiveTerminal; slot: TermSlot; box: BoxUi } | null = null;

  const slotFor = (t: ActiveTerminal): TermSlot | null => {
    const old = slots.get(t.key);
    if (old && old.term === t.term) return old;
    if (typeof SearchAddon === 'undefined') return null;
    const addon = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT });
    t.term.loadAddon(addon);
    // 终端重建后沿用之前的查询文本与开关
    const slot: TermSlot = { term: t.term, addon, q: old?.q ?? EMPTY_QUERY, count: '', bad: false };
    addon.onDidChangeResults((e: { resultIndex: number; resultCount: number }) => {
      rememberSelection(slot);
      if (!slot.q.query || slot.error) return;
      slot.count = formatCount(e.resultIndex, e.resultCount, HIGHLIGHT_LIMIT);
      slot.bad = e.resultCount === 0;
      if (cur?.slot === slot) paint();
    });
    // xterm 在行数变化时会清掉选区（权限栏出现或收起都会改行数），而搜索插件以选区作为
    // 「当前匹配」的位置；列数没变时把选区放回原处，下一次跳转从原匹配继续而不是回到开头。
    // 终端的 resize 事件可能先于选区清除触发，所以放到下一轮任务里恢复
    t.term.onResize(() => {
      const sel = slot.sel;
      if (!sel) return;
      setTimeout(() => {
        if (cur?.slot !== slot || sel !== slot.sel || sel.cols !== slot.term.cols || slot.term.hasSelection()) return;
        try { slot.term.select(sel.x, sel.y, sel.length); } catch { /* 选区越界时放弃恢复 */ }
      }, 0);
    });
    slots.set(t.key, slot);
    return slot;
  };

  const paint = (): void => {
    if (!cur) return;
    const { slot, box } = cur;
    box.root.classList.toggle('bad', slot.bad);
    box.count.textContent = slot.count;
    box.count.title = slot.error ?? '';
    box.input.title = slot.error && slot.q.regex ? `正则无效：${slot.error}` : (slot.error ?? '');
    for (const k of ['caseSensitive', 'regex', 'wholeWord'] as const) {
      box.toggles[k].setAttribute('aria-pressed', String(slot.q[k]));
      box.toggles[k].classList.toggle('on', slot.q[k]);
    }
  };

  /** dir 为 0 表示原地刷新（输入或切换开关），1 / -1 为下一个 / 上一个 */
  const run = (dir: 0 | 1 | -1): void => {
    if (!cur) return;
    const { slot } = cur;
    const v = validateQuery(slot.q);
    slot.error = undefined;
    if (!v.ok) {
      slot.addon.clearDecorations();
      slot.bad = !v.empty;
      slot.error = v.error;
      slot.count = v.empty ? '' : '正则无效';
      paint();
      return;
    }
    const opts = buildSearchOptions(slot.q, dir === 0, searchDecorations());
    let found = false;
    try {
      found = dir === -1 ? slot.addon.findPrevious(slot.q.query, opts) : slot.addon.findNext(slot.q.query, opts);
    } catch (err) {
      slot.error = err instanceof Error ? err.message : String(err);
      slot.count = '搜索失败';
    }
    if (!found) {
      slot.bad = true;
      if (!slot.error) slot.count = '无结果';
    }
    paint();
  };

  const change = (c: QueryChange): void => {
    if (!cur) return;
    cur.slot.q = nextQueryState(cur.slot.q, c);
    run(0);
  };

  const button = (cls: string, text: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = el('button', `tsearch-btn ${cls}`, text);
    b.type = 'button';
    b.title = title;
    b.tabIndex = -1;
    // 按下时不抢走输入框焦点，点完仍可继续输入
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', onClick);
    return b;
  };

  const boxFor = (card: HTMLElement): BoxUi => {
    const hit = boxes.get(card);
    if (hit) return hit;
    const root = el('div', 'tsearch');
    root.dataset.role = 'term-search';
    root.hidden = true;
    const input = el('input', 'tsearch-input');
    input.placeholder = '在终端中搜索';
    input.spellcheck = false;
    input.autocomplete = 'off';
    const count = el('span', 'tsearch-count');
    const toggles = {
      caseSensitive: button('tsearch-case', 'Aa', '区分大小写', () => change({ kind: 'toggle', option: 'caseSensitive' })),
      regex: button('tsearch-regex', '.*', '正则表达式', () => change({ kind: 'toggle', option: 'regex' })),
      wholeWord: button('tsearch-word', '全词', '全词匹配', () => change({ kind: 'toggle', option: 'wholeWord' })),
    };
    root.append(
      input, count, toggles.caseSensitive, toggles.regex, toggles.wholeWord, el('span', 'tsearch-sep'),
      button('tsearch-prev', '↑', '上一个（Shift+Enter / Shift+F3）', () => run(-1)),
      button('tsearch-next', '↓', '下一个（Enter / F3）', () => run(1)),
      button('tsearch-close', '✕', '关闭（Esc）', () => api.close(true)),
    );
    input.addEventListener('input', () => change({ kind: 'text', query: input.value }));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); run(e.shiftKey ? -1 : 1); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); run(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); run(-1); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(true); }
    });
    card.appendChild(root);
    const ui: BoxUi = { root, input, count, toggles };
    boxes.set(card, ui);
    return ui;
  };

  const api: TermSearch = {
    open(t) {
      if (cur && cur.t.key !== t.key) api.close(false);
      const slot = slotFor(t);
      if (!slot) return;
      const box = boxFor(t.card);
      const reopening = !cur;
      cur = { t, slot, box };
      box.root.dataset.termKey = t.key;
      box.root.hidden = false;
      if (reopening) {
        box.input.value = slot.q.query;
        if (slot.q.query) run(0);
      }
      paint();
      box.input.focus();
      box.input.select();
    },
    close(refocus) {
      if (!cur) return;
      const { t, slot, box } = cur;
      cur = null;
      try {
        slot.addon.clearDecorations();
        slot.term.clearSelection();
      } catch { /* 终端已销毁时忽略 */ }
      box.root.hidden = true;
      if (refocus) focusTerm(t);
    },
    isOpenFor(t) {
      return !!cur && !!t && cur.t.key === t.key && cur.t.term === t.term && !cur.box.root.hidden;
    },
    step(dir) { run(dir); },
    prune(alive) {
      for (const key of [...slots.keys()]) {
        if (!alive(key)) slots.delete(key);
      }
    },
  };
  return api;
}
