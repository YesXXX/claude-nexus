import type { RestoreBatchResult, RestorePrompt, ResumeSettings } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText, queryEl } from '../../core/dom.js';
import { on } from '../../core/events.js';
import type { PaletteItem } from '../../core/registry.js';
import { archiveSession } from './dormant-card.js';
import { button } from './resume-actions.js';

/**
 * 启动恢复的界面：询问档的侧栏横幅、批量续接进度、自动续接结果提示，
 * 以及命令面板里的全部续接、归档已结束会话与两项续接设置。
 */

let ctxRef: AppContext;
/** 批量续接进度的当前接收者；主进程的进度推送只注册一次，按这里分发 */
let progressSink: ((done: number, total: number) => void) | null = null;
let settings: ResumeSettings | null = null;
let restoring = false;

export function installRestoreUi(ctx: AppContext): void {
  ctxRef = ctx;
  ctx.api.onRestoreProgress((done, total) => progressSink?.(done, total));
  ctx.api.onRestoreResult(r => { if (r.auto) toastResult(r, true); });
  void mountRestoreBanner();
  void refreshSettings();
}

/** 批量续接结果提示；有失败时点击提示跳到第一个失败的会话 */
function toastResult(r: RestoreBatchResult, auto: boolean): void {
  const ok = r.started.length;
  const bad = r.failed.length;
  if (ok === 0 && bad === 0) return;
  if (bad === 0) {
    ctxRef.toast(`已续接 ${ok} 个会话`, 'success');
    return;
  }
  const first = r.failed[0].id;
  const head = ok > 0 ? `已续接 ${ok} 个会话，${bad} 个续接失败` : `${bad} 个会话续接失败`;
  ctxRef.toast(`${head}（点击查看）`, auto ? 'warning' : 'error', () => ctxRef.actions.selectSession(first));
}

/** 全部续接：横幅或命令面板发起，进度交给 onProgress */
export async function restoreAll(onProgress?: (done: number, total: number) => void): Promise<void> {
  if (restoring) return;
  restoring = true;
  progressSink = onProgress ?? null;
  try {
    const r = await ctxRef.api.restore('all');
    toastResult(r, false);
  } catch (err) {
    ctxRef.toast(`续接失败：${ipcErrorText(err)}`, 'error');
  } finally {
    restoring = false;
    progressSink = null;
  }
}

function suspendedIds(): string[] {
  return ctxRef.state.sessions.filter(s => s.status === 'suspended' && !s.readOnly).map(s => s.id);
}

function exitedDormantIds(): string[] {
  return ctxRef.state.sessions
    .filter(s => s.dormant && !s.readOnly && s.status !== 'suspended')
    .map(s => s.id);
}

/** 逐个归档，返回成功数 */
async function archiveAll(ids: string[]): Promise<number> {
  let n = 0;
  for (const id of ids) if (await archiveSession(id)) n++;
  return n;
}

// ================= 询问档横幅 =================

async function mountRestoreBanner(): Promise<void> {
  const prompt: RestorePrompt | null = await ctxRef.api.restorePrompt().catch(() => null);
  const list = queryEl('session-list');
  if (!prompt || !list) return;
  const banner = el('div', 'restore-banner');
  banner.id = 'restore-banner';
  banner.setAttribute('role', 'status');
  list.before(banner);

  const off = on('sessions-updated', ({ sessions }) => {
    if (restoring) return;
    const left = sessions.filter(s => s.status === 'suspended' && prompt.ids.includes(s.id)).length;
    if (left === 0) close();
  });
  function close(): void {
    off();
    banner.remove();
  }

  const text = el('div', 'rb-text');
  const acts = el('div', 'rb-acts');
  const count = prompt.ids.length;
  text.textContent = prompt.reason === 'crash'
    ? `面板上次异常退出，${count} 个会话待续接`
    : `上次保留了 ${count} 个会话`;
  const all = button('全部续接', true, () => {
    for (const b of acts.querySelectorAll('button')) b.disabled = true;
    text.textContent = `正在续接 0/${count}`;
    void restoreAll((done, total) => { text.textContent = `正在续接 ${done}/${total}`; }).then(close);
  });
  all.classList.add('rb-all');
  const archive = button('全部归档', false, () => { void confirmArchive(suspendedIds(), '待续接').then(n => { if (n > 0) close(); }); });
  archive.classList.add('rb-archive');
  const later = button('稍后', false, close);
  later.classList.add('rb-later');
  for (const b of [all, archive, later]) b.classList.add('sm');
  acts.append(all, archive, later);
  banner.append(text, acts);
}

async function confirmArchive(ids: string[], what: string): Promise<number> {
  if (ids.length === 0) return 0;
  const ok = await ctxRef.confirm({
    title: '归档会话',
    message: `把 ${ids.length} 个${what}会话转入历史？之后仍可从历史续接，独立工作区会保留。`,
    okText: '归档',
  });
  if (!ok) return 0;
  const n = await archiveAll(ids);
  if (n > 0) ctxRef.toast(`已归档 ${n} 个会话`, 'success');
  return n;
}

// ================= 命令面板 =================

async function refreshSettings(): Promise<boolean> {
  const next = await ctxRef.api.resumeSettingsGet();
  const changed = JSON.stringify(next) !== JSON.stringify(settings);
  settings = next;
  return changed;
}

async function saveSetting(patch: Partial<ResumeSettings>, text: string): Promise<void> {
  try {
    settings = await ctxRef.api.resumeSettingsSet(patch);
    ctxRef.toast(text, 'success');
  } catch (err) {
    ctxRef.toast(`保存设置失败：${ipcErrorText(err)}`, 'error');
  }
}

export const STARTUP_OPTS: Array<[ResumeSettings['onStartup'], string, string]> = [
  ['auto', '自动续接', 'auto zidong'],
  ['ask', '询问', 'ask xunwen'],
  ['never', '不恢复', 'never buhuifu'],
];
export const QUIT_OPTS: Array<[ResumeSettings['onQuit'], string, string]> = [
  ['ask', '询问', 'ask xunwen'],
  ['keep', '保留会话', 'keep baoliu'],
  ['end', '结束会话', 'end jieshu'],
];

export function restorePaletteItems(): PaletteItem[] {
  const out: PaletteItem[] = [];
  const suspended = suspendedIds();
  if (suspended.length > 0) {
    out.push({
      section: '命令', icon: '↻', title: '全部续接', sub: `${suspended.length} 个待续接会话`,
      hint: '逐个续接待续接分组里的会话',
      keywords: 'restore all resume quanbu xujie',
      run: () => { void restoreAll(); },
    });
  }
  const exited = exitedDormantIds();
  if (exited.length > 0) {
    out.push({
      section: '命令', icon: '⌫', title: '归档全部已结束会话', sub: `${exited.length} 个会话`,
      hint: '把上次保留下来的已结束会话转入历史',
      keywords: 'archive ended guidang jieshu',
      run: () => { void confirmArchive(exitedDormantIds(), '已结束的'); },
    });
  }
  const cur = settings;
  for (const [value, label, kw] of STARTUP_OPTS) {
    const isOn = cur?.onStartup === value;
    out.push({
      section: '命令', icon: isOn ? '✓' : '·', title: `启动时恢复：${label}`, sub: isOn ? '当前设置' : undefined,
      keywords: `startup restore qidong huifu ${kw}`,
      run: () => { void saveSetting({ onStartup: value }, `启动时恢复已设为「${label}」`); },
    });
  }
  for (const [value, label, kw] of QUIT_OPTS) {
    const isOn = cur?.onQuit === value;
    out.push({
      section: '命令', icon: isOn ? '✓' : '·', title: `退出时：${label}`, sub: isOn ? '当前设置' : undefined,
      keywords: `quit exit tuichu ${kw}`,
      run: () => { void saveSetting({ onQuit: value }, `退出时已设为「${label}」`); },
    });
  }
  return out;
}

export function refreshRestorePalette(): Promise<boolean> {
  return refreshSettings().catch(() => false);
}
