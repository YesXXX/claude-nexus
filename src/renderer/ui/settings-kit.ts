import { el } from '../core/dom.js';

/**
 * 设置页的通用控件：设置行、分段选择、开关、数字输入与说明行。
 * 只负责结构与交互，值的读写与保存由各分节自己处理；样式在 features/settings/settings.css。
 */

/** 一行设置：左侧标题与说明，右侧控件 */
export function settingRow(label: string, desc: string | null, control: HTMLElement | null, id?: string): HTMLElement {
  const row = el('div', 'set-row');
  if (id) row.id = id;
  const text = el('div', 'set-text');
  text.appendChild(el('div', 'set-label', label));
  if (desc) text.appendChild(el('div', 'set-desc', desc));
  row.appendChild(text);
  if (control) {
    const ctl = el('div', 'set-ctl');
    ctl.appendChild(control);
    row.appendChild(ctl);
  }
  return row;
}

/** 整行只有说明文字（如外部配置的摘要或不可用原因） */
export function settingNote(text: string): HTMLElement {
  return el('div', 'set-note', text);
}

export interface Segmented<T extends string> {
  el: HTMLElement;
  set(value: T | null): void;
  setDisabled(off: boolean): void;
}

/** 分段选择：点击即回调，回调返回 false 时还原为原来的选中项 */
export function segmented<T extends string>(
  options: Array<[T, string]>,
  value: T | null,
  onPick: (v: T) => void | boolean | Promise<void | boolean>,
): Segmented<T> {
  const box = el('div', 'set-seg');
  box.setAttribute('role', 'radiogroup');
  let current = value;
  const btns = options.map(([v, text]) => {
    const b = el('button', 'set-seg-b', text);
    b.type = 'button';
    b.dataset.value = v;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => void (async () => {
      if (v === current) return;
      const prev = current;
      paint(v);
      const ok = await onPick(v);
      if (ok === false) paint(prev);
    })());
    box.appendChild(b);
    return b;
  });
  function paint(v: T | null): void {
    current = v;
    for (const b of btns) {
      const on = b.dataset.value === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  }
  paint(value);
  return {
    el: box,
    set: paint,
    setDisabled(off) { for (const b of btns) b.disabled = off; },
  };
}

export interface Toggle {
  el: HTMLElement;
  input: HTMLInputElement;
}

/** 开关：切换即回调，回调返回 false 时还原 */
export function toggle(checked: boolean, onChange: (on: boolean) => void | boolean | Promise<void | boolean>): Toggle {
  const lab = el('label', 'set-toggle');
  const input = el('input') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = checked;
  lab.append(input, el('span', 'set-switch'));
  input.addEventListener('change', () => void (async () => {
    const on = input.checked;
    const ok = await onChange(on);
    if (ok === false) input.checked = !on;
  })());
  return { el: lab, input };
}

export interface NumberField {
  el: HTMLElement;
  input: HTMLInputElement;
  /** 外部写入当前值（如异步读到的设置），不触发提交 */
  set(v: number): void;
}

/**
 * 整数输入：失焦或回车时提交，超出范围或不是整数时还原为上次的值并回调 onInvalid；
 * 值没变不提交，提交回调返回 false 时同样还原。
 */
export function numberField(
  value: number,
  [min, max]: [number, number],
  onCommit: (v: number) => void | boolean | Promise<void | boolean>,
  opts: { unit?: string; onInvalid?: (min: number, max: number) => void } = {},
): NumberField {
  const box = el('span', 'set-num');
  const input = el('input') as HTMLInputElement;
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = '1';
  input.value = String(value);
  box.appendChild(input);
  if (opts.unit) box.appendChild(el('span', 'set-unit', opts.unit));
  let last = value;
  const commit = async (): Promise<void> => {
    const v = Number(input.value);
    if (v === last && input.value !== '') return;
    if (!Number.isInteger(v) || v < min || v > max) {
      input.value = String(last);
      opts.onInvalid?.(min, max);
      return;
    }
    const prev = last;
    last = v;
    const ok = await onCommit(v);
    if (ok === false) {
      last = prev;
      input.value = String(prev);
    }
  };
  // 只在失焦或回车时提交：微调箭头每点一下都会触发 change，逐次保存会让保留策略之类的设置连续清理
  input.addEventListener('blur', () => void commit());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });
  return {
    el: box,
    input,
    set(v) { last = v; input.value = String(v); },
  };
}

/** 设置行右侧的普通按钮 */
export function actionButton(text: string, onClick: () => void, id?: string): HTMLButtonElement {
  const b = el('button', 'btn sm', text);
  b.type = 'button';
  if (id) b.id = id;
  b.addEventListener('click', onClick);
  return b;
}
