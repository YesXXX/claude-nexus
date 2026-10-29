import { el } from '../core/dom.js';

/**
 * 属性面板的折叠分区：低频信息（属性、对话）默认收起，只露出一行标题，点开展开。
 * 属性面板每次推送都会整体重建，展开状态按分区 id 记在 localStorage，重建后照旧。
 */

const KEY_PREFIX = 'nexus.insp.fold.';

function isOpen(id: string): boolean {
  try { return localStorage.getItem(KEY_PREFIX + id) === '1'; } catch { return false; }
}

function remember(id: string, open: boolean): void {
  try {
    if (open) localStorage.setItem(KEY_PREFIX + id, '1');
    else localStorage.removeItem(KEY_PREFIX + id);
  } catch { /* 存储不可用则不记 */ }
}

/** 返回折叠分区与放内容的 body；cls 追加在分区上，便于各分区自己的样式与测试定位 */
export function foldSection(id: string, title: string, cls = ''): { sec: HTMLDetailsElement; body: HTMLElement } {
  const sec = el('details', `sec fold${cls ? ' ' + cls : ''}`) as HTMLDetailsElement;
  sec.dataset.fold = id;
  sec.open = isOpen(id);
  const summary = el('summary', 'fold-h', title);
  const body = el('div', 'fold-b');
  sec.append(summary, body);
  sec.addEventListener('toggle', () => remember(id, sec.open));
  return { sec, body };
}
