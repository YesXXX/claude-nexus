import type { AnnotationPreview, SendResult } from '../../../shared/review-types';
import type { AnnotationsBridge } from '../../core/api.js';
import type { ChoiceOptions, ToastLevel } from '../../core/dialog-types.js';
import { el, ipcErrorText } from '../../core/dom.js';

/**
 * 「发送给 Claude」流程：先取预览并在弹窗里展示将要发送的全文，确认后按 auto 发送；
 * 会话正忙时让用户选择立即发送或排队，等待权限时只能排队。不能发送（只读、已退出、已有排队）时弹窗只提供复制。
 */

export interface SendDeps {
  api: AnnotationsBridge;
  toast(text: string, level?: ToastLevel): void;
  choice<T extends string>(opts: ChoiceOptions<T>): Promise<T | null>;
  /** 发送或排队后刷新批注 */
  reload(id: string): void;
}

type Pick = 'send' | 'copy' | null;

async function copyText(text: string, toast: SendDeps['toast']): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
    toast('已复制批注文本', 'success');
  } catch (err) {
    toast(`复制失败：${ipcErrorText(err)}`, 'error');
  }
}

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** 预览弹窗；返回用户的选择。复制在弹窗内完成、不关闭 */
function previewDialog(p: AnnotationPreview, toast: SendDeps['toast']): Promise<Pick> {
  return new Promise(resolve => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const backdrop = el('div', 'modal-backdrop ann-send-backdrop');
    const modal = el('div', 'modal ann-send-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const title = el('h2', '', p.blocked ? '批注文本' : '发送给 Claude');
    const summary = el('div', 'ann-send-sum');
    if (p.blocked) {
      summary.textContent = `不能发送：${p.blocked}。可以复制文本后手动粘贴。`;
      summary.classList.add('warn');
    } else {
      summary.textContent = `将以一条消息发送 ${p.count} 条批注` + (p.stale ? `（${p.stale} 条行号可能已变化）` : '');
      if (p.omitted) summary.append(el('span', 'ann-send-omit', `；另有 ${p.omitted} 条因长度限制未包含，下次再发`));
    }
    const parts: HTMLElement[] = [title, summary];
    if (!p.blocked && !p.pasteMode) {
      parts.push(el('div', 'ann-send-warn', '未检测到 Claude 输入框的粘贴模式，多行消息可能被逐行提交'));
    }
    const pre = el('pre', 'ann-send-pre', p.text);
    pre.tabIndex = 0;
    parts.push(pre);
    if (!p.blocked) parts.push(el('div', 'ann-send-hint', '提示：Claude 输入框里尚未提交的文字会与本消息一起发出'));
    const btns = el('div', 'dialog-buttons');
    let done = false;
    const finish = (v: Pick): void => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      prevFocus?.focus?.();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    };
    const copy = button('复制为文本', 'btn', () => void copyText(p.text, toast));
    const cancel = button(p.blocked ? '关闭' : '取消', 'btn', () => finish(null));
    btns.append(copy, el('span', 'chg-sp'), cancel);
    let send: HTMLButtonElement | null = null;
    if (!p.blocked) {
      send = button('发送', 'btn white ann-send-go', () => finish('send'));
      btns.append(send);
    }
    parts.push(btns);
    modal.append(...parts);
    backdrop.append(modal);
    backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) finish(null); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    (send ?? cancel).focus();
  });
}

function report(r: SendResult, toast: SendDeps['toast']): void {
  toast(r.message, r.ok ? (r.queued ? 'info' : 'success') : 'error');
  if (r.ok && r.sent && r.warnPasteMode) toast('未检测到粘贴模式，多行消息可能被逐行提交，请留意终端', 'warning');
}

/** 完整的发送流程；没有待发送批注时只提示 */
export async function sendAnnotations(id: string, deps: SendDeps): Promise<void> {
  let p: AnnotationPreview;
  try {
    p = await deps.api.preview(id);
  } catch (err) {
    deps.toast(ipcErrorText(err), 'error');
    return;
  }
  if (!p.text) {
    deps.toast(p.blocked ?? '没有待发送的批注', 'info');
    return;
  }
  if ((await previewDialog(p, deps.toast)) !== 'send') return;
  try {
    let r = await deps.api.send(id, 'auto');
    if (r.needChoice) {
      const perm = r.needChoice === 'permission';
      const pick = await deps.choice<'now' | 'queue'>({
        title: perm ? 'Claude 正在等你确认权限' : 'Claude 正在处理本轮任务',
        message: perm
          ? 'Claude 正在等你确认权限，先处理权限再发送；也可以排队，本轮结束后自动发送。'
          : '立即发送会在 Claude 处理中插入消息；排队则在本轮结束后自动发送。',
        choices: perm
          ? [{ value: 'queue', text: '排队，本轮结束后发送', style: 'primary' }]
          : [{ value: 'now', text: '立即发送' }, { value: 'queue', text: '排队，本轮结束后发送', style: 'primary' }],
        defaultValue: 'queue',
      });
      if (!pick) return;
      r = await deps.api.send(id, pick);
    }
    report(r, deps.toast);
  } catch (err) {
    deps.toast(ipcErrorText(err), 'error');
  } finally {
    deps.reload(id);
  }
}

/** 取消排队，批注退回待发送 */
export async function cancelQueued(id: string, deps: SendDeps): Promise<void> {
  try {
    const ok = await deps.api.cancelQueued(id);
    deps.toast(ok ? '已取消排队，批注退回待发送' : '没有排队中的消息', ok ? 'info' : 'warning');
  } catch (err) {
    deps.toast(ipcErrorText(err), 'error');
  } finally {
    deps.reload(id);
  }
}

/** 复制当前待发送批注的文本（不发送） */
export async function copyAnnotations(id: string, deps: SendDeps): Promise<void> {
  try {
    const p = await deps.api.preview(id);
    if (!p.text) { deps.toast('没有待发送的批注', 'info'); return; }
    await copyText(p.text, deps.toast);
  } catch (err) {
    deps.toast(ipcErrorText(err), 'error');
  }
}
