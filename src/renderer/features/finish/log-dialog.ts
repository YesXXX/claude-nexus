import type { CommandRecord } from '../../../shared/review-types';
import { el } from '../../core/dom.js';

/**
 * 收尾操作记录：页内只列最近几条（命令、退出码、耗时），「输出」与「全部」打开弹窗查看完整 stdout / stderr。
 * 记录由主进程按会话保存，输出已截断并去掉凭据。
 */

export function hms(at: number): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}

function codeText(r: CommandRecord): string {
  if (r.code === -1) return '找不到程序';
  if (r.code === -2) return '超时';
  return `exit ${r.code}`;
}

/** 一条记录的摘要行：时间、命令、退出码、耗时；onOutput 给出时附「输出」按钮 */
export function recordRow(r: CommandRecord, onOutput?: () => void): HTMLElement {
  const row = el('div', `fin-log-row${r.ok ? '' : ' fail'}`);
  row.append(
    el('span', 'fin-log-at', hms(r.at)),
    el('span', 'fin-log-cmd', r.display),
    el('span', 'fin-log-code', codeText(r)),
    el('span', 'fin-log-ms', `${r.ms}ms`),
  );
  row.title = `工作目录：${r.cwd}`;
  if (onOutput) {
    const b = el('button', 'chg-btn fin-log-out', '输出');
    b.type = 'button';
    b.addEventListener('click', onOutput);
    row.append(b);
  }
  return row;
}

function recordBlock(r: CommandRecord): HTMLElement {
  const box = el('div', 'fin-log-block');
  box.append(recordRow(r), el('div', 'fin-log-cwd', `工作目录：${r.cwd}`));
  const out = r.stdout.trim();
  const err = r.stderr.trim();
  if (out) box.append(el('div', 'fin-log-label', 'stdout'), el('pre', 'fin-log-pre', out));
  if (err) box.append(el('div', 'fin-log-label', 'stderr'), el('pre', 'fin-log-pre err', err));
  if (!out && !err) box.append(el('div', 'fin-log-empty', '（无输出）'));
  return box;
}

/** 弹窗展示若干条记录（新的在前）；Esc 或点遮罩关闭 */
export function openLogDialog(title: string, records: CommandRecord[]): void {
  const prevFocus = document.activeElement as HTMLElement | null;
  const backdrop = el('div', 'modal-backdrop fin-log-backdrop');
  const modal = el('div', 'modal fin-log-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const list = el('div', 'fin-log-list');
  list.tabIndex = 0;
  if (records.length === 0) list.append(el('div', 'fin-log-empty', '还没有收尾操作记录'));
  for (const r of [...records].reverse()) list.append(recordBlock(r));
  const btns = el('div', 'dialog-buttons');
  const close = el('button', 'btn white', '关闭');
  close.type = 'button';
  btns.append(el('span', 'chg-sp'), close);
  const finish = (): void => {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    prevFocus?.focus?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    finish();
  };
  close.addEventListener('click', finish);
  modal.append(el('h2', '', title), list, btns);
  backdrop.append(modal);
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) finish(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  close.focus();
}
