import type { PromptTemplate, TemplateInput } from '../../../shared/template';
import { parseTemplateVars, sanitizeTemplateInput, sortTemplates } from '../../../shared/template.js';
import { matchesQuery } from '../../../shared/session-view.js';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';

/**
 * 模板管理弹窗：左侧列表（名称、使用次数，可搜索，可新建），右侧编辑名称、说明与正文，
 * 正文下方实时列出解析出的变量（内置灰色、自定义蓝色）。
 * 「保存」新建或覆盖当前模板，「删除」需确认，「复制为新模板」把当前内容作为未保存的新模板继续编辑。
 * 切换条目、新建或关闭时，有未保存的修改会先确认是否放弃。
 */

export interface ManageOptions {
  /** 打开后选中的模板 */
  selectId?: string;
  /** 以给定内容开始一个未保存的新模板 */
  draft?: TemplateInput;
}

interface Dialog {
  backdrop: HTMLElement;
  search: HTMLInputElement;
  list: HTMLElement;
  name: HTMLInputElement;
  desc: HTMLInputElement;
  body: HTMLTextAreaElement;
  vars: HTMLElement;
  error: HTMLElement;
  save: HTMLButtonElement;
  del: HTMLButtonElement;
  dup: HTMLButtonElement;
}

let ctx: AppContext;
let onChanged: (list: PromptTemplate[]) => void = () => undefined;
let dlg: Dialog | null = null;
let templates: PromptTemplate[] = [];
/** 正在编辑的模板 id；undefined 表示未保存的新模板 */
let currentId: string | undefined;
/** 打开编辑区时的内容，用于判断是否有未保存的修改 */
let baseline = '';
let prevFocus: HTMLElement | null = null;

export function bindManageDialog(c: AppContext, changed: (list: PromptTemplate[]) => void): void {
  ctx = c;
  onChanged = changed;
}

export function isManageDialogOpen(): boolean {
  return !!dlg && !dlg.backdrop.hidden;
}

function input(id: string, placeholder: string): HTMLInputElement {
  const i = el('input');
  i.type = 'text';
  i.id = id;
  i.placeholder = placeholder;
  i.spellcheck = false;
  return i;
}

function button(id: string, text: string, cls = 'btn'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.id = id;
  return b;
}

function buildDialog(): Dialog {
  const backdrop = el('div', 'modal-backdrop');
  backdrop.id = 'tpl-manage-backdrop';
  backdrop.hidden = true;
  const modal = el('div', 'modal tpl-manage-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'tpl-manage-title');
  const title = el('h2', '', '提示词模板');
  title.id = 'tpl-manage-title';

  const side = el('div', 'tpl-m-side');
  const search = input('tpl-m-search', '搜索名称或正文');
  const list = el('div', 'tpl-m-list');
  list.id = 'tpl-m-list';
  const add = button('tpl-m-new', '＋ 新建', 'btn sm');
  side.append(search, list, add);

  const edit = el('div', 'tpl-m-edit');
  const name = input('tpl-m-name', '模板名称');
  const desc = input('tpl-m-desc', '说明（可选）');
  const body = el('textarea', 'tpl-m-body');
  body.id = 'tpl-m-body';
  body.spellcheck = false;
  body.placeholder = '正文，变量写作 {{名称}} 或 {{名称:默认值}}；内置变量：{{分支}} {{目录}} {{项目}} {{日期}} {{改动文件}}，{{文件}} 可选择文件；\\{{ 输出字面的 {{';
  const vars = el('div', 'tpl-m-vars');
  vars.id = 'tpl-m-vars';
  const error = el('div', 'form-error');
  error.id = 'tpl-m-error';
  const lab = (text: string, node: HTMLElement): HTMLElement => {
    const l = el('label', 'tpl-m-field');
    l.append(el('span', '', text), node);
    return l;
  };
  edit.append(lab('名称', name), lab('说明', desc), lab('正文', body), vars, error);

  const main = el('div', 'tpl-m-main');
  main.append(side, edit);

  const del = button('tpl-m-delete', '删除', 'btn danger');
  const dup = button('tpl-m-dup', '复制为新模板');
  const close = button('tpl-m-close', '关闭');
  const save = button('tpl-m-save', '保存', 'btn white');
  const buttons = el('div', 'dialog-buttons');
  buttons.append(del, el('span', 'tpl-m-sp'), dup, close, save);

  modal.append(title, main, buttons);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const d: Dialog = { backdrop, search, list, name, desc, body, vars, error, save, del, dup };
  search.addEventListener('input', () => renderList(d));
  body.addEventListener('input', () => renderVars(d));
  add.addEventListener('click', () => { void guard(d).then(ok => { if (ok) startNew(d); }); });
  dup.addEventListener('click', () => duplicate(d));
  del.addEventListener('click', () => { void remove(d); });
  save.addEventListener('click', () => { void submit(d); });
  close.addEventListener('click', () => { void tryClose(d); });
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) void tryClose(d); });
  return d;
}

function snapshot(d: Dialog): string {
  return JSON.stringify([d.name.value, d.desc.value, d.body.value]);
}

function dirty(d: Dialog): boolean {
  return snapshot(d) !== baseline;
}

/** 有未保存的修改时确认是否放弃；返回 true 表示可以继续 */
async function guard(d: Dialog): Promise<boolean> {
  if (!dirty(d)) return true;
  return ctx.confirm({ title: '放弃未保存的修改？', message: '当前模板有未保存的修改，继续将丢失这些修改。', okText: '放弃修改', danger: true });
}

function renderList(d: Dialog): void {
  d.list.innerHTML = '';
  const q = d.search.value;
  const shown = templates.filter(t => matchesQuery(q, t.name, t.description, t.body));
  if (shown.length === 0) {
    d.list.appendChild(el('div', 'tpl-m-none', templates.length === 0 ? '还没有模板' : '没有匹配的模板'));
  }
  for (const t of shown) {
    const row = el('button', `tpl-m-item${t.id === currentId ? ' on' : ''}`);
    row.type = 'button';
    row.dataset.id = t.id;
    row.append(el('span', 'tpl-m-iname', t.name), el('span', 'tpl-m-icount', t.useCount > 0 ? `${t.useCount} 次` : '未用'));
    row.title = t.description ?? t.name;
    row.addEventListener('click', () => {
      if (t.id === currentId) return;
      void guard(d).then(ok => { if (ok) select(d, t); });
    });
    d.list.appendChild(row);
  }
}

function renderVars(d: Dialog): void {
  d.vars.innerHTML = '';
  const vars = parseTemplateVars(d.body.value);
  if (vars.length === 0) {
    d.vars.appendChild(el('span', 'tpl-m-novar', '没有变量'));
    return;
  }
  for (const v of vars) {
    const tag = el('span', `tpl-var ${v.builtin ? 'builtin' : 'custom'}`, v.defaultValue !== undefined ? `${v.name}：${v.defaultValue}` : v.name);
    tag.title = v.builtin ? '内置变量，自动填充' : v.kind === 'file' ? '文件变量，填写时可选择文件' : v.defaultValue !== undefined ? '自定义变量，有默认值' : '自定义变量，必填';
    d.vars.appendChild(tag);
  }
}

function fillEditor(d: Dialog, v: { name: string; description?: string; body: string }): void {
  d.name.value = v.name;
  d.desc.value = v.description ?? '';
  d.body.value = v.body;
  d.error.textContent = '';
  renderVars(d);
}

function select(d: Dialog, t: PromptTemplate): void {
  currentId = t.id;
  fillEditor(d, t);
  baseline = snapshot(d);
  d.del.disabled = false;
  d.dup.disabled = false;
  renderList(d);
}

function startNew(d: Dialog, draft?: TemplateInput): void {
  currentId = undefined;
  fillEditor(d, { name: '', body: '' });
  baseline = snapshot(d);
  if (draft) fillEditor(d, draft);
  d.del.disabled = true;
  d.dup.disabled = true;
  renderList(d);
  d.name.focus();
}

function duplicate(d: Dialog): void {
  const v = { name: `${d.name.value.trim() || '模板'} 副本`, description: d.desc.value, body: d.body.value };
  currentId = undefined;
  fillEditor(d, { name: '', body: '' });
  baseline = snapshot(d);
  fillEditor(d, v);
  d.del.disabled = true;
  d.dup.disabled = true;
  renderList(d);
  d.name.focus();
  d.name.select();
}

async function reload(): Promise<void> {
  templates = sortTemplates(await ctx.api.templates.list());
  onChanged(templates);
}

async function submit(d: Dialog): Promise<void> {
  const r = sanitizeTemplateInput({ id: currentId, name: d.name.value, description: d.desc.value, body: d.body.value });
  if (!r.ok) { d.error.textContent = r.error; return; }
  d.save.disabled = true;
  try {
    const res = await ctx.api.templates.save(r.value);
    if (!res.ok) { d.error.textContent = res.error; return; }
    await reload();
    select(d, res.template);
    ctx.toast(`模板「${res.template.name}」已保存`, 'success');
  } catch (err) {
    d.error.textContent = ipcErrorText(err) || '保存失败';
  } finally {
    d.save.disabled = false;
  }
}

async function remove(d: Dialog): Promise<void> {
  const t = templates.find(x => x.id === currentId);
  if (!t) return;
  const ok = await ctx.confirm({ title: '删除模板？', message: `模板「${t.name}」将被删除，无法恢复。`, okText: '删除', danger: true });
  if (!ok) return;
  try {
    await ctx.api.templates.remove(t.id);
    await reload();
    const next = templates[0];
    if (next) select(d, next);
    else startNew(d);
    ctx.toast(`已删除模板「${t.name}」`, 'info');
  } catch (err) {
    d.error.textContent = ipcErrorText(err) || '删除失败';
  }
}

function onKey(e: KeyboardEvent): void {
  if (!dlg || dlg.backdrop.hidden) return;
  if (!document.getElementById('confirm-backdrop')?.hidden) return;
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    void tryClose(dlg);
  } else if (e.key.toLowerCase() === 's' && e.ctrlKey && !e.shiftKey && !e.altKey) {
    e.preventDefault(); e.stopPropagation();
    void submit(dlg);
  }
}

async function tryClose(d: Dialog): Promise<void> {
  if (!(await guard(d))) return;
  d.backdrop.hidden = true;
  document.removeEventListener('keydown', onKey, true);
  if (prevFocus && prevFocus.isConnected) prevFocus.focus();
  prevFocus = null;
}

/** 打开管理弹窗；每次打开重新读取列表 */
export async function openTemplateManager(opts: ManageOptions = {}): Promise<void> {
  if (!dlg) dlg = buildDialog();
  const d = dlg;
  try {
    await reload();
  } catch (err) {
    ctx.toast(`读取模板失败：${ipcErrorText(err)}`, 'error');
    return;
  }
  if (d.backdrop.hidden) {
    prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.addEventListener('keydown', onKey, true);
  }
  d.backdrop.hidden = false;
  d.search.value = '';
  const pick = opts.selectId ? templates.find(t => t.id === opts.selectId) : undefined;
  if (opts.draft || (!pick && templates.length === 0)) startNew(d, opts.draft);
  else select(d, pick ?? templates[0]);
  if (!opts.draft && pick === undefined && templates.length > 0) d.search.focus();
  else if (pick) d.body.focus();
}
