import { cwdBaseName, longDuration } from '../../../shared/session-view.js';
import { endKindOf } from '../../../shared/session-records.js';
import {
  END_KIND_TEXT, endKindText, promptSummary, RANGE_TEXT, rangeSince, recordDurationMs, recordEndTime,
  type HistoryRange,
} from '../../../shared/history-view.js';
import type { EndKind, HistoryMeta, RecordQuery, ResumeCheck, SessionRecord } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { renderDetail, type DetailHost } from './detail.js';
import { buildFooter } from './footer.js';

/**
 * 会话历史面板：顶部搜索与过滤（目录、时间范围、结束状态），左侧列表，右侧详情，底部保留策略与清空。
 * 搜索在主进程内存里做（多个词按 AND），输入防抖后重新查询；记录变化推送时面板打开则刷新。
 * 记录模块不可用时显示降级横幅，过滤与动作禁用，其余功能不受影响。
 */

const PAGE = 200;
const SEARCH_DEBOUNCE_MS = 120;
const CHANGE_DEBOUNCE_MS = 250;
const KINDS: EndKind[] = ['killed', 'error', 'quit', 'migrated'];
const RANGES: HistoryRange[] = ['today', '7d', '30d', 'all'];

let current: { reload(): void; select(id: string): void; close(): void } | null = null;

export function isHistoryOpen(): boolean {
  return current !== null;
}

/** 记录变化推送：面板打开时刷新 */
export function notifyRecordsChanged(): void {
  current?.reload();
}

function relTime(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} 小时前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

function listItem(r: SessionRecord, selected: boolean, onPick: () => void): HTMLElement {
  const li = el('li', `hist-item${selected ? ' on' : ''}`);
  li.dataset.record = r.id;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', String(selected));
  const top = el('div', 'hist-i-top');
  if (r.pinned) top.append(el('span', 'hist-pin', '固定'));
  top.append(el('span', 'hist-i-label', r.label || '未命名会话'));
  top.append(el('span', `hist-kind k-${endKindOf(r)}`, endKindText(r)));
  top.append(el('span', 'hist-i-time', relTime(recordEndTime(r))));
  li.append(top);
  const p = promptSummary(r.firstPrompt, 90);
  li.append(el('div', 'hist-i-prompt', p || '（没有记录到提示词）'));
  const bits = [cwdBaseName(r.cwd) || r.cwd, r.worktree?.branch ?? '', longDuration(recordDurationMs(r))].filter(Boolean);
  const meta = el('div', 'hist-i-meta', bits.join(' · '));
  meta.title = r.cwd;
  li.append(meta);
  li.addEventListener('click', onPick);
  return li;
}

export function openHistory(ctx: AppContext, opts: { recordId?: string } = {}): void {
  if (current) {
    if (opts.recordId) current.select(opts.recordId);
    return;
  }
  const prevFocus = document.activeElement as HTMLElement | null;
  const backdrop = el('div', 'modal-backdrop history-backdrop');
  backdrop.id = 'history-backdrop';
  const modal = el('div', 'modal history-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'history-title');

  const head = el('div', 'hist-head');
  const title = el('h2', 'hist-title', '会话历史');
  title.id = 'history-title';
  const count = el('span', 'hist-count');
  count.id = 'history-count';
  const bClose = el('button', 'btn white', '关闭');
  bClose.type = 'button';
  bClose.id = 'history-close';
  head.append(title, count, el('span', 'sp'), bClose);

  const banner = el('div', 'hist-banner');
  banner.id = 'history-banner';
  banner.hidden = true;

  const filters = el('div', 'hist-filters');
  const search = el('input', 'hist-search') as HTMLInputElement;
  search.id = 'history-search';
  search.type = 'search';
  search.placeholder = '搜索标签、提示词、目录、分支（空格分隔多个词）';
  search.spellcheck = false;
  const cwdSel = el('select', 'hist-select') as HTMLSelectElement;
  cwdSel.id = 'history-cwd';
  cwdSel.title = '按目录过滤';
  const rangeBox = el('div', 'hist-range');
  rangeBox.id = 'history-range';
  const kindSel = el('select', 'hist-select') as HTMLSelectElement;
  kindSel.id = 'history-kind';
  kindSel.title = '按结束状态过滤';
  kindSel.append(new Option('全部状态', ''));
  for (const k of KINDS) kindSel.append(new Option(END_KIND_TEXT[k], k));
  filters.append(search, cwdSel, rangeBox, kindSel);

  const body = el('div', 'hist-body');
  const listWrap = el('div', 'hist-list-wrap');
  const list = el('ul', 'hist-list');
  list.id = 'history-list';
  list.setAttribute('role', 'listbox');
  const more = el('button', 'btn sm hist-more', '加载更多');
  more.type = 'button';
  more.id = 'history-more';
  more.hidden = true;
  const err = el('div', 'form-error hist-err');
  err.hidden = true;
  listWrap.append(list, more, err);
  const detail = el('div', 'hist-detail');
  detail.id = 'history-detail';
  body.append(listWrap, detail);

  let meta: HistoryMeta | null = null;
  let items: SessionRecord[] = [];
  let total = 0;
  let selectedId: string | null = opts.recordId ?? null;
  let range: HistoryRange = 'all';
  let seq = 0;
  let searchTimer: number | undefined;
  let changeTimer: number | undefined;
  const checks = new Map<string, ResumeCheck>();
  const degraded = (): boolean => !!meta && !meta.ok;

  for (const r of RANGES) {
    const b = el('button', 'hist-seg', RANGE_TEXT[r]);
    b.type = 'button';
    b.dataset.range = r;
    b.addEventListener('click', () => { range = r; paintRange(); void load(false); });
    rangeBox.append(b);
  }
  const paintRange = (): void => {
    for (const b of rangeBox.querySelectorAll<HTMLElement>('.hist-seg')) b.classList.toggle('on', b.dataset.range === range);
  };

  const query = (offset: number): RecordQuery => {
    const q: RecordQuery = { states: ['ended'], sort: 'ended', pinnedFirst: true, limit: PAGE, offset };
    if (search.value.trim()) q.text = search.value.trim();
    if (cwdSel.value) q.cwd = cwdSel.value;
    const since = rangeSince(range);
    if (since !== undefined) q.since = since;
    if (kindSel.value) q.endKinds = [kindSel.value as EndKind];
    return q;
  };

  const host: DetailHost = {
    ctx,
    close: () => close(),
    reload: () => { void load(false); },
    check: id => checks.get(id),
    degraded,
  };

  const selected = (): SessionRecord | undefined => items.find(r => r.id === selectedId);

  const paintDetail = (): void => {
    const r = selected();
    renderDetail(host, detail, r);
    if (r && !checks.has(r.id)) {
      const key = r.id;
      void ctx.api.resumeCheck(key).then(c => {
        checks.set(key, c);
        if (current && selectedId === key) renderDetail(host, detail, selected());
      }).catch(() => undefined);
    }
  };

  const paintList = (): void => {
    list.replaceChildren();
    if (!items.length) {
      const empty = degraded() ? '会话历史暂不可用'
        : search.value.trim() || cwdSel.value || kindSel.value || range !== 'all' ? '没有符合条件的历史' : '还没有已结束的会话';
      list.append(el('li', 'hist-none', empty));
    }
    for (const r of items) list.append(listItem(r, r.id === selectedId, () => pick(r.id)));
    more.hidden = items.length >= total;
    const all = meta?.total ?? total;
    count.textContent = total === all ? `共 ${all} 条` : `${total} / ${all} 条`;
    list.querySelector<HTMLElement>('.hist-item.on')?.scrollIntoView({ block: 'nearest' });
  };

  const pick = (id: string): void => {
    if (selectedId === id) return;
    selectedId = id;
    paintList();
    paintDetail();
  };

  const paintMeta = (): void => {
    if (!meta) return;
    banner.hidden = meta.ok && meta.skipped === 0;
    banner.classList.toggle('warn', meta.ok);
    banner.textContent = meta.ok
      ? `有 ${meta.skipped} 个记录文件损坏，已跳过（改名为 .bad 留档）`
      : `会话历史不可用：${meta.reason ?? '未知原因'}。会话的创建与运行不受影响`;
    for (const c of [search, cwdSel, kindSel]) c.disabled = !meta.ok;
    for (const b of rangeBox.querySelectorAll<HTMLButtonElement>('button')) b.disabled = !meta.ok;
    const keep = cwdSel.value;
    cwdSel.replaceChildren(new Option('全部目录', ''));
    for (const c of meta.cwds) {
      const o = new Option(cwdBaseName(c) || c, c);
      o.title = c;
      cwdSel.append(o);
    }
    cwdSel.value = meta.cwds.includes(keep) ? keep : '';
    footer.paint(meta);
  };

  const load = async (append: boolean): Promise<void> => {
    const my = ++seq;
    try {
      const [m, page] = await Promise.all([
        ctx.api.historyMeta(),
        ctx.api.recordsList(query(append ? items.length : 0)),
      ]);
      if (my !== seq || !current) return;
      meta = m;
      paintMeta();
      items = append ? [...items, ...page.items] : page.items;
      total = page.total;
      err.hidden = true;
      if (!items.some(r => r.id === selectedId)) selectedId = items[0]?.id ?? null;
      checks.clear();
      paintList();
      paintDetail();
    } catch (e) {
      if (my !== seq) return;
      err.hidden = false;
      err.textContent = ipcErrorText(e);
    }
  };

  const footer = buildFooter(ctx, { degraded, reload: () => void load(false) });

  modal.append(head, banner, filters, body, footer.el);
  backdrop.append(modal);

  const move = (delta: 1 | -1): void => {
    if (!items.length) return;
    const i = items.findIndex(r => r.id === selectedId);
    const next = items[Math.min(items.length - 1, Math.max(0, i < 0 ? 0 : i + delta))];
    if (next) pick(next.id);
  };

  const close = (): void => {
    window.clearTimeout(searchTimer);
    window.clearTimeout(changeTimer);
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    current = null;
    prevFocus?.focus?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    // 确认框盖在上面时按键交给确认框
    if (!(document.getElementById('confirm-backdrop')?.hidden ?? true)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && document.activeElement === search) {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    }
  };

  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void load(false), SEARCH_DEBOUNCE_MS);
  });
  cwdSel.addEventListener('change', () => void load(false));
  kindSel.addEventListener('change', () => void load(false));
  more.addEventListener('click', () => void load(true));
  bClose.addEventListener('click', close);
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  current = {
    reload: () => {
      window.clearTimeout(changeTimer);
      changeTimer = window.setTimeout(() => void load(false), CHANGE_DEBOUNCE_MS);
    },
    select: id => {
      if (items.some(r => r.id === id)) pick(id);
      else {
        // 目标不在当前过滤结果里：清掉过滤条件再查
        selectedId = id;
        search.value = '';
        cwdSel.value = '';
        kindSel.value = '';
        range = 'all';
        paintRange();
        void load(false);
      }
    },
    close,
  };
  paintRange();
  renderDetail(host, detail, undefined);
  search.focus();
  void load(false);
}
