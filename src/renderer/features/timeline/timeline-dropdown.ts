import { el } from '../../core/dom.js';

/**
 * 时间线页头的多选下拉：用 details/summary 实现展开收起，菜单里是一组复选框与「全部」。
 * 勾选变化立即回调选中值；summary 文字由调用方按当前条件生成。
 */

export interface DropdownOption {
  value: string;
  text: string;
  checked: boolean;
}

export interface Dropdown {
  root: HTMLDetailsElement;
  menu: HTMLElement;
  setOptions(opts: DropdownOption[], onChange: (values: string[]) => void): void;
  setChecked(values: string[]): void;
  refreshSummary(): void;
}

export function buildDropdown(id: string, summaryText: () => string): Dropdown {
  const root = el('details', 'atl-dd') as HTMLDetailsElement;
  root.id = id;
  const summary = el('summary', 'atl-dd-s');
  const menu = el('div', 'atl-dd-menu');
  root.append(summary, menu);
  let onChange: ((values: string[]) => void) | null = null;

  const boxes = (): HTMLInputElement[] => [...menu.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  const values = (): string[] => boxes().filter(b => b.checked).map(b => b.value);

  const dd: Dropdown = {
    root,
    menu,
    setOptions(opts, cb) {
      onChange = cb;
      const all = el('button', 'atl-mi atl-dd-all', '全部');
      all.type = 'button';
      all.addEventListener('click', () => {
        for (const b of boxes()) b.checked = false;
        onChange?.([]);
        root.open = false;
      });
      const items = opts.map(o => {
        const label = el('label', 'atl-dd-i');
        const box = el('input') as HTMLInputElement;
        box.type = 'checkbox';
        box.value = o.value;
        box.checked = o.checked;
        box.addEventListener('change', () => onChange?.(values()));
        label.append(box, el('span', '', o.text));
        return label;
      });
      menu.replaceChildren(all, ...items);
      if (opts.length === 0) menu.append(el('div', 'atl-dd-none', '暂无可选项'));
    },
    setChecked(vals) {
      const set = new Set(vals);
      for (const b of boxes()) b.checked = set.has(b.value);
    },
    refreshSummary() {
      summary.textContent = summaryText();
    },
  };
  dd.refreshSummary();
  return dd;
}
