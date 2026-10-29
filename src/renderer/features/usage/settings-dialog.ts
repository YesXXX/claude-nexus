import type { UsageSettings } from '../../../shared/usage-types';
import { defaultUsageSettings, sanitizeUsageSettings } from '../../../shared/usage-format.js';
import type { UsageBridge } from '../../core/api.js';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';

/**
 * 上下文设置弹窗：上下文黄红档与按模型前缀的窗口覆盖。
 * 弹窗在第一次打开时创建并挂到 body，之后复用。保存前先在渲染层做基本检查（前缀非空、不重复），
 * 再用与主进程相同的 sanitizeUsageSettings 校验；主进程仍会再校验一次，失败原因都显示在弹窗内，不关闭弹窗。
 */

interface WindowRow { row: HTMLElement; key: HTMLInputElement; value: HTMLInputElement }

interface Dialog {
  backdrop: HTMLElement;
  warn: HTMLInputElement;
  danger: HTMLInputElement;
  windowBox: HTMLElement;
  error: HTMLElement;
  save: HTMLButtonElement;
  windows: WindowRow[];
}

let api: UsageBridge;
let toast: AppContext['toast'];
let onSaved: () => void = () => undefined;
let cached: UsageSettings = defaultUsageSettings();
let dlg: Dialog | null = null;
let prevFocus: HTMLElement | null = null;

/** 绑定 api 与保存后的回调，并读取一次当前设置 */
export function bindSettingsDialog(ctx: AppContext, saved: () => void): void {
  api = ctx.api.usage;
  toast = ctx.toast;
  onSaved = saved;
  void reloadUsageSettings();
}

/** 最近一次读到或保存的设置 */
export function usageSettings(): UsageSettings {
  return cached;
}

export async function reloadUsageSettings(): Promise<void> {
  try {
    cached = await api.getSettings();
  } catch (err) {
    console.error('[usage] 读取上下文设置失败：', err);
  }
}

export function isUsageSettingsOpen(): boolean {
  return !!dlg && !dlg.backdrop.hidden;
}

function textInput(value: string, placeholder = '', cls = ''): HTMLInputElement {
  const i = el('input', cls);
  i.type = 'text';
  i.value = value;
  i.placeholder = placeholder;
  i.spellcheck = false;
  return i;
}

function addWindowRow(d: Dialog, key = '', value?: number): WindowRow {
  const row = el('div', 'us-row us-window');
  const keyIn = textInput(key, 'claude-sonnet-5', 'us-key');
  const valIn = textInput(value === undefined ? '' : String(value), '1000000');
  const wr: WindowRow = { row, key: keyIn, value: valIn };
  const del = el('button', 'us-del', '删除');
  del.type = 'button';
  del.addEventListener('click', () => {
    d.windows = d.windows.filter(x => x !== wr);
    row.remove();
  });
  row.append(keyIn, valIn, del);
  d.windowBox.appendChild(row);
  d.windows.push(wr);
  return wr;
}

function buildDialog(): Dialog {
  const backdrop = el('div', 'modal-backdrop');
  backdrop.id = 'usage-settings-backdrop';
  backdrop.hidden = true;
  const modal = el('div', 'modal usage-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'usage-settings-title');
  const form = el('form');
  form.id = 'usage-settings-form';
  const title = el('h2', '', '上下文设置');
  title.id = 'usage-settings-title';

  const warn = textInput('', '80', 'us-short');
  warn.id = 'us-warn';
  const danger = textInput('', '95', 'us-short');
  danger.id = 'us-danger';
  const field = el('label', 'us-field');
  field.appendChild(el('span', 'us-lab', '上下文告警（%）：占用达到黄档提醒一次，达到红档再提醒一次'));
  const line = el('span', 'us-line');
  line.append(el('span', 'us-tag', '黄'), warn, el('span', 'us-tag', '红'), danger);
  field.appendChild(line);

  const windowBox = el('div', 'us-table');
  windowBox.id = 'us-windows';
  const head = el('div', 'us-row us-head us-window');
  head.append(el('span', '', '模型前缀'), el('span', '', '窗口（token）'), el('span'));
  windowBox.appendChild(head);

  const error = el('div', 'form-error us-error');
  error.id = 'us-error';
  const restore = el('button', 'btn', '恢复默认');
  restore.type = 'button';
  const cancel = el('button', 'btn', '取消');
  cancel.type = 'button';
  const save = el('button', 'btn white', '保存');
  save.type = 'submit';
  save.id = 'us-save';
  const buttons = el('div', 'dialog-buttons');
  buttons.append(restore, cancel, save);

  const d: Dialog = { backdrop, warn, danger, windowBox, error, save, windows: [] };
  const add = el('button', 'btn sm us-add', '+ 添加一行');
  add.type = 'button';
  add.addEventListener('click', () => addWindowRow(d).key.focus());
  form.append(
    title, field,
    el('div', 'us-h', '窗口覆盖（优先于自动推断；前缀可用尾部 * 通配）'),
    windowBox, add, error, buttons,
  );
  modal.appendChild(form);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  restore.addEventListener('click', () => { fill(d, defaultUsageSettings()); setError(d, ''); });
  cancel.addEventListener('click', () => close(d));
  form.addEventListener('submit', e => { e.preventDefault(); void submit(d); });
  return d;
}

function fill(d: Dialog, s: UsageSettings): void {
  d.warn.value = String(s.contextWarnPct);
  d.danger.value = String(s.contextDangerPct);
  for (const r of d.windows) r.row.remove();
  d.windows = [];
  for (const [k, w] of Object.entries(s.windows)) addWindowRow(d, k, w);
}

function setError(d: Dialog, text: string): void {
  d.error.textContent = text;
}

const blank = (i: HTMLInputElement): boolean => i.value.trim() === '';

/** 从表单收集设置；整行留空的覆盖行忽略。返回规范化后的设置或第一处错误 */
export function collectSettings(d: Pick<Dialog, 'warn' | 'danger' | 'windows'>):
  { ok: true; value: UsageSettings } | { ok: false; error: string } {
  const windows: Record<string, unknown> = {};
  for (const r of d.windows) {
    if (blank(r.key) && blank(r.value)) continue;
    const key = r.key.value.trim().toLowerCase();
    if (!key) return { ok: false, error: '窗口覆盖的模型前缀不能为空' };
    if (key in windows) return { ok: false, error: `窗口覆盖的模型前缀重复：${key}` };
    windows[key] = r.value.value.trim();
  }
  return sanitizeUsageSettings({
    contextWarnPct: d.warn.value.trim(),
    contextDangerPct: d.danger.value.trim(),
    windows,
  });
}

async function submit(d: Dialog): Promise<void> {
  const r = collectSettings(d);
  if (!r.ok) { setError(d, r.error); return; }
  d.save.disabled = true;
  try {
    const res = await api.setSettings(r.value);
    if (!res.ok) { setError(d, res.error); return; }
    cached = r.value;
    close(d);
    toast('上下文设置已保存', 'success');
    onSaved();
  } catch (err) {
    setError(d, ipcErrorText(err) || '保存失败');
  } finally {
    d.save.disabled = false;
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !dlg || dlg.backdrop.hidden) return;
  e.preventDefault();
  e.stopPropagation();
  close(dlg);
}

function close(d: Dialog): void {
  d.backdrop.hidden = true;
  document.removeEventListener('keydown', onKey, true);
  if (prevFocus && prevFocus.isConnected) prevFocus.focus();
  prevFocus = null;
}

/** 打开上下文设置；打开前重新读取一次设置，避免显示过期内容 */
export async function openUsageSettings(): Promise<void> {
  if (!dlg) dlg = buildDialog();
  const d = dlg;
  await reloadUsageSettings();
  fill(d, cached);
  setError(d, '');
  if (d.backdrop.hidden) {
    prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.addEventListener('keydown', onKey, true);
  }
  d.backdrop.hidden = false;
  d.warn.focus();
}
