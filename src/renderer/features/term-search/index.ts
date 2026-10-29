import type { AppContext } from '../../core/context.js';
import { on } from '../../core/events.js';
import type { HotkeyContext, PaletteItem } from '../../core/registry.js';
import { createTermSearch } from './search-box.js';

/**
 * 终端内搜索：父会话终端与子代理只读终端都可搜索整个滚动历史。
 * Ctrl+F 打开（可设为交给终端，此时只响应 Ctrl+Alt+F），已打开时选中输入框全部文本；
 * Enter / ↓ / F3 下一个，Shift+Enter / ↑ / Shift+F3 上一个，Esc 关闭并把焦点还给终端。
 * Ctrl+Shift+F 已用于收尾标签，所以备用组合取 Ctrl+Alt+F。
 */

const CTRL_F_KEY = 'panel.termSearch.ctrlF';

/** Ctrl+F 是否交给终端（readline 中为光标右移） */
function ctrlFToTerminal(): boolean {
  try { return localStorage.getItem(CTRL_F_KEY) === 'terminal'; } catch { return false; }
}

function setCtrlFToTerminal(v: boolean): void {
  try { localStorage.setItem(CTRL_F_KEY, v ? 'terminal' : 'panel'); } catch { /* 存储不可用则本次会话内不记忆 */ }
}

export function install(ctx: AppContext): void {
  const search = createTermSearch(t => ctx.terminals.focus(t));

  // 焦点在其他输入控件（新建表单、批注等）时不拦截，搜索框自己的输入框除外
  const focusOk = (c: HotkeyContext): boolean => !c.inInput || !!c.target?.closest('.tsearch');
  const isF = (e: KeyboardEvent): boolean => e.key.toLowerCase() === 'f' || e.code === 'KeyF';
  const openActive = (e: KeyboardEvent): void => {
    const t = ctx.terminals.active();
    if (!t) return;
    e.preventDefault(); e.stopPropagation();
    search.open(t);
  };

  ctx.registry.registerHotkey({
    id: 'term-search.open', keys: 'Ctrl F', label: '终端搜索', phase: 'always', order: 520, helpOrder: 100,
    match: (e, c) => e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && isF(e)
      && !ctrlFToTerminal() && focusOk(c) && !!ctx.terminals.active(),
    run: openActive,
  });
  ctx.registry.registerHotkey({
    id: 'term-search.open-alt', keys: 'Ctrl Alt F', label: '终端搜索（Ctrl+F 交给终端时）', phase: 'always', order: 521,
    helpOrder: 101,
    match: (e, c) => e.ctrlKey && !e.shiftKey && e.altKey && !e.metaKey && isF(e) && focusOk(c) && !!ctx.terminals.active(),
    run: openActive,
  });
  ctx.registry.registerHotkey({
    id: 'term-search.step', keys: 'F3 ⇧ F3', label: '搜索：下一个 / 上一个', phase: 'always', order: 522, helpOrder: 102,
    match: e => e.key === 'F3' && !e.ctrlKey && !e.altKey && !e.metaKey && search.isOpenFor(ctx.terminals.active()),
    run: e => {
      e.preventDefault(); e.stopPropagation();
      search.step(e.shiftKey ? -1 : 1);
    },
  });

  ctx.registry.registerCommands({
    id: 'term-search.palette',
    order: 520,
    items: (): PaletteItem[] => {
      const out: PaletteItem[] = [];
      if (ctx.terminals.active()) {
        out.push({
          section: '命令', icon: '⌕', title: '在终端中搜索', keys: ctrlFToTerminal() ? 'Ctrl Alt F' : 'Ctrl F',
          keywords: 'sousuo chazhao zhongduan search find terminal',
          // 命令面板关闭后焦点会回到原处，下一帧再打开搜索框，输入框才能拿到焦点
          run: () => requestAnimationFrame(() => {
            const t = ctx.terminals.active();
            if (t) search.open(t);
          }),
        });
      }
      const toTerm = ctrlFToTerminal();
      out.push({
        section: '命令', icon: '⌨', title: toTerm ? '终端搜索：Ctrl+F 改回面板搜索' : '终端搜索：Ctrl+F 交给终端',
        sub: toTerm ? '当前 Ctrl+F 交给终端，面板搜索用 Ctrl+Alt+F' : '交给终端后 Ctrl+F 为 readline 光标右移，面板搜索改用 Ctrl+Alt+F',
        keywords: 'sousuo kuaijiejian ctrl+f search hotkey terminal',
        run: () => {
          setCtrlFToTerminal(!toTerm);
          ctx.toast(toTerm ? 'Ctrl+F 已改回面板搜索' : 'Ctrl+F 已交给终端，面板搜索请用 Ctrl+Alt+F', 'info');
        },
      });
      return out;
    },
  });

  // 换会话或子代理时关掉搜索框：卡片被下一个终端复用，查询状态仍按终端各自保留
  on('selection-changed', () => search.close(false));
  on('sessions-updated', ({ sessions }) => {
    const ids = new Set(sessions.map(s => s.id));
    search.prune(key => ids.has(key.split('\0')[0]));
  });
}
