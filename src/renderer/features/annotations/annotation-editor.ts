import { el } from '../../core/dom.js';

/**
 * 批注编辑卡片：标题、意见输入框、保存与取消。Ctrl+Enter 保存，Esc 取消；
 * 保存失败时错误显示在卡片内，卡片与已输入的内容保留。
 */

export interface EditorOptions {
  title: string;
  initial?: string;
  /** 返回错误文本；成功返回 null */
  onSave(comment: string): Promise<string | null>;
  onCancel(): void;
}

export interface Editor {
  el: HTMLElement;
  focus(): void;
  value(): string;
  /** 让保存按钮不可用并给出原因（如所选行已变化） */
  block(reason: string): void;
}

export function buildEditor(o: EditorOptions): Editor {
  const card = el('div', 'ann-card');
  const title = el('div', 'ann-card-title', o.title);
  const input = el('textarea', 'ann-input');
  input.rows = 3;
  input.placeholder = '写下修改意见…';
  input.spellcheck = false;
  input.value = o.initial ?? '';
  const foot = el('div', 'ann-card-foot');
  const err = el('span', 'ann-card-err');
  const hint = el('span', 'ann-card-hint', 'Ctrl+Enter 保存 · Esc 取消');
  const cancel = el('button', 'chg-btn', '取消');
  const save = el('button', 'chg-btn primary ann-save', '保存');
  cancel.type = 'button';
  save.type = 'button';
  foot.append(err, el('span', 'chg-sp'), hint, cancel, save);
  card.append(title, input, foot);

  let saving = false;
  let blocked = '';
  const doSave = async (): Promise<void> => {
    if (saving || blocked) return;
    const text = input.value.trim();
    if (!text) {
      err.textContent = '意见不能为空';
      input.focus();
      return;
    }
    saving = true;
    save.disabled = true;
    err.textContent = '';
    let msg: string | null;
    try {
      msg = await o.onSave(text);
    } catch (e) {
      msg = String((e as Error)?.message ?? e);
    }
    saving = false;
    save.disabled = !!blocked;
    if (msg) {
      err.textContent = msg;
      if (card.isConnected) input.focus();
    }
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void doSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      o.onCancel();
    }
  });
  input.addEventListener('input', () => { if (!blocked) err.textContent = ''; });
  save.addEventListener('click', () => void doSave());
  cancel.addEventListener('click', () => o.onCancel());
  // 卡片内的鼠标操作不触发行号栏的选择
  card.addEventListener('mousedown', e => e.stopPropagation());

  return {
    el: card,
    focus: () => input.focus({ preventScroll: false }),
    value: () => input.value,
    block(reason: string): void {
      blocked = reason;
      save.disabled = true;
      err.textContent = reason;
    },
  };
}
