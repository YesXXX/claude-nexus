import type { PromptTemplate, TemplateContext, TemplateVar } from '../../../shared/template';
import { contextValues, parseTemplateVars, renderTemplate } from '../../../shared/template.js';
import type { TemplatesBridge } from '../../core/api.js';
import { el, ipcErrorText } from '../../core/dom.js';

/**
 * 变量填写对话框：只列需要用户填写的变量，内置变量预填当前取值、可以修改，底部实时预览渲染结果。
 * 会话场景有「插入」「插入并发送」两个动作，新建表单场景只有「填入」。
 * 动作交给调用方的 onAction 执行，失败原因显示在对话框内、对话框保持打开；成功后关闭。
 * 自定义变量既没有取值也没有默认值时不能执行；blocked 给出不能写入会话的原因时两个动作都置灰。
 */

export type FillAction = 'insert' | 'send' | 'fill';

export interface FillRequest {
  template: PromptTemplate;
  context: TemplateContext | null;
  /** 文件变量的选择框按此会话或目录计算相对路径 */
  sessionId: string | null;
  cwd?: string;
  target: 'session' | 'form';
  /** 默认获得焦点的动作（回车执行） */
  primary: FillAction;
  /** 不能写入会话的原因 */
  blocked?: string | null;
  /** 返回错误文本表示失败，对话框保持打开 */
  onAction(action: FillAction, text: string): Promise<string | null>;
}

interface Field { v: TemplateVar; input: HTMLInputElement | HTMLTextAreaElement }

let open: { backdrop: HTMLElement; close(): void } | null = null;

export function isFillDialogOpen(): boolean {
  return open !== null;
}

function field(v: TemplateVar, value: string, multi: boolean): HTMLInputElement | HTMLTextAreaElement {
  const input = multi ? el('textarea', 'tpl-f-area') : el('input');
  if (input instanceof HTMLInputElement) input.type = 'text';
  input.value = value;
  input.spellcheck = false;
  input.dataset.var = v.name;
  input.placeholder = v.defaultValue !== undefined ? `默认：${v.defaultValue || '（空）'}` : v.builtin ? '取不到，留空' : '必填';
  return input;
}

function actionButton(id: string, text: string, primary: boolean): HTMLButtonElement {
  const b = el('button', primary ? 'btn white' : 'btn', text);
  b.type = 'button';
  b.id = id;
  return b;
}

/** 打开对话框；已有一个打开时先关闭旧的 */
export function openFillDialog(api: TemplatesBridge, req: FillRequest): void {
  open?.close();
  const vars = parseTemplateVars(req.template.body);
  const ctxVals = contextValues(req.context);

  const backdrop = el('div', 'modal-backdrop');
  backdrop.id = 'tpl-fill-backdrop';
  const modal = el('div', 'modal tpl-fill-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'tpl-fill-title');
  const title = el('h2', '', `填写模板：${req.template.name}`);
  title.id = 'tpl-fill-title';
  modal.appendChild(title);
  if (req.template.description) modal.appendChild(el('p', 'tpl-f-desc', req.template.description));

  const fields: Field[] = [];
  const user = vars.filter(v => !v.builtin);
  const builtin = vars.filter(v => v.builtin);
  const addGroup = (head: string, list: TemplateVar[]): void => {
    if (list.length === 0) return;
    modal.appendChild(el('div', 'tpl-f-h', head));
    const box = el('div', 'tpl-f-grid');
    for (const v of list) {
      const lab = el('label', 'tpl-f-field');
      lab.appendChild(el('span', 'tpl-f-lab', v.name));
      const input = field(v, v.builtin ? ctxVals[v.name] ?? '' : '', v.name === '改动文件');
      const line = el('span', 'tpl-f-line');
      line.appendChild(input);
      if (v.kind === 'file') {
        const pick = el('button', 'btn sm', '选择…');
        pick.type = 'button';
        pick.dataset.pick = v.name;
        pick.addEventListener('click', () => { void pickFile(input); });
        line.appendChild(pick);
      }
      lab.appendChild(line);
      box.appendChild(lab);
      fields.push({ v, input });
    }
    modal.appendChild(box);
  };
  addGroup('需要填写', user);
  addGroup('自动填充（可修改）', builtin);

  modal.appendChild(el('div', 'tpl-f-h', '预览'));
  const preview = el('pre', 'tpl-f-preview');
  preview.id = 'tpl-fill-preview';
  modal.appendChild(preview);
  const note = el('div', 'form-error tpl-f-note');
  note.id = 'tpl-fill-note';
  modal.appendChild(note);

  const buttons = el('div', 'dialog-buttons');
  const cancel = actionButton('tpl-fill-cancel', '取消', false);
  buttons.appendChild(cancel);
  const acts: Array<[FillAction, HTMLButtonElement]> = req.target === 'form'
    ? [['fill', actionButton('tpl-fill-fill', '填入', true)]]
    : [
      ['insert', actionButton('tpl-fill-insert', '插入', req.primary === 'insert')],
      ['send', actionButton('tpl-fill-send', '插入并发送', req.primary === 'send')],
    ];
  for (const [, b] of acts) buttons.appendChild(b);
  modal.appendChild(buttons);
  backdrop.appendChild(modal);

  const values = (): Record<string, string> => Object.fromEntries(fields.map(f => [f.v.name, f.input.value]));
  let running = false;
  let failure = '';
  const refresh = (): void => {
    const r = renderTemplate(req.template.body, values());
    preview.textContent = r.text;
    const reason = r.missing.length > 0 ? `还需填写：${r.missing.join('、')}` : req.blocked ?? '';
    for (const [, b] of acts) {
      b.disabled = running || !!reason;
      b.title = reason;
    }
    note.textContent = reason || failure;
  };

  const pickFile = async (input: HTMLInputElement | HTMLTextAreaElement): Promise<void> => {
    try {
      const picked = await api.pickFile(req.sessionId, req.cwd);
      if (!picked) return;
      input.value = picked.path;
      failure = picked.absolute ? '所选文件不在会话目录内，已插入绝对路径' : '';
      refresh();
      input.focus();
    } catch (err) {
      failure = ipcErrorText(err);
      refresh();
    }
  };

  const run = async (action: FillAction): Promise<void> => {
    const r = renderTemplate(req.template.body, values());
    if (running || r.missing.length > 0 || req.blocked) return;
    running = true;
    failure = '';
    refresh();
    let err: string | null;
    try {
      err = await req.onAction(action, r.text);
    } catch (e) {
      err = ipcErrorText(e) || '执行失败';
    }
    running = false;
    if (err === null) { close(); return; }
    failure = err;
    refresh();
  };

  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const onKey = (e: KeyboardEvent): void => {
    // 确认框叠在上面时让它先处理
    if (!document.getElementById('confirm-backdrop')?.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      close();
    } else if (e.key === 'Enter' && !e.isComposing && !(e.target instanceof HTMLTextAreaElement && !e.ctrlKey)
      && !(e.target instanceof HTMLButtonElement)) {
      // 单行输入框里回车执行默认动作；多行框里 Ctrl+Enter
      e.preventDefault(); e.stopPropagation();
      void run(req.primary);
    }
  };
  const close = (): void => {
    if (open?.backdrop !== backdrop) return;
    open = null;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (prevFocus && prevFocus.isConnected) prevFocus.focus();
  };

  for (const f of fields) f.input.addEventListener('input', () => { failure = ''; refresh(); });
  for (const [a, b] of acts) b.addEventListener('click', () => { void run(a); });
  cancel.addEventListener('click', close);
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);
  open = { backdrop, close };
  refresh();

  const firstEmpty = fields.find(f => !f.v.builtin && f.input.value === '' && f.v.defaultValue === undefined);
  const primaryBtn = acts.find(([a]) => a === req.primary)?.[1] ?? acts[0][1];
  (firstEmpty?.input ?? fields.find(f => !f.v.builtin)?.input ?? (primaryBtn.disabled ? cancel : primaryBtn)).focus();
}
