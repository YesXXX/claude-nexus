import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { settingRow } from '../../ui/settings-kit.js';

/**
 * 设置页「改动与 diff」分节里的外部编辑器命令行：文本框失焦或回车保存，预设一键填入并保存。
 * 留空恢复默认打开方式（系统默认程序，不带行号）。
 */

export const EDITOR_PRESETS: ReadonlyArray<{ name: string; command: string; note: string }> = [
  { name: 'VS Code', command: 'code -g {file}:{line}', note: '大多数机器装的是 code.cmd，面板会经 cmd 代跑' },
  { name: 'Cursor', command: 'cursor -g {file}:{line}', note: 'Cursor 的命令行启动器' },
  { name: 'JetBrains', command: 'idea --line {line} {file}', note: 'IDEA；WebStorm / PyCharm 等把 idea 换成对应命令' },
];

export function editorSettingRow(ctx: AppContext): HTMLElement {
  const input = el('input', 'ejump-cmd-input') as HTMLInputElement;
  input.id = 'settings-editor-command';
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = '如 code -g {file}:{line}；留空用系统默认程序打开';

  let latest = '';
  let touched = false;
  const save = async (): Promise<void> => {
    const value = input.value.trim();
    if (value === latest) return;
    try {
      const r = await ctx.api.editor.setConfig(value);
      if (!r.ok) {
        ctx.toast(r.error, 'error');
        input.value = latest;
        return;
      }
      latest = r.command;
      ctx.toast(value ? '已保存外部编辑器命令' : '已恢复默认打开方式', 'success');
    } catch (err) {
      ctx.toast(ipcErrorText(err), 'error');
    }
  };

  // 异步读当前配置；用户已开始编辑时不覆盖输入
  void ctx.api.editor.getConfig().then(r => {
    latest = r.command;
    if (!touched) input.value = r.command;
  }).catch(() => undefined);
  input.addEventListener('input', () => { touched = true; });
  input.addEventListener('blur', () => void save());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });

  const ctl = el('div', 'ejump-set-ctl');
  ctl.append(input);
  for (const p of EDITOR_PRESETS) {
    const b = el('button', 'btn sm ejump-preset', p.name);
    b.type = 'button';
    b.title = `${p.command}\n${p.note}`;
    b.addEventListener('click', () => {
      input.value = p.command;
      touched = true;
      input.focus();
      void save();
    });
    ctl.append(b);
  }
  return settingRow(
    '外部编辑器命令',
    'diff 行悬停的「在编辑器打开」与头部「打开」按它跳到对应行；{file} 文件、{line} 行号、{col} 列号（可选）。'
    + '留空则用系统默认程序打开，不带行号',
    ctl,
  );
}
