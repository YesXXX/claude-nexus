import type { RestoreReason, Session } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText, statusIcon } from '../../core/dom.js';
import { STATUS_TEXT } from '../../core/labels.js';
import {
  button, cachedCheck, FAILURE_TEXT, forkButton, inFlightMode, runResumeAction, worktreeMissingButtons,
} from './resume-actions.js';

/**
 * 无进程行的终端区卡片：跨重启保留的待续接行与已退出行没有 PTY，终端标签下显示这张卡片，
 * 给出目录、对话记录状态、保留时间与「续接对话 / 全新开始 / 归档」。
 */

const REASON_TEXT: Record<RestoreReason, string> = {
  quit: '退出面板时保留',
  crash: '面板异常退出',
  update: '安装更新前保留',
};

let ctxRef: AppContext;

export function bindDormantContext(ctx: AppContext): void {
  ctxRef = ctx;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 月-日 时:分 */
export function shortTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function row(name: string, value: string, title?: string): HTMLElement {
  const r = el('div', 'dc-row');
  const v = el('span', 'dc-val', value);
  if (title) v.title = title;
  r.append(el('span', 'dc-key', name), v);
  return r;
}

/** 归档：结束会话行、记录转入历史；工作区保留，之后仍可从历史续接 */
export async function archiveSession(id: string): Promise<boolean> {
  try {
    const r = await ctxRef.api.kill(id, { keepWorktree: true });
    if (!r.ok) {
      ctxRef.toast(r.message ?? '归档失败', 'error');
      return false;
    }
    return true;
  } catch (err) {
    ctxRef.toast(`归档失败：${ipcErrorText(err)}`, 'error');
    return false;
  }
}

/** 对话一栏：id 前缀、记录是否存在、轮数 */
function transcriptText(s: Session): { text: string; title?: string } {
  const id = s.claudeSessionId ? `${s.claudeSessionId.slice(0, 8)}…` : '无对话 id';
  const check = cachedCheck(s);
  const turns = s.turns ? ` · ${s.turns} 轮` : '';
  if (!check) return { text: `${id}  检查中…${turns}` };
  // 工作区缺失的说明单独成行显示，这里只给 id 与轮数
  if (check.reason === 'worktree_missing') return { text: `${id}${turns}` };
  if (check.resumable) return { text: `${id}  ✓ 记录存在${turns}`, title: check.message };
  return { text: `${id}  ${check.message}${turns}`, title: check.message };
}

/** 没有进程的跨重启行返回卡片，其余返回 null 照常挂终端 */
export function renderDormantCard(s: Session): HTMLElement | null {
  if (!s.dormant || s.readOnly) return null;
  const check = cachedCheck(s);
  const busy = inFlightMode(s.id);
  const card = el('div', 'dormant-card');
  card.dataset.session = s.id;

  const head = el('div', 'dc-head');
  head.append(statusIcon(s.status), el('span', 'dc-title', `${s.label} · ${STATUS_TEXT[s.status]}`));
  card.append(head);

  const dir = s.worktree ? `${s.cwd}（工作区 ${s.worktree.branch}）` : s.cwd;
  card.append(row('目录', dir, s.cwd));
  const t = transcriptText(s);
  card.append(row('对话', t.text, t.title));
  const since = s.dormantSince ?? s.statusSince;
  if (s.status === 'suspended') {
    const why = s.restoreReason ? `（${REASON_TEXT[s.restoreReason]}）` : '';
    card.append(row('保留于', `${shortTime(since)}${why}`));
  } else {
    card.append(row('退出于', shortTime(since)));
  }
  if (check?.reason === 'worktree_missing') {
    card.append(el('div', 'dc-note bad', check.message));
  } else if (s.resumeFailure) {
    const note = el('div', 'dc-note bad', `上次续接失败：${FAILURE_TEXT[s.resumeFailure.reason]}`);
    note.title = s.resumeFailure.detail ?? '';
    card.append(note);
  } else if (check && !check.resumable && check.reason === 'in_use' && check.inUseBy) {
    card.append(el('div', 'dc-note', check.message));
  }

  const acts = el('div', 'dc-acts');
  const ab = button('归档', false, () => { void archiveSession(s.id); }, Boolean(busy));
  ab.classList.add('dc-archive');
  ab.title = '结束这个会话并转入历史，之后仍可从历史续接';
  card.append(acts);
  // 工作区目录缺失：续接与全新开始都做不了，换成重建或在原仓库新建
  if (check?.reason === 'worktree_missing') {
    acts.append(...worktreeMissingButtons(s, check), ab);
    return card;
  }
  const resumable = check?.resumable === true;
  const canFresh = check ? check.canFresh : false;
  const rb = button(busy === 'resume' ? '正在续接…' : '续接对话', resumable, () => { void runResumeAction(s.id, 'resume'); },
    Boolean(busy) || !resumable);
  rb.classList.add('dc-resume');
  if (check && !resumable) rb.title = check.message;
  const fb = button(busy === 'fresh' ? '正在启动…' : '全新开始', !resumable && canFresh,
    () => { void runResumeAction(s.id, 'fresh'); }, Boolean(busy) || !canFresh);
  fb.classList.add('dc-fresh');
  acts.append(rb, fb);
  // 同一段对话正被别的会话使用：可以分叉出一个新会话
  if (check?.reason === 'in_use' && check.canFork) acts.append(forkButton(s.id));
  acts.append(ab);
  return card;
}
