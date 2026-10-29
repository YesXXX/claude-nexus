import type { ChangedFile, Session } from '../../../shared/types';
import type { RevertEntry } from '../../../shared/review-types';
import type { SessionChangedFile } from '../../../shared/session-change-types';
import type { RevertBridge } from '../../core/api.js';
import type { ChangesExtInstance, ChangesHost, ChangesScope } from '../../core/changes-ext.js';
import type { AppContext } from '../../core/context.js';
import { el, ICON_PATHS, lineIcon } from '../../core/dom.js';
import type { PaletteItem } from '../../core/registry.js';
import { restoreEntry, revertFile, type FlowDeps } from './revert-flow.js';

/**
 * 撤销单个文件：改动列表行悬停的「↶」、diff 头部的「撤销」、列表右键菜单三个入口，
 * 成功后改动页顶部显示「已撤销 X · 时间 [恢复] [✕]」横幅，保留到下一次撤销或手动关闭；
 * 命令面板提供「恢复最近一次撤销」。
 * 仓库视角按 git 版本恢复；本会话视角按 Claude 首次修改前的快照恢复，没有快照的文件不提供撤销入口。
 */

function btn(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return b;
}

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function canRevert(s: Session | undefined, f: ChangedFile, scope: ChangesScope): boolean {
  if (!s || s.readOnly) return false;
  if (scope === 'repo') return f.kind !== 'conflicted';
  const sf = f as SessionChangedFile;
  return sf.baseline === 'exact' && !sf.tooLarge;
}

/** 两条撤销记录里取较新的一条 */
function newer(a: RevertEntry | null, b: RevertEntry | null): RevertEntry | null {
  if (!a) return b;
  if (!b) return a;
  return b.at > a.at ? b : a;
}

export function install(ctx: AppContext): void {
  const sc = ctx.api.sessionChanges;
  const sessionApi: RevertBridge = {
    plan: (id, p) => sc.revertPlan(id, p),
    revertFile: (id, p, _mode, opts) => sc.revertFile(id, p, opts),
    last: id => sc.last(id),
    restore: (id, entryId, opts) => sc.restore(id, entryId, opts),
  };
  const repoDeps: FlowDeps = { api: ctx.api.revert, toast: ctx.toast, confirm: o => ctx.confirm(o) };
  const sessionDeps: FlowDeps = { ...repoDeps, api: sessionApi };
  const depsOf = (entry: RevertEntry): FlowDeps => (entry.scope === 'session' ? sessionDeps : repoDeps);
  /** 每个会话横幅上展示的那次撤销；关闭或恢复后删除 */
  const banners = new Map<string, RevertEntry>();
  /** 每个会话最近一次未恢复的撤销（两种视角取较新的），供命令面板同步读取 */
  const lastBySession = new Map<string, RevertEntry | null>();
  const renderers = new Set<() => void>();
  const rerenderAll = (): void => renderers.forEach(r => r());

  const loadLast = async (sid: string): Promise<void> => {
    const [repo, session] = await Promise.all([
      ctx.api.revert.last(sid).catch(() => null),
      sc.last(sid).catch(() => null),
    ]);
    lastBySession.set(sid, newer(repo, session));
  };

  const doRestore = async (entry: RevertEntry, after?: () => void): Promise<void> => {
    const ok = await restoreEntry(depsOf(entry), entry);
    if (ok) banners.delete(entry.sessionId);
    await loadLast(entry.sessionId);
    rerenderAll();
    after?.();
  };

  ctx.registry.registerChangesExtension({
    id: 'revert.changes',
    order: 600,
    attach(host: ChangesHost): ChangesExtInstance {
      const bar = el('div', 'rv-bar');
      bar.hidden = true;
      let menu: HTMLElement | null = null;
      const allowed = (f: ChangedFile): boolean => canRevert(host.session(), f, host.scope());

      const run = async (f: ChangedFile): Promise<void> => {
        const s = host.session();
        if (!s || !allowed(f)) return;
        const session = host.scope() === 'session';
        const entry = await revertFile(session ? sessionDeps : repoDeps, s.id, f, session ? undefined : host.mode(), session);
        if (!entry) return;
        banners.set(s.id, entry);
        lastBySession.set(s.id, entry.restorable ? entry : null);
        rerenderAll();
        host.refresh();
      };

      const renderBar = (): void => {
        const s = host.session();
        const entry = s ? banners.get(s.id) : undefined;
        bar.replaceChildren();
        bar.hidden = !entry;
        if (!entry) return;
        const name = entry.paths[0] ?? '';
        const text = el('span', 'rv-bar-text', `已撤销 ${name} · ${hhmm(entry.at)}`);
        text.title = name;
        bar.append(el('span', 'rv-bar-mark', '↶'), text);
        if (!entry.restorable) bar.append(el('span', 'rv-bar-sub', '文件过大未备份，无法恢复'));
        bar.append(el('span', 'chg-sp'));
        if (entry.restorable) {
          const restore = btn('恢复', 'chg-btn rv-restore', () => void doRestore(entry, () => host.refresh()));
          restore.title = entry.scope === 'session' ? '把文件恢复到撤销前' : '把文件与暂存区恢复到撤销前';
          bar.append(restore);
        }
        const close = btn('✕', 'chg-icon-btn rv-close', () => { banners.delete(entry.sessionId); rerenderAll(); });
        close.title = '关闭横幅（仍可在命令面板恢复）';
        bar.append(close);
      };
      renderers.add(renderBar);

      const closeMenu = (): void => { menu?.remove(); menu = null; };
      const openMenu = (f: ChangedFile, x: number, y: number): void => {
        closeMenu();
        menu = el('div', 'rv-menu');
        const item = btn('撤销此文件', 'rv-menu-item', () => { closeMenu(); void run(f); });
        menu.append(item);
        menu.style.left = `${Math.min(x, window.innerWidth - 160)}px`;
        menu.style.top = `${Math.min(y, window.innerHeight - 40)}px`;
        document.body.append(menu);
        item.focus();
      };
      document.addEventListener('mousedown', e => { if (menu && !menu.contains(e.target as Node)) closeMenu(); }, true);
      document.addEventListener('keydown', e => { if (menu && e.key === 'Escape') closeMenu(); }, true);
      window.addEventListener('blur', closeMenu);
      document.addEventListener('contextmenu', e => {
        const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.chg-row');
        const root = host.diffScroll.closest('.chg-body');
        if (!row || !root || !root.contains(row)) return;
        const f = host.files()[Number(row.dataset.index)];
        if (!f || !allowed(f)) return;
        e.preventDefault();
        openMenu(f, e.clientX, e.clientY);
      });

      return {
        bar,
        rowExtras(f: ChangedFile): Node | null {
          if (!allowed(f)) return null;
          const b = btn('↶', 'rv-row-btn', () => void run(f));
          b.title = '撤销此文件';
          return b;
        },
        headActions(f: ChangedFile): Node | null {
          if (!allowed(f)) return null;
          const b = btn('', 'chg-ib chg-undo rv-head-btn', () => void run(f));
          b.append(lineIcon(ICON_PATHS.undo, 13, 1.5), el('span', '', '撤销'));
          b.title = host.scope() === 'session'
            ? '把这个文件恢复到本会话首次修改前的内容（先备份，可恢复）'
            : '把这个文件恢复到改动前的版本（先备份，可恢复）';
          return b;
        },
        show(s: Session): void {
          closeMenu();
          renderBar();
          void loadLast(s.id);
        },
        scopeChanged: closeMenu,
        update: () => renderBar(),
        hide: closeMenu,
      };
    },
  });

  ctx.registry.registerCommands({
    id: 'revert.palette',
    order: 580,
    items: ({ session }) => {
      if (!session) return [];
      const entry = lastBySession.get(session.id);
      if (!entry || !entry.restorable) return [];
      const why = session.readOnly ? '此会话由其他面板实例运行，只能查看' : '';
      const item: PaletteItem = {
        section: '命令', icon: '↶', title: '恢复最近一次撤销',
        sub: why || `${entry.paths[0] ?? ''} · ${hhmm(entry.at)}`,
        keywords: 'huifu chexiao revert restore undo',
        run: () => { if (!why) void doRestore(entry); },
        ...(why ? { disabled: true, hint: why } : {}),
      };
      return [item];
    },
  });
}
