import type { BatchItemView, BatchView } from '../../../shared/batch-types';
import { batchFirstTurnText, batchStatusText } from '../../../shared/batch-view.js';
import { longDuration } from '../../../shared/session-view.js';
import { verifyBadge } from '../../../shared/verify-view.js';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { STATUS_TEXT } from '../../core/labels.js';
import { runDiscardAll, runKeep } from './keep-flow.js';

/**
 * 批次对比视图：一个大弹窗，每个方案一列（窄窗口时改为纵向卡片）。
 * 每列显示状态、用时与轮数、相对基线的改动统计、改动最多的文件、验证结果，
 * 以及「查看改动」（跳到该会话的改动标签）和「保留此方案」。
 * 批次变化推送与每 5 秒的定时刷新都会重新拉取视图；保留或全部放弃后视图保持打开，显示结果状态。
 */

const REFRESH_MS = 5000;
const CHANGE_DEBOUNCE_MS = 300;

let current: { batchId: string; close(): void; reload(): void } | null = null;

export function isCompareOpen(): boolean {
  return current !== null;
}

/** 批次变化推送：对比视图正在显示该批次时刷新 */
export function notifyBatchChanged(id: string): void {
  if (current && current.batchId === id) current.reload();
}

function btn(id: string, text: string, cls = 'btn'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  if (id) b.id = id;
  return b;
}

function fmtTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function statLine(it: BatchItemView): HTMLElement {
  const box = el('div', 'batch-stat');
  if (!it.alive) {
    box.append(el('span', 'batch-st batch-st-gone', '会话已结束'));
    return box;
  }
  const st = it.status ? STATUS_TEXT[it.status] ?? it.status : '未知';
  const s = el('span', `batch-st st-${it.status ?? 'unknown'}`, st);
  box.append(s);
  if (it.durationMs > 0) box.append(el('span', 'batch-dim', longDuration(it.durationMs)));
  box.append(el('span', 'batch-dim', it.turnsCompleted > 0 ? `${it.turnsCompleted} 轮` : '首轮进行中'));
  return box;
}

function changeBlock(it: BatchItemView): HTMLElement {
  const box = el('div', 'batch-changes');
  const c = it.changes;
  if (it.error && !c) {
    box.append(el('div', 'batch-err', it.error));
    return box;
  }
  if (!c) {
    box.append(el('div', 'batch-dim', it.worktree ? '改动读取中…' : '没有独立工作区'));
    return box;
  }
  const sum = el('div', 'batch-sum');
  sum.append(el('b', '', `${c.files} 个文件`), el('span', 'add', `+${c.additions}`), el('span', 'del', `−${c.deletions}`));
  box.append(sum);
  if (!it.topFiles.length) {
    box.append(el('div', 'batch-dim', '相对基线还没有改动'));
    return box;
  }
  const ul = el('ul', 'batch-files');
  for (const f of it.topFiles) {
    const li = el('li', `batch-file k-${f.kind}`);
    li.title = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
    li.append(el('span', 'batch-fpath', f.path));
    const n = el('span', 'batch-fnum');
    if (f.additions === null || f.deletions === null) n.textContent = '二进制';
    else n.append(el('span', 'add', `+${f.additions}`), el('span', 'del', `−${f.deletions}`));
    li.append(n);
    ul.append(li);
  }
  box.append(ul);
  if (c.files > it.topFiles.length) box.append(el('div', 'batch-dim', `另有 ${c.files - it.topFiles.length} 个文件`));
  return box;
}

function verifyLine(it: BatchItemView): HTMLElement {
  const box = el('div', 'batch-verify');
  if (!it.verify) {
    box.append(el('span', 'batch-dim', '未验证'));
    return box;
  }
  const v = verifyBadge(it.verify);
  const b = el('span', `verify-badge ${v.cls}`, v.icon);
  b.title = v.title;
  box.append(b, el('span', 'batch-vtext', `验证${v.text}`));
  return box;
}

export function openCompare(ctx: AppContext, batchId: string): void {
  current?.close();
  const prevFocus = document.activeElement as HTMLElement | null;
  const backdrop = el('div', 'modal-backdrop batch-backdrop');
  backdrop.id = 'batch-backdrop';
  const modal = el('div', 'modal batch-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'batch-title');
  const head = el('div', 'batch-head');
  const titles = el('div', 'batch-titles');
  const title = el('h2', 'batch-title', '批次对比');
  title.id = 'batch-title';
  const meta = el('div', 'batch-meta');
  meta.id = 'batch-meta';
  titles.append(title, meta);
  const bRefresh = btn('batch-refresh', '刷新');
  const bDiscard = btn('batch-discard-all', '全部放弃', 'btn danger');
  const bForget = btn('batch-forget', '删除记录');
  const bClose = btn('batch-close', '关闭', 'btn white');
  const tools = el('div', 'batch-tools');
  tools.append(bRefresh, bDiscard, bForget, bClose);
  head.append(titles, tools);
  const prompt = el('div', 'batch-prompt');
  const err = el('div', 'form-error batch-load-err');
  err.hidden = true;
  const cols = el('div', 'batch-cols');
  cols.id = 'batch-cols';
  modal.append(head, prompt, err, cols);
  backdrop.append(modal);

  let view: BatchView | null = null;
  let seq = 0;
  let busy = false;
  let debounce: number | undefined;

  const paintHead = (): void => {
    if (!view) return;
    const b = view.batch;
    title.textContent = `批次对比：${b.label}`;
    const base = b.baseCommit ? `${b.baseRef || '基线'}@${b.baseCommit.slice(0, 8)}` : b.baseRef;
    meta.textContent = [`基线 ${base}`, batchFirstTurnText(view.items), fmtTime(b.createdAt), batchStatusText(b)]
      .filter(Boolean).join(' · ');
    meta.title = b.repoRoot;
    prompt.textContent = b.prompt;
    prompt.title = b.prompt;
    prompt.hidden = !b.prompt;
    const active = b.status === 'active';
    bDiscard.hidden = !active;
    bDiscard.disabled = busy;
    bForget.hidden = active;
    bRefresh.disabled = busy;
  };

  const column = (it: BatchItemView): HTMLElement => {
    const b = view!.batch;
    const col = el('section', 'batch-col');
    col.dataset.sessionId = it.sessionId;
    col.dataset.index = String(it.index);
    if (b.keptSessionId === it.sessionId) col.classList.add('kept');
    if (!it.alive) col.classList.add('gone');
    const top = el('div', 'batch-col-h');
    const jump = btn('', `#${it.index}`, 'batch-jump');
    jump.title = it.alive ? `切换到 ${it.label}` : it.label;
    jump.disabled = !it.alive;
    jump.addEventListener('click', () => { close(); ctx.actions.selectSession(it.sessionId); });
    top.append(jump, el('span', 'batch-col-label', it.label));
    if (b.keptSessionId === it.sessionId) top.append(el('span', 'tagx batch-kept-tag', '已保留'));
    col.append(top, statLine(it));
    if (it.worktree) {
      const wt = el('div', 'batch-branch', it.worktree.branch);
      wt.title = it.worktree.path;
      col.append(wt);
    }
    col.append(changeBlock(it), verifyLine(it));
    const ops = el('div', 'batch-ops');
    const bView = btn('', '查看改动', 'btn batch-view-changes');
    bView.disabled = !it.alive;
    bView.addEventListener('click', () => {
      close();
      ctx.actions.selectSession(it.sessionId);
      ctx.actions.setPaneTab('changes');
    });
    const bKeep = btn('', '保留此方案', 'btn white batch-keep');
    bKeep.disabled = busy || b.status !== 'active' || !it.alive;
    bKeep.title = b.status !== 'active' ? '该批次已处理' : !it.alive ? '会话已不在列表中' : '保留此方案，结束其余方案并删除它们的工作区';
    bKeep.addEventListener('click', () => void doKeep(it.sessionId));
    ops.append(bView, bKeep);
    col.append(ops);
    return col;
  };

  const paint = (): void => {
    paintHead();
    cols.replaceChildren();
    if (!view) return;
    if (!view.items.length) {
      cols.append(el('div', 'batch-empty', '该批次没有可显示的方案'));
      return;
    }
    cols.style.setProperty('--batch-n', String(view.items.length));
    for (const it of view.items) cols.append(column(it));
  };

  const load = async (): Promise<void> => {
    const my = ++seq;
    try {
      const v = await ctx.api.batch.view(batchId);
      if (my !== seq || current?.batchId !== batchId) return;
      if (!v) {
        err.hidden = false;
        err.textContent = '该批次记录已不存在';
        view = null;
        cols.replaceChildren();
        return;
      }
      err.hidden = true;
      view = v;
      paint();
    } catch (e) {
      if (my !== seq) return;
      err.hidden = false;
      err.textContent = ipcErrorText(e);
    }
  };

  const withBusy = async (fn: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    busy = true;
    paint();
    try { await fn(); } finally { busy = false; await load(); }
  };

  const doKeep = (sessionId: string): Promise<void> => withBusy(async () => {
    if (view) await runKeep(ctx, view, sessionId);
  });

  const reload = (): void => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void load(), CHANGE_DEBOUNCE_MS);
  };
  const timer = window.setInterval(() => { if (!busy) void load(); }, REFRESH_MS);

  const close = (): void => {
    window.clearInterval(timer);
    window.clearTimeout(debounce);
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (current?.batchId === batchId) current = null;
    prevFocus?.focus?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    // 确认框盖在上面时 Esc 交给确认框
    if (!(document.getElementById('confirm-backdrop')?.hidden ?? true)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  bClose.addEventListener('click', close);
  bRefresh.addEventListener('click', () => void load());
  bDiscard.addEventListener('click', () => void withBusy(async () => {
    if (view) await runDiscardAll(ctx, view);
  }));
  bForget.addEventListener('click', () => void withBusy(async () => {
    if (!view) return;
    const ok = await ctx.confirm({
      title: '删除批次记录？',
      message: `只删除「${view.batch.label}」的对比记录，不影响仍在列表中的会话与工作区`,
      okText: '删除记录',
      danger: true,
    });
    if (!ok) return;
    try {
      await ctx.api.batch.forget(batchId);
      ctx.toast('已删除批次记录', 'success');
      close();
    } catch (e) {
      ctx.toast(ipcErrorText(e), 'error');
    }
  }));
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  current = { batchId, close, reload };
  bClose.focus();
  void load();
}
