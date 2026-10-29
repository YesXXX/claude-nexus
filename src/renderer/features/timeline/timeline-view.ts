import type { ActivityEvent, ActivityPush, ActivitySessionInfo } from '../../../shared/activity';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import {
  batchRecent, CATEGORIES, CATEGORY_TEXT, dayKey, dayLabel, emptyFilter, eventsToText, iconOf, isAttention,
  isFilterEmpty, matchesFilter, mergeEvents, sessionHue, timeText, toQuery, type TimelineCategory, type TimelineFilter,
} from './timeline-filter.js';
import { buildDropdown, type Dropdown } from './timeline-dropdown.js';

/**
 * 时间线视图：占据详情区，按时间倒序、按天分组列出活动事件。
 * - 打开时按当前过滤条件向主进程查询首屏 200 条，滚到底部或点「加载更早」按 beforeSeq 翻页；
 * - 打开期间增量推送只替换或插入对应行，不整表重绘；列表不在顶部时新事件先排队，顶部浮出「N 条新事件」；
 * - 关闭期间不碰 DOM，再次打开时重新查询一次。
 */

const PAGE = 200;
const TOP_SLACK = 4;
const BOTTOM_SLACK = 120;

export interface TimelineViewDeps {
  /** 点击事件行：跳到会话或子代理，返回是否成功 */
  jump(e: ActivityEvent): boolean;
  /** 会话是否仍在会话列表中 */
  alive(sessionId: string): boolean;
  onClose(): void;
}

export interface TimelineView {
  open(filter?: Partial<TimelineFilter>): void;
  close(): void;
  isOpen(): boolean;
  /** 收起展开中的下拉菜单，有收起的返回 true */
  closeDropdown(): boolean;
  onPush(p: ActivityPush): void;
  /** 会话列表变化：刷新各行的「已结束」标记 */
  refreshAlive(): void;
}

export function createTimelineView(ctx: AppContext, host: HTMLElement, deps: TimelineViewDeps): TimelineView {
  let filter: TimelineFilter = emptyFilter();
  let events: ActivityEvent[] = [];
  let pending: ActivityEvent[] = [];
  const rows = new Map<string, HTMLElement>();
  const expanded = new Set<string>();
  let hasMore = false;
  let loading = false;
  let opened = false;
  let req = 0;
  let sessionInfo: ActivitySessionInfo[] = [];

  // ---- 页头：标题、过滤、菜单 ----
  const head = el('header', 'd-h atl-head');
  const title = el('h2', 'atl-title', '活动时间线');
  const count = el('span', 'atl-count');
  count.id = 'atl-count';

  const sessDd: Dropdown = buildDropdown('atl-sessions', () => sessionSummary());
  const catDd: Dropdown = buildDropdown('atl-cats', () => categorySummary());
  const attnLabel = el('label', 'atl-attn');
  const attn = el('input') as HTMLInputElement;
  attn.type = 'checkbox';
  attn.id = 'atl-attn';
  attnLabel.append(attn, el('span', '', '仅需关注'));
  const menu = buildDropdown('atl-menu', () => '⋯');
  menu.root.classList.add('atl-more-menu');
  menu.root.title = '更多';
  const bClear = el('button', 'atl-mi', '清空时间线');
  bClear.type = 'button';
  bClear.id = 'atl-clear';
  const bCopy = el('button', 'atl-mi', '复制可见事件为文本');
  bCopy.type = 'button';
  bCopy.id = 'atl-copy';
  menu.menu.append(bCopy, bClear);
  const bClose = el('button', 'btn sm', '关闭');
  bClose.type = 'button';
  bClose.id = 'atl-close';
  bClose.title = '关闭时间线（Esc）';
  head.append(title, count, el('span', 'sp'), sessDd.root, catDd.root, attnLabel, menu.root, bClose);

  const newBtn = el('button', 'atl-new');
  newBtn.type = 'button';
  newBtn.id = 'atl-new';
  newBtn.hidden = true;
  const list = el('div', 'atl-list');
  list.id = 'atl-list';
  list.setAttribute('role', 'list');
  list.tabIndex = -1;
  const foot = el('div', 'atl-foot');
  const more = el('button', 'btn sm atl-load', '加载更早');
  more.type = 'button';
  more.id = 'atl-load-more';
  more.hidden = true;
  const empty = el('div', 'atl-empty');
  empty.id = 'atl-empty';
  empty.hidden = true;
  foot.append(empty, more);
  const body = el('div', 'atl-body');
  body.append(newBtn, list);
  host.append(head, body);

  function sessionSummary(): string {
    if (filter.sessionIds.length === 0) return '会话：全部';
    if (filter.sessionIds.length === 1) {
      const id = filter.sessionIds[0];
      const label = sessionInfo.find(s => s.id === id)?.label ?? events.find(e => e.sessionId === id)?.sessionLabel ?? id.slice(0, 8);
      return `会话：${label}`;
    }
    return `会话：${filter.sessionIds.length} 个`;
  }

  function categorySummary(): string {
    if (filter.categories.length === 0) return '类别：全部';
    if (filter.categories.length === 1) return `类别：${CATEGORY_TEXT[filter.categories[0]]}`;
    return `类别：${filter.categories.length} 类`;
  }

  // ---- 行 ----
  function buildRow(e: ActivityEvent): HTMLElement {
    const row = el('div', `atl-row lv-${e.level}${isAttention(e) ? ' attn' : ''}`);
    row.dataset.id = e.id;
    row.dataset.type = e.type;
    if (e.sessionId) row.dataset.session = e.sessionId;
    row.setAttribute('role', 'listitem');
    const ended = !!e.sessionId && !deps.alive(e.sessionId);
    if (ended) row.classList.add('ended');
    row.append(el('span', 'atl-time', timeText(e)));
    const sess = el('span', 'atl-sess');
    const dot = el('span', 'atl-dot');
    if (e.sessionId) dot.style.setProperty('--c', `hsl(${sessionHue(e.sessionId)} 55% 62%)`);
    sess.append(dot);
    const label = e.sessionId ? (e.sessionLabel ?? e.sessionId.slice(0, 8)) : '全局';
    sess.append(el('span', 'atl-label', label));
    sess.append(el('span', 'atl-ended', '（已结束）'));
    sess.title = e.cwdTail ? `${label} · ${e.cwdTail}` : label;
    row.append(sess, el('span', 'atl-ic', iconOf(e.type)));
    const main = el('span', 'atl-main');
    main.append(el('span', 'atl-t', e.title));
    if (e.detail) main.append(el('span', 'atl-d', e.detail));
    row.append(main);
    if (e.type === 'tool.batch') {
      const exp = el('button', 'atl-exp', expanded.has(e.id) ? '▾' : '▸');
      exp.type = 'button';
      exp.title = '展开最近的工具调用';
      row.append(exp);
      const rec = el('div', 'atl-recent');
      rec.hidden = !expanded.has(e.id);
      for (const line of batchRecent(e)) rec.append(el('div', 'atl-rl', line));
      row.append(rec);
    }
    return row;
  }

  function dayHeader(ts: number): HTMLElement {
    const h = el('div', 'atl-day', dayLabel(ts));
    h.dataset.day = dayKey(ts);
    return h;
  }

  /** 把一段按 seq 倒序的事件追加到列表末尾（翻页或首屏） */
  function appendEvents(batch: ActivityEvent[]): void {
    const frag = document.createDocumentFragment();
    let lastDay = lastRowDay();
    for (const e of batch) {
      const k = dayKey(e.at);
      if (k !== lastDay) { frag.append(dayHeader(e.at)); lastDay = k; }
      const row = buildRow(e);
      rows.set(e.id, row);
      frag.append(row);
    }
    list.insertBefore(frag, foot);
  }

  function lastRowDay(): string | null {
    for (let n = foot.previousElementSibling; n; n = n.previousElementSibling) {
      const h = n as HTMLElement;
      if (h.classList.contains('atl-day')) return h.dataset.day ?? null;
    }
    return null;
  }

  /** 新事件插到顶部（同一天的放在当天标题之后） */
  function prependEvent(e: ActivityEvent): void {
    const row = buildRow(e);
    rows.set(e.id, row);
    const first = list.firstElementChild as HTMLElement | null;
    const k = dayKey(e.at);
    if (first && first.classList.contains('atl-day') && first.dataset.day === k) first.after(row);
    else list.prepend(dayHeader(e.at), row);
  }

  function updateFoot(): void {
    list.setAttribute('aria-busy', String(loading));
    more.hidden = !hasMore;
    const none = events.length === 0 && pending.length === 0 && !loading;
    empty.hidden = !none;
    empty.textContent = isFilterEmpty(filter) ? '还没有活动事件' : '没有符合过滤条件的事件';
    count.textContent = events.length > 0 ? `${events.length}${hasMore ? '+' : ''} 条` : '';
  }

  function updateNewBtn(): void {
    newBtn.hidden = pending.length === 0;
    newBtn.textContent = `↑ ${pending.length} 条新事件`;
  }

  function atTop(): boolean {
    return list.scrollTop <= TOP_SLACK;
  }

  function flushPending(): void {
    if (pending.length === 0) return;
    const batch = pending.sort((a, b) => a.seq - b.seq);
    pending = [];
    for (const e of batch) prependEvent(e);
    events = mergeEvents(events, batch);
    updateNewBtn();
    updateFoot();
  }

  // ---- 数据 ----
  async function reload(): Promise<void> {
    const my = ++req;
    loading = true;
    list.setAttribute('aria-busy', 'true');
    try {
      const r = await ctx.api.activity.query({ ...toQuery(filter), limit: PAGE });
      if (my !== req || !opened) return;
      list.replaceChildren(foot);
      rows.clear();
      pending = [];
      events = r.events;
      hasMore = r.hasMore;
      appendEvents(events);
      list.scrollTop = 0;
    } catch (err) {
      if (my !== req) return;
      ctx.toast(`读取时间线失败：${ipcErrorText(err)}`, 'warning');
    } finally {
      if (my === req) loading = false;
      if (my === req) { updateFoot(); updateNewBtn(); }
    }
  }

  async function loadMore(): Promise<void> {
    if (loading || !hasMore || events.length === 0) return;
    const my = req;
    loading = true;
    more.disabled = true;
    try {
      const before = events[events.length - 1].seq;
      const r = await ctx.api.activity.query({ ...toQuery(filter), limit: PAGE, beforeSeq: before });
      if (my !== req || !opened) return;
      const fresh = r.events.filter(e => !rows.has(e.id));
      events = events.concat(fresh);
      hasMore = r.hasMore;
      appendEvents(fresh);
    } catch (err) {
      ctx.toast(`读取更早的事件失败：${ipcErrorText(err)}`, 'warning');
    } finally {
      if (my === req) loading = false;
      more.disabled = false;
      updateFoot();
    }
  }

  function setFilter(next: TimelineFilter): void {
    filter = next;
    sessDd.refreshSummary();
    catDd.refreshSummary();
    attn.checked = filter.attentionOnly;
    if (opened) void reload();
  }

  // ---- 过滤控件 ----
  async function fillSessions(): Promise<void> {
    try { sessionInfo = await ctx.api.activity.sessions(); } catch { sessionInfo = []; }
    const selected = new Set(filter.sessionIds);
    const items = sessionInfo.map(s => ({
      value: s.id, text: s.alive ? s.label : `${s.label}（已结束）`, checked: selected.has(s.id),
    }));
    // 过滤里仍选着、但日志里已没有的会话也列出来，便于取消
    for (const id of selected) if (!sessionInfo.some(s => s.id === id)) items.push({ value: id, text: id.slice(0, 8), checked: true });
    sessDd.setOptions(items, vals => setFilter({ ...filter, sessionIds: vals }));
  }
  sessDd.root.addEventListener('toggle', () => { if (sessDd.root.open) void fillSessions(); });
  catDd.setOptions(
    CATEGORIES.map(c => ({ value: c, text: CATEGORY_TEXT[c], checked: false })),
    vals => setFilter({ ...filter, categories: vals as TimelineCategory[] }),
  );
  attn.addEventListener('change', () => setFilter({ ...filter, attentionOnly: attn.checked }));

  bCopy.addEventListener('click', () => {
    menu.root.open = false;
    const text = eventsToText(events);
    navigator.clipboard.writeText(text).then(
      () => ctx.toast(`已复制 ${events.length} 条事件`, 'info'),
      err => ctx.toast(`复制失败：${String(err)}`, 'warning'),
    );
  });
  bClear.addEventListener('click', () => {
    menu.root.open = false;
    void ctx.confirm({
      title: '清空活动时间线？', message: '所有会话的活动记录都会被删除，且无法恢复。', okText: '清空', danger: true,
    }).then(ok => { if (ok) void ctx.api.activity.clear(); });
  });
  bClose.addEventListener('click', () => api.close());
  newBtn.addEventListener('click', () => { list.scrollTop = 0; flushPending(); });
  more.addEventListener('click', () => void loadMore());
  list.addEventListener('scroll', () => {
    if (atTop()) flushPending();
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - BOTTOM_SLACK) void loadMore();
  });
  list.addEventListener('click', ev => {
    const t = ev.target as HTMLElement;
    const row = t.closest<HTMLElement>('.atl-row');
    if (!row) return;
    const id = row.dataset.id!;
    if (t.closest('.atl-exp')) {
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      const rec = row.querySelector<HTMLElement>('.atl-recent');
      if (rec) rec.hidden = !expanded.has(id);
      const b = row.querySelector('.atl-exp');
      if (b) b.textContent = expanded.has(id) ? '▾' : '▸';
      return;
    }
    const e = events.find(x => x.id === id);
    if (!e) return;
    if (!e.sessionId || !deps.jump(e)) ctx.toast('会话已结束，无法跳转', 'info');
  });

  const api: TimelineView = {
    closeDropdown() {
      const openDd = host.querySelector<HTMLDetailsElement>('details[open]');
      if (!openDd) return false;
      openDd.open = false;
      return true;
    },
    open(f) {
      if (f) filter = { ...emptyFilter(), ...f };
      catDd.setChecked(filter.categories);
      sessDd.refreshSummary();
      catDd.refreshSummary();
      attn.checked = filter.attentionOnly;
      opened = true;
      host.hidden = false;
      void reload();
      list.focus({ preventScroll: true });
    },
    close() {
      if (!opened) return;
      opened = false;
      req++;
      host.hidden = true;
      for (const d of host.querySelectorAll('details')) d.open = false;
      list.replaceChildren(foot);
      rows.clear();
      events = [];
      pending = [];
      deps.onClose();
    },
    isOpen: () => opened,
    onPush(p) {
      if (!opened) return;
      if (p.cleared) {
        events = [];
        pending = [];
        rows.clear();
        expanded.clear();
        hasMore = false;
        list.replaceChildren(foot);
      }
      const topSeq = events.length > 0 ? events[0].seq : 0;
      for (const e of p.upserts) {
        if (!matchesFilter(e, filter)) continue;
        const row = rows.get(e.id);
        if (row) {
          const next = buildRow(e);
          row.replaceWith(next);
          rows.set(e.id, next);
          events = mergeEvents(events, [e]);
          continue;
        }
        const pi = pending.findIndex(x => x.id === e.id);
        if (pi >= 0) { pending[pi] = e; continue; }
        // 比当前最早一页还旧的事件不插入，等翻页时再取
        if (e.seq > topSeq) pending.push(e);
      }
      if (atTop()) flushPending();
      else updateNewBtn();
      updateFoot();
    },
    refreshAlive() {
      if (!opened) return;
      for (const row of rows.values()) {
        const sid = row.dataset.session;
        if (sid) row.classList.toggle('ended', !deps.alive(sid));
      }
    },
  };
  return api;
}
