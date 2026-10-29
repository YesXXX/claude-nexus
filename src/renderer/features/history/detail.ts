import { cwdBaseName, longDuration } from '../../../shared/session-view.js';
import {
  BLOCK_REASON_TEXT, deleteMessage, endKindText, formatStamp, recordDurationMs, recordEndTime, templateNameOf, worktreeLeft,
} from '../../../shared/history-view.js';
import type { ResumeCheck, SessionRecord } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { on } from '../../core/events.js';

/**
 * 历史详情：右侧显示一条记录的完整信息与动作。
 * 续接走历史接口（沿用原面板会话 id），不可续接时按钮禁用并显示续接检查给出的原因；
 * 删除只删记录，关联工作区仍在时提示并给出清理入口。
 */

export interface DetailHost {
  ctx: AppContext;
  /** 关闭历史面板 */
  close(): void;
  /** 记录被改动或删除后重新拉列表 */
  reload(): void;
  /** 当前记录的续接检查结果；undefined 表示检查中 */
  check(id: string): ResumeCheck | undefined;
  /** 记录模块不可用时动作全部禁用 */
  degraded(): boolean;
}

function btn(text: string, cls: string, id: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.id = id;
  b.addEventListener('click', onClick);
  return b;
}

function row(grid: HTMLElement, key: string, value: string, title?: string): void {
  if (!value) return;
  const v = el('span', 'hist-v', value);
  if (title) v.title = title;
  grid.append(el('span', 'hist-k', key), v);
}

function promptBlock(title: string, text: string, id: string): HTMLElement {
  const box = el('div', 'hist-pblock');
  box.append(el('div', 'hist-ptitle', title));
  const pre = el('pre', 'hist-prompt', text);
  pre.id = id;
  box.append(pre);
  return box;
}

/** 新拉起的会话还没随推送进入本地列表时等下一次推送（最多 2 秒） */
function ensureListed(ctx: AppContext, id: string): Promise<void> {
  if (ctx.state.sessions.some(s => s.id === id)) return Promise.resolve();
  return new Promise(resolve => {
    let off: () => void = () => undefined;
    const timer = setTimeout(() => { off(); resolve(); }, 2000);
    off = on('sessions-updated', () => {
      if (!ctx.state.sessions.some(s => s.id === id)) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

let resuming = false;

async function resume(host: DetailHost, r: SessionRecord, rebuild: boolean): Promise<void> {
  const { ctx } = host;
  if (resuming) return;
  resuming = true;
  try {
    const res = await ctx.api.recordResume(r.id, rebuild ? { mode: 'resume', rebuildWorktree: true } : { mode: 'resume' })
      .catch(err => ({ ok: false as const, message: ipcErrorText(err), sessionId: undefined }));
    if (!res.ok) {
      ctx.toast(res.message ?? '续接失败', 'error');
      host.reload();
      return;
    }
    const target = res.sessionId ?? r.id;
    host.close();
    await ensureListed(ctx, target);
    ctx.toast(res.message ? `已续接对话（${res.message}）` : '已续接对话', 'success');
    ctx.actions.showTerminalTab(target);
    ctx.actions.selectSession(target);
    ctx.actions.focusSessionInput(target);
  } finally {
    resuming = false;
  }
}

/** 打开命令面板并预填「清理工作区」，定位到对应的清理条目 */
function openCleanup(host: DetailHost, r: SessionRecord): void {
  host.close();
  host.ctx.actions.openPalette();
  const input = document.getElementById('palette-input') as HTMLInputElement | null;
  if (!input) return;
  input.value = `清理工作区 ${r.label}`.trim();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function resumeButton(host: DetailHost, r: SessionRecord): HTMLElement {
  const box = el('div', 'hist-resume');
  const c = host.check(r.id);
  if (c && !c.resumable && c.reason === 'worktree_missing' && c.canRebuildWorktree) {
    const b = btn('重建工作区并续接', 'btn white', 'history-resume', () => void resume(host, r, true));
    b.title = '工作区目录已删除、分支仍在：按原路径重建后续接';
    box.append(b);
    return box;
  }
  const b = btn('续接', 'btn white', 'history-resume', () => void resume(host, r, false));
  b.disabled = !c || !c.resumable || host.degraded();
  if (!c) b.title = '正在检查能否续接…';
  else if (!c.resumable) {
    const reason = c.reason ? BLOCK_REASON_TEXT[c.reason] : c.message;
    b.title = c.message || reason;
    const why = el('span', 'hist-why', `不可续接：${reason}`);
    why.id = 'history-resume-reason';
    box.append(b, why);
    return box;
  } else b.title = '在原目录接着这段对话继续';
  box.append(b);
  return box;
}

export function renderDetail(host: DetailHost, box: HTMLElement, r: SessionRecord | undefined): void {
  box.replaceChildren();
  if (!r) {
    box.append(el('div', 'hist-empty', '选择左侧的一条历史查看详情'));
    return;
  }
  const { ctx } = host;
  box.dataset.record = r.id;
  const head = el('div', 'hist-dhead');
  const title = el('h3', 'hist-dtitle', r.label || '未命名会话');
  title.id = 'history-detail-title';
  head.append(title);
  if (r.pinned) head.append(el('span', 'tagx hist-pin-tag', '已固定'));
  box.append(head);

  const grid = el('div', 'hist-grid');
  row(grid, '目录', r.cwd, r.cwd);
  if (r.worktree) row(grid, '分支', r.worktree.branch, r.worktree.path);
  row(grid, '开始', formatStamp(r.createdAt));
  row(grid, '结束', formatStamp(recordEndTime(r)));
  row(grid, '时长', longDuration(recordDurationMs(r)));
  row(grid, '轮数', `${r.turns} 轮`);
  row(grid, '结束状态', endKindText(r));
  box.append(grid);

  if (r.firstPrompt) box.append(promptBlock('首条提示词', r.firstPrompt, 'history-first-prompt'));
  if (r.lastPrompt && r.lastPrompt !== r.firstPrompt) box.append(promptBlock('最近一条提示词', r.lastPrompt, 'history-last-prompt'));
  if (!r.firstPrompt) box.append(el('div', 'hist-dim', '没有记录到提示词'));

  if (worktreeLeft(r)) {
    const wt = el('div', 'hist-wt');
    wt.id = 'history-wt-hint';
    wt.append(el('span', '', `关联的工作区可能仍在：${r.worktree!.path}`));
    wt.append(btn('去清理', 'btn sm', 'history-wt-clean', () => openCleanup(host, r)));
    box.append(wt);
  }

  const ops = el('div', 'hist-ops');
  ops.append(resumeButton(host, r));
  const disabled = host.degraded();
  const bNew = btn('在此目录新建', 'btn', 'history-new-here', () => { host.close(); ctx.actions.goHome(r.cwd); });
  bNew.title = `回到首页，以 ${cwdBaseName(r.cwd) || r.cwd} 为工作目录新建会话`;
  const bCopy = btn('复制首条提示词', 'btn', 'history-copy', () => {
    void navigator.clipboard?.writeText(r.firstPrompt ?? '')
      .then(() => ctx.toast('已复制首条提示词', 'success'))
      .catch(() => ctx.toast('复制失败', 'error'));
  });
  bCopy.disabled = !r.firstPrompt;
  const bTpl = btn('存为模板', 'btn', 'history-save-template', () => void saveTemplate(host, r));
  bTpl.disabled = !r.firstPrompt;
  const bPin = btn(r.pinned ? '取消固定' : '固定', 'btn', 'history-pin', () => void togglePin(host, r));
  bPin.title = '固定的记录不会被自动清理';
  bPin.disabled = disabled;
  const bDel = btn('删除', 'btn danger', 'history-delete', () => void remove(host, r));
  bDel.disabled = disabled;
  ops.append(bNew, bCopy, bTpl, bPin, bDel);
  box.append(ops);
}

async function saveTemplate(host: DetailHost, r: SessionRecord): Promise<void> {
  const { ctx } = host;
  try {
    const res = await ctx.api.templates.save({ name: templateNameOf(r), body: r.firstPrompt ?? '', description: r.cwd });
    if (res.ok) ctx.toast(`已存为模板「${res.template.name}」`, 'success');
    else ctx.toast(res.error, 'error');
  } catch (err) {
    ctx.toast(ipcErrorText(err), 'error');
  }
}

async function togglePin(host: DetailHost, r: SessionRecord): Promise<void> {
  const ok = await host.ctx.api.recordPin(r.id, !r.pinned).catch(() => false);
  if (!ok) host.ctx.toast('操作失败：记录不存在', 'error');
  host.reload();
}

async function remove(host: DetailHost, r: SessionRecord): Promise<void> {
  const { ctx } = host;
  const yes = await ctx.confirm({
    title: `删除历史「${r.label || '未命名会话'}」？`, message: deleteMessage(r), okText: '删除', danger: true,
  });
  if (!yes) return;
  const removed = await ctx.api.recordDelete([r.id]).catch(() => [] as string[]);
  if (removed.includes(r.id)) ctx.toast('已删除历史记录', 'success');
  else ctx.toast('删除失败：记录不存在或会话仍在列表中', 'error');
  host.reload();
}
