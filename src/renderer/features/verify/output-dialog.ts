import type { VerifyDetail } from '../../../shared/verify-types';
import { isVerifyFinal } from '../../../shared/verify-types.js';
import { fmtVerifyDuration, verifyBadge, verifyFixable } from '../../../shared/verify-view.js';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { sessionIdle, verifyBadgeEl } from './badge.js';

/**
 * 验证输出弹窗：标题为状态与命令，正文用 ansi_up 把输出转成带颜色的 HTML（转义由 ansi_up 负责）。
 * 运行或排队期间每秒对照会话摘要，状态变化时重新拉取详情。
 * 底部：打开完整日志、复制、发给 Claude 修复、重新运行（运行中为取消）、关闭。
 */

interface AnsiUpLike { ansi_to_html(s: string): string; escape_html?: boolean; use_classes?: boolean }

let open: { sessionId: string; close(): void } | null = null;

export function isOutputDialogOpen(): boolean {
  return open !== null;
}

/** 输出转 HTML；ansi_up 未加载时退回纯文本 */
function renderOutput(pre: HTMLElement, output: string): void {
  const Ctor = (window as unknown as { AnsiUp?: new () => AnsiUpLike }).AnsiUp;
  if (!Ctor) { pre.textContent = output; return; }
  const au = new Ctor();
  au.escape_html = true;
  pre.innerHTML = au.ansi_to_html(output);
}

function btn(id: string, text: string, primary = false): HTMLButtonElement {
  const b = el('button', primary ? 'btn white' : 'btn', text);
  b.type = 'button';
  b.id = id;
  return b;
}

function summaryKey(d: { status: string; finishedAt?: number; startedAt?: number; queuePosition?: number } | undefined): string {
  return d ? `${d.status}|${d.finishedAt ?? ''}|${d.startedAt ?? ''}|${d.queuePosition ?? ''}` : '';
}

export function openOutputDialog(ctx: AppContext, sessionId: string): void {
  open?.close();
  const prevFocus = document.activeElement as HTMLElement | null;
  const backdrop = el('div', 'modal-backdrop');
  backdrop.id = 'verify-out-backdrop';
  const modal = el('div', 'modal verify-out-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const head = el('div', 'verify-out-head');
  const title = el('h2', '', '验证输出');
  const meta = el('div', 'verify-out-meta');
  head.append(title);
  const pre = el('pre', 'verify-out-pre');
  pre.id = 'verify-out-pre';
  pre.tabIndex = 0;
  const err = el('div', 'form-error verify-out-err');
  err.hidden = true;
  const bLog = btn('verify-out-log', '打开完整日志');
  const bCopy = btn('verify-out-copy', '复制');
  const bFix = btn('verify-out-fix', '发给 Claude 修复');
  const bRun = btn('verify-out-run', '重新运行');
  const bClose = btn('verify-out-close', '关闭', true);
  const btns = el('div', 'dialog-buttons');
  btns.append(bLog, bCopy, el('span', 'chg-sp'), bFix, bRun, bClose);
  modal.append(head, meta, pre, err, btns);
  backdrop.append(modal);

  let detail: VerifyDetail | null = null;
  let shownKey = '';
  let seq = 0;
  const showError = (text: string | null): void => { err.hidden = !text; err.textContent = text ?? ''; };

  const paint = (): void => {
    const s = ctx.state.sessions.find(x => x.id === sessionId);
    head.querySelector('.verify-badge')?.remove();
    if (!detail) {
      title.textContent = '验证输出';
      meta.textContent = '还没有验证结果';
      pre.textContent = '';
    } else {
      const view = verifyBadge(detail);
      head.prepend(verifyBadgeEl(detail));
      title.textContent = `验证${view.text}`;
      const parts = [detail.command];
      if (detail.durationMs !== undefined && isVerifyFinal(detail.status)) parts.push(`用时 ${fmtVerifyDuration(detail.durationMs)}`);
      if (detail.encoding === 'gbk') parts.push('按 GBK 解码');
      if (detail.message && detail.status !== 'failed') parts.push(detail.message);
      meta.textContent = parts.join(' · ');
      meta.title = detail.command;
      if (detail.output) renderOutput(pre, detail.output);
      else pre.textContent = isVerifyFinal(detail.status) ? '（没有输出）' : '验证进行中，结束后显示输出…';
    }
    const running = !!detail && !isVerifyFinal(detail.status);
    bLog.disabled = !detail?.logFile;
    bCopy.disabled = !detail?.output;
    const fixable = verifyFixable(detail ?? undefined);
    bFix.disabled = !fixable || !sessionIdle(s);
    bFix.title = !fixable ? '只有失败或超时的结果可以发给 Claude' : sessionIdle(s) ? '把命令、退出码与输出末尾发给 Claude' : 'Claude 正忙';
    bRun.textContent = running ? '取消' : '重新运行';
    bRun.disabled = !running && !sessionIdle(s);
    bRun.title = !running && !sessionIdle(s) ? 'Claude 正忙' : '';
  };

  const load = async (): Promise<void> => {
    const my = ++seq;
    try {
      const d = await ctx.api.verify.detail(sessionId);
      if (my !== seq || !open) return;
      detail = d;
      shownKey = summaryKey(d ?? undefined);
      paint();
    } catch (e) {
      showError(ipcErrorText(e));
    }
  };

  // 对照会话摘要：状态或时间变化时重新拉取详情，会话按钮的可用性也随之刷新
  const timer = window.setInterval(() => {
    const s = ctx.state.sessions.find(x => x.id === sessionId);
    if (!s) return;
    if (summaryKey(s.verify) !== shownKey) void load();
    else paint();
  }, 1000);

  const close = (): void => {
    window.clearInterval(timer);
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    open = null;
    prevFocus?.focus?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  bClose.addEventListener('click', close);
  bLog.addEventListener('click', () => {
    void ctx.api.verify.openLog(sessionId).then(r => showError(r.ok ? null : r.reason ?? '打开失败'));
  });
  bCopy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(pre.textContent ?? '').then(() => ctx.toast('已复制验证输出')).catch(() => undefined);
  });
  bFix.addEventListener('click', () => {
    bFix.disabled = true;
    void ctx.api.verify.sendToClaude(sessionId).then(r => {
      if (!r.ok) { showError(r.reason ?? '发送失败'); paint(); return; }
      ctx.toast('已把失败输出发给 Claude');
      close();
    });
  });
  bRun.addEventListener('click', () => {
    const running = !!detail && !isVerifyFinal(detail.status);
    const op = running ? ctx.api.verify.cancel(sessionId).then(ok => ({ ok, reason: ok ? undefined : '没有进行中的验证' }))
      : ctx.api.verify.run(sessionId);
    void op.then(r => { showError(r.ok ? null : r.reason ?? '操作失败'); void load(); });
  });
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  open = { sessionId, close };
  paint();
  bClose.focus();
  void load();
}
