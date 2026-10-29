import { cwdBaseName } from '../../../shared/session-view.js';
import type { ResumeBlockReason, ResumeCheck, SessionRecord } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import { el } from '../../core/dom.js';
import { findOpener, type PaletteItem } from '../../core/registry.js';
import { inFlightMode, runResumeAction, type ResumeActionOptions } from './resume-actions.js';

/**
 * 历史入口：首页「最近结束」（最多 5 条）与命令面板「历史」分组（最多 10 条）。
 * 数据来自已结束的会话记录，按结束时间倒序；每条都做一次续接检查，不可续接的显示原因并置灰。
 * 工作区目录缺失但分支仍在的，入口改为「重建并续接」。
 */

const RECENT_MAX = 5;
const PALETTE_MAX = 10;
/** 历史面板（由其他功能注册）的打开入口 id；没注册时不显示「全部历史」 */
export const HISTORY_PANEL_OPENER = 'history.panel';

interface Entry {
  rec: SessionRecord;
  check?: ResumeCheck;
}

let ctxRef: AppContext;
let recent: Entry[] = [];
let palette: Entry[] = [];
/** 续接检查缓存：键为记录 id 与更新时间，记录变化后重新检查 */
const checks = new Map<string, ResumeCheck>();
let loadSeq = 0;

const REASON_SHORT: Record<ResumeBlockReason, string> = {
  no_id: '没有对话 id',
  no_transcript: '对话记录缺失',
  cwd_missing: '目录已不存在',
  worktree_missing: '工作区已删除',
  in_use: '对话正在别的会话中运行',
  busy: '进程仍在运行',
  readonly: '只读会话',
};

export function installHistory(ctx: AppContext): void {
  ctxRef = ctx;
  ctx.registry.registerCommands({ id: 'resume.history', order: 520, items: paletteItems, refresh: refreshPalette });
  ctx.api.onRecordsChanged(() => { void loadRecent(); });
  void loadRecent();
}

const keyOf = (r: SessionRecord): string => `${r.id}|${r.updatedAt}`;

async function withChecks(recs: SessionRecord[], force: boolean): Promise<Entry[]> {
  return Promise.all(recs.map(async rec => {
    const key = keyOf(rec);
    let check = force ? undefined : checks.get(key);
    if (!check) {
      check = await ctxRef.api.resumeCheck(rec.id).catch(() => undefined);
      if (check) checks.set(key, check);
    }
    return { rec, check };
  }));
}

/** 只保留当前用得到的检查缓存 */
function pruneCache(): void {
  const keep = new Set([...recent, ...palette].map(e => keyOf(e.rec)));
  for (const k of [...checks.keys()]) if (!keep.has(k)) checks.delete(k);
}

async function loadRecent(): Promise<void> {
  const seq = ++loadSeq;
  try {
    const page = await ctxRef.api.recordsList({ states: ['ended'], sort: 'ended', limit: RECENT_MAX });
    const entries = await withChecks(page.items, false);
    if (seq !== loadSeq) return;
    recent = entries;
    pruneCache();
    renderRecent();
  } catch (err) {
    console.error('[history] 读取最近结束失败：', err);
  }
}

async function refreshPalette(): Promise<boolean> {
  const page = await ctxRef.api.recordsList({ states: ['ended'], sort: 'ended', limit: PALETTE_MAX });
  const entries = await withChecks(page.items, true);
  const before = JSON.stringify(palette.map(e => [keyOf(e.rec), e.check]));
  palette = entries;
  pruneCache();
  return JSON.stringify(palette.map(e => [keyOf(e.rec), e.check])) !== before;
}

/** 条目的可用动作：可续接、可重建工作区后续接，或给出不可续接的原因 */
function actionOf(e: Entry): { run?: () => Promise<boolean>; text: string; reason?: string } {
  const c = e.check;
  if (!c) return { text: '续接', reason: '检查中…' };
  if (c.resumable) {
    return { text: '续接', run: () => runResumeAction(e.rec.id, 'resume') };
  }
  if (c.reason === 'worktree_missing' && c.canRebuildWorktree) {
    const opts: ResumeActionOptions = { rebuildWorktree: true };
    return { text: '重建并续接', run: () => runResumeAction(e.rec.id, 'resume', opts) };
  }
  return { text: '续接', reason: c.reason ? REASON_SHORT[c.reason] : c.message };
}

/** 刚刚 / N 分钟前 / N 小时前 / 昨天 / 月-日 */
export function relativeTime(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const d = new Date(ts);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (ts >= today.getTime()) return `${Math.floor(min / 60)} 小时前`;
  if (ts >= today.getTime() - 24 * 60 * 60 * 1000) return '昨天';
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

function endTime(r: SessionRecord): number {
  return r.endedAt ?? r.updatedAt;
}

function renderRecent(): void {
  const box = document.getElementById('recent-ended');
  if (!box) return;
  box.innerHTML = '';
  box.hidden = recent.length === 0;
  if (recent.length === 0) return;
  box.appendChild(el('div', 're-title', '最近结束'));
  for (const e of recent) box.appendChild(recentRow(e));
  const opener = findOpener(HISTORY_PANEL_OPENER);
  if (opener) {
    const more = el('button', 're-more', '全部历史 →') as HTMLButtonElement;
    more.type = 'button';
    more.addEventListener('click', () => opener.open());
    box.appendChild(more);
  }
}

function recentRow(e: Entry): HTMLElement {
  const { rec } = e;
  const row = el('div', 're-item');
  row.dataset.record = rec.id;
  const name = el('span', 're-label', rec.label || '未命名会话');
  name.title = rec.label;
  const dir = el('span', 're-cwd', rec.worktree ? `${rec.cwd}（工作区）` : rec.cwd);
  dir.title = rec.cwd;
  row.append(name, dir, el('span', 're-time', relativeTime(endTime(rec))));
  const act = actionOf(e);
  if (act.run) {
    const busy = Boolean(inFlightMode(rec.id));
    const b = el('button', 'btn re-resume', busy ? '正在续接…' : act.text) as HTMLButtonElement;
    b.type = 'button';
    b.disabled = busy;
    if (e.check) b.title = e.check.message;
    const run = act.run;
    b.addEventListener('click', () => {
      b.disabled = true;
      b.textContent = '正在续接…';
      // 成功后记录转为进行中，随变化通知从列表消失；失败恢复按钮
      void run().then(ok => {
        if (ok) return;
        b.disabled = false;
        b.textContent = act.text;
      });
    });
    row.appendChild(b);
  } else {
    const why = el('span', 're-reason', act.reason ?? '');
    if (e.check) why.title = e.check.message;
    row.appendChild(why);
  }
  return row;
}

function paletteItems(): PaletteItem[] {
  return palette.map(e => {
    const act = actionOf(e);
    const when = relativeTime(endTime(e.rec));
    return {
      section: '历史' as const,
      icon: '↻',
      title: `${act.text}「${e.rec.label || '未命名会话'}」`,
      sub: cwdBaseName(e.rec.cwd) || e.rec.cwd,
      hint: act.reason ?? when,
      keywords: `history lishi xujie ${e.rec.cwd} ${e.rec.worktree?.branch ?? ''}`,
      disabled: !act.run,
      run: () => { void act.run?.(); },
    };
  });
}
