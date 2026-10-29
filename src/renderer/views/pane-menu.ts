import type { Session } from '../../shared/types';
import { el } from '../core/dom.js';
import { paneMenuItems, renderEach } from '../core/registry.js';

/**
 * 详情页头的「⋯」更多菜单：导出、结束会话、复制路径等低频操作收在这里，页头只留续接类的主操作。
 * 菜单项由页头菜单注册表生成，每次打开时按当前会话重新计算；点外面、按 Esc 或执行一项后关闭。
 */

let openMenu: { root: HTMLElement; sid: string; close(): void } | null = null;

export function closePaneMenu(): void {
  openMenu?.close();
}

/** 菜单正为该会话打开时，页头重绘应跳过操作区，否则菜单会被整体替换掉 */
export function paneMenuOpenFor(sid: string): boolean {
  return openMenu?.sid === sid && openMenu.root.isConnected;
}

/** 生成「⋯」按钮；没有任何菜单项时返回 null */
export function renderPaneMenuButton(s: Session): HTMLElement | null {
  const items = renderEach(paneMenuItems(), s, (m, x) => m.item(x));
  if (items.length === 0) return null;
  const wrap = el('div', 'pane-more');
  const btn = el('button', 'pane-more-btn', '⋯') as HTMLButtonElement;
  btn.type = 'button';
  btn.id = 'pane-more';
  btn.title = '更多操作';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (openMenu?.root.parentElement === wrap) { closePaneMenu(); return; }
    closePaneMenu();
    openFor(wrap, btn, s);
  });
  wrap.appendChild(btn);
  return wrap;
}

function openFor(wrap: HTMLElement, btn: HTMLButtonElement, s: Session): void {
  const items = renderEach(paneMenuItems(), s, (m, x) => m.item(x));
  const menu = el('div', 'pane-menu');
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    const b = el('button', `pane-mi${it.danger ? ' danger' : ''}`, it.label) as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (it.role) b.dataset.role = it.role;
    if (it.title) b.title = it.title;
    b.disabled = !!it.disabled;
    b.addEventListener('click', e => {
      e.stopPropagation();
      closePaneMenu();
      it.run();
    });
    menu.appendChild(b);
  }
  const onDoc = (e: MouseEvent): void => { if (!menu.contains(e.target as Node)) closePaneMenu(); };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closePaneMenu();
    btn.focus();
  };
  const close = (): void => {
    document.removeEventListener('mousedown', onDoc, true);
    window.removeEventListener('keydown', onKey, true);
    menu.remove();
    btn.setAttribute('aria-expanded', 'false');
    if (openMenu?.root === menu) openMenu = null;
  };
  document.addEventListener('mousedown', onDoc, true);
  window.addEventListener('keydown', onKey, true);
  btn.setAttribute('aria-expanded', 'true');
  wrap.appendChild(menu);
  openMenu = { root: menu, sid: s.id, close };
  (menu.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus();
}
