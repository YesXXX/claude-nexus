import type { Session } from '../../../shared/types';
import type { VerifySummary } from '../../../shared/verify-types';
import { verifyBadge } from '../../../shared/verify-view.js';
import { el } from '../../core/dom.js';

/**
 * 验证徽标：属性面板验证节使用。纯同步，只读 s.verify；点击时交给 onOpen（打开输出弹窗），
 * 并阻止冒泡，避免同时触发外层的点击。
 */

export function verifyBadgeEl(v: VerifySummary, onOpen?: () => void): HTMLElement {
  const view = verifyBadge(v);
  const b = el(onOpen ? 'button' : 'span', `verify-badge ${view.cls}`, view.icon);
  b.dataset.status = v.status;
  if (v.reused) b.dataset.reused = '1';
  b.title = view.title;
  if (b instanceof HTMLButtonElement) b.type = 'button';
  if (onOpen) {
    b.addEventListener('click', e => { e.stopPropagation(); onOpen(); });
  }
  return b;
}

/** 会话是否空闲、可以接收修复提示词 */
export function sessionIdle(s: Session | undefined): boolean {
  return !!s && !s.readOnly && !s.busy && (s.status === 'completed' || s.status === 'waiting_input');
}
