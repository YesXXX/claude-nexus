import type { ChoiceOptions, ConfirmOptions } from '../core/dialog-types.js';
import { byId, el } from '../core/dom.js';

export type { ChoiceOptions, ConfirmOptions, DialogChoice } from '../core/dialog-types.js';

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return choiceDialog({
    title: opts.title, message: opts.message, danger: opts.danger,
    choices: [{ value: 'ok', text: opts.okText, style: opts.danger ? 'danger' : 'primary' }],
  }).then(v => v === 'ok');
}

/**
 * 应用内多选项对话框，替代系统 confirm 弹窗（后者是白底原生对话框，与界面割裂）。
 * 「取消」固定在最左且默认获得焦点，误按回车不会执行破坏性操作；指定 defaultValue 时焦点改到该选项。
 * Esc / 点遮罩取消，返回 null。关闭后焦点还给打开前的元素。
 */
export function choiceDialog<T extends string>(opts: ChoiceOptions<T>): Promise<T | null> {
  const backdrop = byId('confirm-backdrop');
  const buttons = byId('confirm-buttons');
  const cancel = byId<HTMLButtonElement>('confirm-cancel');
  byId('confirm-title').textContent = opts.title;
  byId('confirm-message').textContent = opts.message;
  backdrop.classList.toggle('danger', Boolean(opts.danger));

  // 清掉上次的选项按钮，只保留「取消」
  for (const b of [...buttons.querySelectorAll('button')]) if (b !== cancel) b.remove();
  const choiceButtons = opts.choices.map(c => {
    const b = el('button', c.style === 'danger' ? 'btn solid-danger' : c.style === 'primary' ? 'btn white' : 'btn', c.text) as HTMLButtonElement;
    b.type = 'button';
    buttons.appendChild(b);
    return { b, value: c.value };
  });

  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  backdrop.hidden = false;
  // 选项文字较长时一行放不下，改为纵向排列整宽按钮，避免溢出弹窗左侧。
  // 按钮靠右排列，溢出落在左侧，scrollWidth 量不到，只能按各按钮宽度与间距求和比较
  buttons.classList.remove('stacked');
  const btns = [...buttons.children] as HTMLElement[];
  const gap = parseFloat(getComputedStyle(buttons).columnGap) || 0;
  const need = btns.reduce((w, b) => w + b.offsetWidth, 0) + gap * Math.max(0, btns.length - 1);
  buttons.classList.toggle('stacked', need > buttons.clientWidth);
  const preferred = choiceButtons.find(c => opts.defaultValue !== undefined && c.value === opts.defaultValue);
  (preferred?.b ?? cancel).focus();

  return new Promise(resolve => {
    const finish = (result: T | null): void => {
      backdrop.hidden = true;
      cancel.removeEventListener('click', onCancel);
      backdrop.removeEventListener('mousedown', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      for (const { b } of choiceButtons) b.remove();
      if (prevFocus && prevFocus.isConnected) prevFocus.focus();
      resolve(result);
    };
    const onCancel = (): void => finish(null);
    const onBackdrop = (e: MouseEvent): void => { if (e.target === backdrop) finish(null); };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    };
    for (const { b, value } of choiceButtons) b.addEventListener('click', () => finish(value));
    cancel.addEventListener('click', onCancel);
    backdrop.addEventListener('mousedown', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}
