import type { PresetInput } from '../../../shared/preset';
import { PRESET_NAME_MAX } from '../../../shared/preset.js';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';

/**
 * 预设保存 / 改名弹窗：只编辑名称，其余内容（工作目录、独立工作区、首条提示词）以摘要展示。
 * input 带 id 时为修改已有预设（名称以外的字段保持原值），否则新建；保存成功回调后关闭。
 */

interface Dialog {
  backdrop: HTMLElement;
  title: HTMLElement;
  name: HTMLInputElement;
  summary: HTMLElement;
  error: HTMLElement;
  save: HTMLButtonElement;
}

let ctx: AppContext | null = null;
let dlg: Dialog | null = null;
let current: { input: PresetInput; onSaved(): void } | null = null;
let prevFocus: HTMLElement | null = null;

export function bindPresetDialog(c: AppContext): void {
  ctx = c;
}

function summaryOf(input: PresetInput): string {
  const tags = [
    input.worktree ? `独立工作区${input.branch ? `（分支 ${input.branch}）` : ''}` : '',
    input.initialPrompt ? '带首条提示词' : '',
  ].filter(Boolean);
  const text = [input.cwd, ...tags].join(' · ');
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function buildDialog(): Dialog {
  const backdrop = el('div', 'modal-backdrop');
  backdrop.id = 'preset-dialog-backdrop';
  backdrop.hidden = true;
  const modal = el('div', 'modal preset-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'preset-dialog-title');
  const title = el('h2', '', '存为预设');
  title.id = 'preset-dialog-title';

  const field = el('label', 'preset-field');
  field.append(el('span', '', '名称'));
  const name = el('input');
  name.type = 'text';
  name.id = 'preset-dialog-name';
  name.placeholder = '预设名称，如：日常开发';
  name.spellcheck = false;
  name.maxLength = PRESET_NAME_MAX;
  field.appendChild(name);

  const summary = el('div', 'preset-dialog-summary');
  const error = el('div', 'form-error');
  error.id = 'preset-dialog-error';

  const cancel = el('button', 'btn', '取消');
  cancel.type = 'button';
  cancel.id = 'preset-dialog-cancel';
  const save = el('button', 'btn white', '保存');
  save.type = 'button';
  save.id = 'preset-dialog-save';
  const buttons = el('div', 'dialog-buttons');
  buttons.append(cancel, save);

  modal.append(title, field, summary, error, buttons);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  name.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
  });
  cancel.addEventListener('click', () => close());
  save.addEventListener('click', () => { void submit(); });
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
  return { backdrop, title, name, summary, error, save };
}

async function submit(): Promise<void> {
  if (!ctx || !dlg || !current) return;
  const input: PresetInput = { ...current.input, name: dlg.name.value };
  dlg.save.disabled = true;
  try {
    const r = await ctx.api.presets.save(input);
    if (!r.ok) { dlg.error.textContent = r.error; return; }
    current.onSaved();
    ctx.toast(`预设「${r.preset.name}」已保存`, 'success');
    close();
  } catch (err) {
    dlg.error.textContent = ipcErrorText(err) || '保存失败';
  } finally {
    dlg.save.disabled = false;
  }
}

function close(): void {
  if (!dlg) return;
  dlg.backdrop.hidden = true;
  current = null;
  document.removeEventListener('keydown', onKey, true);
  if (prevFocus && prevFocus.isConnected) prevFocus.focus();
  prevFocus = null;
}

function onKey(e: KeyboardEvent): void {
  if (!dlg || dlg.backdrop.hidden) return;
  // 确认对话框叠在上面时让给它处理
  if (document.getElementById('confirm-backdrop')?.hidden === false) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close();
  }
}

export function openPresetDialog(opts: { input: PresetInput; onSaved(): void }): void {
  if (!ctx) return;
  if (!dlg) dlg = buildDialog();
  current = opts;
  dlg.title.textContent = opts.input.id ? '预设改名' : '存为预设';
  dlg.name.value = opts.input.name;
  dlg.summary.textContent = summaryOf(opts.input);
  dlg.error.textContent = '';
  if (dlg.backdrop.hidden) {
    prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.addEventListener('keydown', onKey, true);
  }
  dlg.backdrop.hidden = false;
  dlg.name.focus();
  dlg.name.select();
}
