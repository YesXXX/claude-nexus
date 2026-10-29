import type { ActivityEvent } from '../../../shared/activity';
import type { Session } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import { el } from '../../core/dom.js';
import { on } from '../../core/events.js';
import type { PaletteItem } from '../../core/registry.js';
import { clockText, iconOf, mergeEvents } from './timeline-filter.js';
import { createTimelineView, type TimelineView } from './timeline-view.js';

/**
 * 跨会话活动时间线：占据详情区的顶级视图，会话列表保持可见。
 * 入口有导航轨按钮、Ctrl+Shift+L、命令面板「打开活动时间线」「查看本会话时间线」，
 * 以及属性面板「最近活动」节标题右侧的「全部」。选中会话、回到首页或点会话列表即离开时间线。
 */

export const TIMELINE_PANEL_OPENER = 'timeline.panel';
const RECENT = 3;
const CACHE_MAX = 40;

const ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h3"/><path d="M4 12h3"/><path d="M4 18h3"/>'
  + '<circle cx="10" cy="6" r="1.4"/><circle cx="10" cy="12" r="1.4"/><circle cx="10" cy="18" r="1.4"/>'
  + '<path d="M14 6h6"/><path d="M14 12h6"/><path d="M14 18h6"/></svg>';

export function install(ctx: AppContext): void {
  const main = document.getElementById('main');
  if (!main) return;
  const host = el('section', 'pane atl-pane');
  host.id = 'timeline-view';
  host.hidden = true;
  main.append(host);

  let railBtn: HTMLButtonElement | null = null;
  const setRail = (open: boolean): void => {
    if (!railBtn) return;
    railBtn.classList.toggle('on', open);
    railBtn.setAttribute('aria-pressed', String(open));
  };

  const view: TimelineView = createTimelineView(ctx, host, {
    jump: e => jump(e),
    alive: id => ctx.state.sessions.some(s => s.id === id),
    onClose: () => {
      main.classList.remove('atl-open');
      setRail(false);
      ctx.render();
    },
  });

  function open(sessionId?: string): void {
    ctx.actions.closePalette(false);
    main!.classList.add('atl-open');
    setRail(true);
    view.open(sessionId ? { sessionIds: [sessionId] } : undefined);
  }

  function jump(e: ActivityEvent): boolean {
    const s = e.sessionId ? ctx.state.sessions.find(x => x.id === e.sessionId) : undefined;
    if (!s) return false;
    view.close();
    if (e.agentId && (s.subagents ?? []).some(a => a.agentId === e.agentId)) ctx.actions.selectSubagent(s.id, e.agentId);
    else ctx.actions.selectSession(s.id);
    return true;
  }

  // 选中变化（含回到首页）与点会话列表都离开时间线
  on('selection-changed', () => view.close());
  document.getElementById('session-list')?.addEventListener('click', () => view.close(), true);
  on('sessions-updated', () => view.refreshAlive());

  ctx.registry.registerOpener({ id: TIMELINE_PANEL_OPENER, order: 530, open: () => open() });

  ctx.registry.registerHotkey({
    id: 'timeline.toggle', keys: 'Ctrl ⇧ L', label: '活动时间线', phase: 'always', order: 530, helpOrder: 37,
    match: e => e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l',
    run: e => {
      e.preventDefault();
      e.stopPropagation();
      if (view.isOpen()) view.close();
      else open();
    },
  });
  ctx.registry.registerHotkey({
    id: 'timeline.escape', keys: 'Esc', label: '关闭时间线', phase: 'always', order: 5, help: false,
    match: e => e.key === 'Escape' && view.isOpen(),
    run: e => {
      e.preventDefault();
      e.stopPropagation();
      if (!view.closeDropdown()) view.close();
    },
  });

  ctx.registry.registerCommands({
    id: 'timeline.palette', order: 531,
    items: c => {
      const items: PaletteItem[] = [{
        section: '命令', icon: '☰', title: '打开活动时间线', keys: 'Ctrl ⇧ L',
        keywords: 'huodong shijianxian timeline activity events', run: () => open(),
      }];
      const s = c.session;
      if (s) {
        items.push({
          section: '命令', icon: '☰', title: '查看本会话时间线', sub: s.label || undefined,
          keywords: 'huodong shijianxian timeline activity session benhuihua', run: () => open(s.id),
        });
      }
      return items;
    },
  });

  const inbox = document.getElementById('btn-inbox');
  if (inbox && !document.getElementById('rail-timeline')) {
    const b = el('button', 'ri') as HTMLButtonElement;
    b.type = 'button';
    b.id = 'rail-timeline';
    b.title = '活动时间线（Ctrl+Shift+L）';
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = ICON;
    b.addEventListener('click', () => (view.isOpen() ? view.close() : open()));
    inbox.after(b);
    railBtn = b;
  }

  installRecentSection(ctx, open);

  ctx.api.activity.onEvents(p => view.onPush(p));
}

/** 属性面板「最近活动」：当前会话最近 3 条，推送到来时原地更新，不触发整体重绘；还没有活动时整节不占位 */
function installRecentSection(ctx: AppContext, open: (sessionId?: string) => void): void {
  const cache = new Map<string, ActivityEvent[]>();
  const loading = new Set<string>();
  let current: { sid: string; list: HTMLElement; sec: HTMLElement } | null = null;

  const fill = (sid: string): void => {
    if (!current || current.sid !== sid) return;
    const evs = cache.get(sid);
    const list = current.list;
    // 读取中与没有活动时都不占位，有数据后再显示
    current.sec.hidden = !evs || evs.length === 0;
    if (!evs || evs.length === 0) { list.replaceChildren(); return; }
    list.replaceChildren(...evs.map(e => {
      const row = el('div', `atl-ri lv-${e.level}`);
      row.dataset.type = e.type;
      row.append(el('span', 'atl-ri-t', clockText(e.at)), el('span', 'atl-ri-ic', iconOf(e.type)), el('span', 'atl-ri-x', e.title));
      row.title = e.detail ? `${e.title} · ${e.detail}` : e.title;
      return row;
    }));
  };

  const load = (sid: string): void => {
    if (loading.has(sid)) return;
    loading.add(sid);
    ctx.api.activity.query({ sessionIds: [sid], limit: RECENT }).then(r => {
      remember(sid, r.events);
      fill(sid);
    }, () => {
      remember(sid, []);
      fill(sid);
    }).finally(() => loading.delete(sid));
  };

  const remember = (sid: string, evs: ActivityEvent[]): void => {
    cache.delete(sid);
    cache.set(sid, evs.slice(0, RECENT));
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  };

  ctx.registry.registerInspectorSection({
    id: 'timeline.recent', order: 500,
    render: (s: Session | undefined) => {
      if (!s || ctx.state.selectedSubagent) { current = null; return null; }
      const sec = el('section', 'sec atl-recent-sec');
      sec.id = 'insp-activity';
      const h = el('h4', '', '最近活动');
      const all = el('button', 'atl-ri-all', '全部') as HTMLButtonElement;
      all.type = 'button';
      all.title = '打开本会话的活动时间线';
      all.addEventListener('click', () => open(s.id));
      h.appendChild(all);
      const list = el('div', 'atl-ri-list');
      sec.append(h, list);
      current = { sid: s.id, list, sec };
      fill(s.id);
      if (!cache.has(s.id)) load(s.id);
      return sec;
    },
  });

  ctx.api.activity.onEvents(p => {
    if (p.cleared) {
      for (const k of cache.keys()) cache.set(k, []);
    }
    const touched = new Set<string>();
    for (const e of p.upserts) {
      if (!e.sessionId || !cache.has(e.sessionId)) continue;
      cache.set(e.sessionId, mergeEvents(cache.get(e.sessionId)!, [e]).slice(0, RECENT));
      touched.add(e.sessionId);
    }
    if (current && (p.cleared || touched.has(current.sid))) fill(current.sid);
  });
}
