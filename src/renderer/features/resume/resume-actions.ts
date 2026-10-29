import type { RecordResumeMode, RecordResumeResult, ResumeCheck, Session } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { on } from '../../core/events.js';

/**
 * 续接动作与续接检查缓存。
 * 检查结果按会话的状态快照做键：状态、Claude 会话 id、进入状态时间或续接失败时间任一变化即重新检查，
 * 渲染时只读缓存，未命中时后台拉取，到达后按帧重绘。
 */

export type ResumeMode = RecordResumeMode;

interface CheckEntry {
  key: string;
  check?: ResumeCheck;
  pending: boolean;
}

let ctxRef: AppContext | null = null;
const checks = new Map<string, CheckEntry>();
/** 正在续接或全新开始的会话：按钮显示进行中并禁用，防止连点 */
const inFlight = new Map<string, ResumeMode>();

export function bindResumeContext(ctx: AppContext): void {
  ctxRef = ctx;
}

function ctx(): AppContext {
  if (!ctxRef) throw new Error('续接模块尚未安装');
  return ctxRef;
}

function checkKey(s: Session): string {
  // exitCode 在进程退出时写入：Stop 后状态已是已完成、进程随后才退出时，靠它让缓存失效
  return [s.status, s.claudeSessionId ?? '', s.statusSince, s.resumeFailure?.at ?? 0, String(s.exitCode)].join('|');
}

/** 读缓存的检查结果；键过期或没有时后台拉取，到达后重绘。旧结果在新结果到达前继续使用，避免按钮闪烁 */
export function cachedCheck(s: Session): ResumeCheck | undefined {
  const key = checkKey(s);
  const entry = checks.get(s.id);
  if (entry && entry.key === key) return entry.check;
  const next: CheckEntry = { key, check: entry?.check, pending: true };
  checks.set(s.id, next);
  void ctx().api.resumeCheck(s.id).then(check => {
    const cur = checks.get(s.id);
    if (cur !== next) return;
    cur.check = check;
    cur.pending = false;
    ctx().requestRender();
  }).catch(() => {
    const cur = checks.get(s.id);
    if (cur === next) cur.pending = false;
  });
  return next.check;
}

/** 立即拉取一次检查结果并写入缓存，返回是否与原缓存不同 */
export async function fetchCheck(s: Session): Promise<boolean> {
  const check = await ctx().api.resumeCheck(s.id);
  const prev = checks.get(s.id)?.check;
  checks.set(s.id, { key: checkKey(s), check, pending: false });
  return JSON.stringify(prev) !== JSON.stringify(check);
}

/** 当前会话的检查结果，只读缓存，不触发拉取 */
export function peekCheck(id: string): ResumeCheck | undefined {
  return checks.get(id)?.check;
}

export function inFlightMode(id: string): ResumeMode | undefined {
  return inFlight.get(id);
}

/** 会话被移除后丢掉它的缓存 */
export function pruneChecks(liveIds: Set<string>): void {
  for (const id of [...checks.keys()]) if (!liveIds.has(id)) checks.delete(id);
}

export interface ResumeActionOptions {
  /** 进程仍存活时先结束再拉起 */
  force?: boolean;
  /** 工作区目录缺失、分支仍在时先按原路径重建工作区 */
  rebuildWorktree?: boolean;
}

const OK_TEXT: Record<ResumeMode, string> = {
  resume: '已续接对话',
  fresh: '已全新开始',
  fork: '已分叉为新会话',
};

/**
 * 对会话执行续接、全新开始或分叉。列表里的会话走重启；不在列表里的（历史记录）与分叉走历史接口，
 * 续接与全新开始沿用原面板会话 id，分叉得到新会话。成功后切到目标会话的终端并聚焦输入；
 * 失败按主进程给的原因提示。主进程附带说明（重建了工作区、改在工作区根目录启动）时一并提示。返回是否成功。
 */
export async function runResumeAction(id: string, mode: ResumeMode, opts: ResumeActionOptions = {}): Promise<boolean> {
  const c = ctx();
  if (inFlight.has(id)) return false;
  inFlight.set(id, mode);
  c.render();
  try {
    const inList = c.state.sessions.some(s => s.id === id);
    const rebuild = opts.rebuildWorktree ? { rebuildWorktree: true } : {};
    const call: Promise<RecordResumeResult> = mode === 'fork' || !inList
      ? c.api.recordResume(id, { mode, ...rebuild })
      : c.api.restart(id, { mode, ...(opts.force ? { force: true } : {}), ...rebuild });
    const r = await call.catch((err): RecordResumeResult => ({ ok: false, message: ipcErrorText(err) }));
    checks.delete(id);
    if (!r.ok) {
      c.toast(r.message ?? '操作失败', 'error');
      return false;
    }
    const target = r.sessionId ?? id;
    await ensureListed(target);
    c.toast(r.message ? `${OK_TEXT[mode]}（${r.message}）` : OK_TEXT[mode], 'success');
    c.actions.showTerminalTab(target);
    c.actions.selectSession(target);
    c.actions.focusSessionInput(target);
    return true;
  } finally {
    inFlight.delete(id);
    c.render();
  }
}

/** 新拉起的会话还没随推送进入本地列表时等下一次推送（最多 2 秒），保证选中后详情区能找到它 */
function ensureListed(id: string): Promise<void> {
  const c = ctx();
  if (c.state.sessions.some(s => s.id === id)) return Promise.resolve();
  return new Promise(resolve => {
    let off: () => void = () => undefined;
    const timer = setTimeout(() => { off(); resolve(); }, 2000);
    off = on('sessions-updated', () => {
      if (!c.state.sessions.some(s => s.id === id)) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

/** 终端里手动续接的命令：cmd 下先切目录再续接 */
export function resumeCommandText(s: Session): string | null {
  if (!s.claudeSessionId) return null;
  return `cd /d "${s.cwd}" && claude --resume ${s.claudeSessionId}`;
}

/** 进程已结束、可能需要续接的状态（含跨重启保留的待续接行） */
export const ENDED_STATUSES: ReadonlySet<Session['status']> = new Set(['completed', 'error', 'disconnected', 'suspended']);

export const FAILURE_TEXT: Record<NonNullable<Session['resumeFailure']>['reason'], string> = {
  no_transcript: 'CLI 找不到这段对话',
  exited_early: '续接后进程立即退出',
};

/** 续接相关按钮：primary 用白色主按钮样式 */
export function button(text: string, primary: boolean, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = el('button', primary ? 'btn white' : 'btn', text);
  b.type = 'button';
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

/** 分叉为新会话：同一段对话被别的会话占用时的出路 */
export function forkButton(id: string): HTMLButtonElement {
  const busy = inFlight.get(id);
  const b = button(busy === 'fork' ? '正在分叉…' : '分叉为新会话', false, () => { void runResumeAction(id, 'fork'); }, Boolean(busy));
  b.classList.add('resume-fork');
  b.title = '带着这段对话另开一个会话，原会话不受影响';
  return b;
}

/** 工作区目录缺失时的按钮：分支还在就原地重建并续接；否则跳到首页、预填主仓库路径新建会话 */
export function worktreeMissingButtons(s: Session, check: ResumeCheck): HTMLButtonElement[] {
  const busy = inFlight.get(s.id);
  if (check.canRebuildWorktree) {
    const b = button(busy ? '正在重建…' : '重建工作区并续接', true,
      () => { void runResumeAction(s.id, 'resume', { rebuildWorktree: true }); }, Boolean(busy));
    b.classList.add('wt-rebuild');
    return [b];
  }
  const repo = s.worktree?.repoRoot;
  if (!repo) return [];
  const b = button('在原仓库新建会话', true, () => ctx().actions.goHome(repo));
  b.classList.add('wt-new-in-repo');
  b.title = repo;
  return [b];
}
