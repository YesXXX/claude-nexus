import { promptSummary, recordEndTime } from '../../../shared/history-view.js';
import { cwdBaseName } from '../../../shared/session-view.js';
import type { SessionRecord } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import { el } from '../../core/dom.js';
import type { PaletteItem } from '../../core/registry.js';
import { isHistoryOpen, notifyRecordsChanged, openHistory } from './panel.js';
import { installHistorySettings } from './settings-section.js';

/**
 * 会话历史：独立的历史面板（搜索、过滤、详情与动作、保留策略、清空），
 * 入口有导航轨按钮、Ctrl+Shift+H、命令面板「打开会话历史」与首页「全部历史」。
 * 命令面板另列最近 50 条历史参与搜索（只在输入搜索词时出现），回车打开该条的详情。
 */

/** 与续接模块约定的打开入口 id：注册后首页「最近结束」显示「全部历史」 */
export const HISTORY_PANEL_OPENER = 'history.panel';
const PALETTE_MAX = 50;

const ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'
  + '<path d="M12 7v5l3 2"/></svg>';

export function install(ctx: AppContext): void {
  let recent: SessionRecord[] = [];
  const open = (recordId?: string): void => openHistory(ctx, recordId ? { recordId } : {});

  ctx.api.onRecordsChanged(() => notifyRecordsChanged());

  ctx.registry.registerOpener({ id: HISTORY_PANEL_OPENER, order: 520, open: () => open() });
  installHistorySettings(ctx, () => open());

  ctx.registry.registerHotkey({
    id: 'history.open', keys: 'Ctrl ⇧ H', label: '会话历史', phase: 'always', order: 520, helpOrder: 36,
    match: e => e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'h',
    run: e => {
      e.preventDefault();
      e.stopPropagation();
      if (!isHistoryOpen()) {
        ctx.actions.closePalette(false);
        open();
      }
    },
  });

  const refresh = async (): Promise<boolean> => {
    try {
      const page = await ctx.api.recordsList({ states: ['ended'], sort: 'ended', limit: PALETTE_MAX });
      const key = (l: SessionRecord[]): string => l.map(r => `${r.id}|${r.updatedAt}`).join(',');
      const changed = key(page.items) !== key(recent);
      recent = page.items;
      return changed;
    } catch {
      return false;
    }
  };

  ctx.registry.registerCommands({
    id: 'history.palette', order: 521,
    refresh,
    items: () => {
      const items: PaletteItem[] = [{
        section: '命令', icon: '⟲', title: '打开会话历史', keys: 'Ctrl ⇧ H',
        keywords: 'lishi huihua history sessions dakai', run: () => open(),
      }];
      for (const r of recent) {
        const label = r.label || '未命名会话';
        const p = promptSummary(r.firstPrompt, 60);
        items.push({
          section: '历史', icon: '⟲', title: `历史：${label}`,
          sub: p || cwdBaseName(r.cwd) || r.cwd,
          hint: new Date(recordEndTime(r)).toLocaleDateString(),
          keywords: `lishi history ${r.cwd} ${r.worktree?.branch ?? ''} ${r.firstPrompt ?? ''}`,
          queryOnly: true,
          run: () => open(r.id),
        });
      }
      return items;
    },
  });

  // 导航轨按钮放在「等待处理」后面
  const inbox = document.getElementById('btn-inbox');
  if (inbox && !document.getElementById('rail-history')) {
    const b = el('button', 'ri');
    b.type = 'button';
    b.id = 'rail-history';
    b.title = '会话历史（Ctrl+Shift+H）';
    b.innerHTML = ICON;
    b.addEventListener('click', () => open());
    inbox.after(b);
  }
}
