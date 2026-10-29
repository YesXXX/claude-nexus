import type { Edge } from '../../shared/pane-layout.js';
import type { AppContext } from '../core/context.js';
import type { PaletteItem } from '../core/registry.js';
import { focusedLeaf, isMaximized, isMultiPane } from '../core/panes.js';
import { state } from '../core/state.js';
import { closePane, equalizeAllPanes, moveFocus, splitPane, toggleMaximize } from '../actions/layout-actions.js';
import { splitCheck } from '../views/pane-grid.js';

/**
 * 窗格布局的热键与命令面板命令。
 * 热键只在多窗格且终端标签显示网格时生效，单窗格时按键照旧交给终端。
 */

/** 网格当前可见可操作：多窗格、选中父会话、在终端标签 */
function gridActive(): boolean {
  return isMultiPane() && !!state.selectedId && !state.selectedSubagent && state.paneTab === 'term';
}

const ARROW: Record<string, Edge> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' };

const KEYWORDS = 'chuangge fenping chaifen split pane';

export function installBuiltinPaneLayout(ctx: AppContext): void {
  const { registerHotkey, registerCommands } = ctx.registry;

  registerHotkey({
    id: 'core.pane-maximize', keys: 'Ctrl ⇧ M', label: '窗格：最大化 / 还原', phase: 'always', order: 50, helpOrder: 96,
    match: e => e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'm' && gridActive(),
    run: e => { e.preventDefault(); e.stopPropagation(); toggleMaximize(); },
  });

  registerHotkey({
    id: 'core.pane-focus-move', keys: 'Ctrl Alt ←↑↓→', label: '窗格：移动焦点', phase: 'always', order: 60, helpOrder: 97,
    match: (e, c) => e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.key in ARROW && !c.inInput && gridActive(),
    run: e => { e.preventDefault(); e.stopPropagation(); moveFocus(ARROW[e.key]); },
  });

  registerCommands({
    id: 'core.pane-layout', order: 120,
    items: ({ session, subagent, paneTab }) => {
      if (!session || subagent || paneTab !== 'term') return [];
      const out: PaletteItem[] = [];
      const pane = focusedLeaf().id;
      const splits: Array<[Edge, string]> = [['right', '窗格：向右拆出新窗格'], ['bottom', '窗格：向下拆出新窗格']];
      for (const [edge, title] of splits) {
        if (!splitCheck(pane, edge, null).ok) continue;
        out.push({ section: '命令', icon: '◫', title, sub: '新窗格为空，可拖入会话或点选', keywords: KEYWORDS, run: () => { splitPane(pane, edge); } });
      }
      if (isMultiPane()) {
        out.push({
          section: '命令', icon: '⤢', title: isMaximized() ? '窗格：还原窗格布局' : '窗格：最大化当前窗格',
          keys: 'Ctrl ⇧ M', keywords: `${KEYWORDS} zuidahua max`, run: () => toggleMaximize(),
        });
        out.push({
          section: '命令', icon: '✕', title: '窗格：关闭当前窗格', sub: '会话继续在后台运行',
          keywords: `${KEYWORDS} guanbi close`, run: () => closePane(pane),
        });
        out.push({ section: '命令', icon: '⊞', title: '窗格：全部等分', keywords: `${KEYWORDS} dengfen equal`, run: () => equalizeAllPanes() });
      }
      return out;
    },
  });
}
