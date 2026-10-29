import type { ResumeCheck, Session } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import { el } from '../../core/dom.js';
import type { CommandContext, PaletteItem } from '../../core/registry.js';
import { bindDormantContext, renderDormantCard } from './dormant-card.js';
import {
  bindResumeContext, button, cachedCheck, ENDED_STATUSES, FAILURE_TEXT, fetchCheck, forkButton, inFlightMode, peekCheck,
  pruneChecks, resumeCommandText, runResumeAction, worktreeMissingButtons,
} from './resume-actions.js';
import { installHistory } from './history.js';
import { installConversationSection } from './conversation-props.js';
import { installRestoreUi, refreshRestorePalette, restorePaletteItems } from './restore-ui.js';
import { installResumeSettings } from './settings-section.js';
import { installTakeover } from './takeover.js';

export { runResumeAction } from './resume-actions.js';
export type { ResumeMode } from './resume-actions.js';

/**
 * 会话续接：详情页头的续接 / 全新开始按钮组，命令面板里的续接、续接重启、全新开始、分叉与复制续接命令；
 * 无进程行的终端区卡片、询问档的恢复横幅与续接设置；首页「最近结束」、命令面板「历史」分组与属性面板「对话」分区；
 * 认领的孤儿会话的「接管并续接」。
 * 只在进程已结束的会话上显示页头按钮；进程仍在运行时的续接重启只放命令面板，避免误点打断正在工作的会话。
 */

let ctxRef: AppContext;

export function install(ctx: AppContext): void {
  ctxRef = ctx;
  bindResumeContext(ctx);
  bindDormantContext(ctx);
  ctx.registry.registerPaneAction({ id: 'resume.actions', order: 100, render: renderPaneActions });
  ctx.registry.registerTermCover({ id: 'resume.dormant-card', order: 500, render: renderDormantCard });
  ctx.registry.registerCommands({
    id: 'resume.palette', order: 500,
    items: paletteItems,
    refresh: async () => {
      const id = ctx.state.selectedId;
      const s = id ? ctx.state.sessions.find(x => x.id === id) : undefined;
      pruneChecks(new Set(ctx.state.sessions.map(x => x.id)));
      if (!s || s.readOnly) return false;
      return fetchCheck(s);
    },
  });
  ctx.registry.registerCommands({
    id: 'resume.restore', order: 510,
    items: () => restorePaletteItems(),
    refresh: refreshRestorePalette,
  });
  installRestoreUi(ctx);
  installHistory(ctx);
  installConversationSection(ctx);
  installResumeSettings(ctx);
  installTakeover(ctx);
}

function renderPaneActions(s: Session): HTMLElement | null {
  // 无进程行的按钮在终端区卡片里，页头不重复
  if (s.readOnly || s.dormant || !ENDED_STATUSES.has(s.status)) return null;
  const check = cachedCheck(s);
  if (!check || check.reason === 'busy' || check.reason === 'readonly') return null;

  const wrap = el('div', 'resume-acts');
  const busy = inFlightMode(s.id);
  const note = el('span', 'resume-note');
  const resume = (): void => { void runResumeAction(s.id, 'resume'); };
  const fresh = (): void => { void runResumeAction(s.id, 'fresh'); };
  const resumeText = busy === 'resume' ? '正在续接…' : '续接对话';
  const freshText = busy === 'fresh' ? '正在启动…' : '全新开始';
  const buttons: HTMLButtonElement[] = [];

  if (check.reason === 'worktree_missing') {
    // 工作区目录没了：先于续接失败判断，否则只剩一句失败原因而没有可点的按钮
    note.textContent = check.message;
    note.classList.add('bad');
    buttons.push(...worktreeMissingButtons(s, check));
  } else if (s.resumeFailure) {
    note.textContent = `续接失败：${FAILURE_TEXT[s.resumeFailure.reason]}`;
    note.title = s.resumeFailure.detail ?? '';
    note.classList.add('bad');
    if (check.canFresh) buttons.push(button(freshText, true, fresh, Boolean(busy)));
    if (check.resumable) buttons.push(button(busy === 'resume' ? resumeText : '再试一次续接', false, resume, Boolean(busy)));
  } else if (check.reason === 'in_use' && check.inUseBy) {
    const holder = check.inUseBy;
    note.textContent = check.message;
    buttons.push(button('跳到该会话', true, () => ctxRef.actions.selectSession(holder.id)));
    if (check.canFork) buttons.push(forkButton(s.id));
    else if (check.canFresh) buttons.push(button(freshText, false, fresh, Boolean(busy)));
  } else if (check.resumable) {
    const rb = button(resumeText, true, resume, Boolean(busy));
    rb.title = check.message;
    buttons.push(rb);
    if (check.canFresh) buttons.push(button(freshText, false, fresh, Boolean(busy)));
  } else {
    note.textContent = check.message;
    if (check.canFresh) buttons.push(button(freshText, true, fresh, Boolean(busy)));
  }
  if (buttons.length === 0 && !note.textContent) return null;
  // 失败类说明（续接失败、工作区缺失）照常显示；其余说明收成「ⓘ」，全文放在悬停提示里
  if (note.textContent && !note.classList.contains('bad')) {
    note.title = note.textContent;
    note.setAttribute('aria-label', note.textContent);
    note.classList.add('info');
    note.textContent = 'ⓘ';
  }
  if (note.textContent) wrap.append(note);
  wrap.append(...buttons);
  return wrap;
}

function paletteItems({ session: cur }: CommandContext): PaletteItem[] {
  if (!cur || cur.readOnly) return [];
  const check = peekCheck(cur.id);
  const out: PaletteItem[] = [];
  if (check?.resumable) {
    out.push({
      section: '命令', icon: '↻', title: '续接对话', sub: cur.label, hint: check.message,
      keywords: 'resume xujie duihua restart chongqi', run: () => { void runResumeAction(cur.id, 'resume'); },
    });
  }
  const repo = cur.worktree?.repoRoot;
  if (check?.reason === 'worktree_missing' && check.canRebuildWorktree) {
    out.push({
      section: '命令', icon: '↻', title: '重建工作区并续接', sub: cur.label, hint: check.message,
      keywords: 'rebuild worktree resume chongjian gongzuoqu xujie',
      run: () => { void runResumeAction(cur.id, 'resume', { rebuildWorktree: true }); },
    });
  } else if (check?.reason === 'worktree_missing' && repo) {
    out.push({
      section: '命令', icon: '＋', title: '在原仓库新建会话', sub: repo, hint: check.message,
      keywords: 'new session repo xinjian cangku', run: () => ctxRef.actions.goHome(repo),
    });
  }
  if (check?.reason === 'busy') {
    out.push({
      section: '命令', icon: '↻', title: '续接重启', sub: cur.label, hint: '结束当前进程后续接同一段对话',
      keywords: 'resume restart xujie chongqi', run: () => { void confirmThen(cur, 'resume', check); },
    });
  }
  if (!check || check.canFresh) {
    out.push({
      section: '命令', icon: '✦', title: '全新开始', sub: cur.label, hint: '不带对话上下文重新启动',
      keywords: 'fresh new restart quanxin chongqi', run: () => { void confirmThen(cur, 'fresh', check); },
    });
  }
  if (check?.canFork) {
    out.push({
      section: '命令', icon: '⑂', title: '分叉为新会话', sub: cur.label, hint: '带着这段对话另开一个会话，原会话不受影响',
      keywords: 'fork branch fencha xinhuihua', run: () => { void runResumeAction(cur.id, 'fork'); },
    });
  }
  const cmd = resumeCommandText(cur);
  if (cmd) {
    out.push({
      section: '命令', icon: '⧉', title: '复制续接命令', sub: cmd,
      keywords: 'copy resume command fuzhi xujie mingling',
      run: () => {
        void navigator.clipboard?.writeText(cmd).catch(() => undefined);
        ctxRef.toast('已复制续接命令');
      },
    });
  }
  return out;
}

/** 进程仍在运行时先确认，确认后带 force 结束当前进程再拉起 */
async function confirmThen(s: Session, mode: 'resume' | 'fresh', check: ResumeCheck | undefined): Promise<void> {
  const alive = check?.reason === 'busy' || !ENDED_STATUSES.has(s.status);
  if (alive) {
    const ok = await ctxRef.confirm({
      title: mode === 'resume' ? '续接重启' : '全新开始',
      message: mode === 'resume'
        ? `会话「${s.label}」的进程仍在运行，续接会先结束当前进程再接着同一段对话启动。`
        : `会话「${s.label}」的进程仍在运行，全新开始会结束当前进程，新进程不带之前的对话上下文。`,
      okText: mode === 'resume' ? '续接重启' : '全新开始',
      danger: true,
    });
    if (!ok) return;
  }
  await runResumeAction(s.id, mode, { force: alive });
}
