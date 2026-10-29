import { log } from './logger';
import type { SessionManager } from './session-manager';
import type { SessionRecordStore } from './session-record-store';
import { checkResumeFull, restartWithWorktree, type WorktreeResumeDeps } from './worktree-resume';
import type { RecordResumeMode, RecordResumeOptions, RecordResumeResult } from '../shared/types';

/**
 * 历史记录上的动作：从历史续接 / 全新开始 / 分叉、改名、删除。
 * 续接与全新开始沿用原面板会话 id：记录不在列表里时先放回列表成为无进程行，再按普通重启拉起，
 * 拉起失败则撤回该行，记录保持已结束。分叉另建一个面板会话，原会话与原记录不受影响。
 */

export interface RecordActionDeps {
  manager: SessionManager;
  records?: SessionRecordStore;
  resume: WorktreeResumeDeps;
}

/** 标签长度上限，与新建表单一致 */
const LABEL_MAX = 100;
const FORK_SUFFIX = '（分叉）';

/** 渲染层传入的历史拉起选项：未知 mode 按续接处理，布尔开关只认 true */
export function asRecordResumeOptions(v: unknown): RecordResumeOptions {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const mode: RecordResumeMode = o.mode === 'fresh' || o.mode === 'fork' ? o.mode : 'resume';
  return o.rebuildWorktree === true ? { mode, rebuildWorktree: true } : { mode };
}

export function forkLabel(label: string): string {
  return label.endsWith(FORK_SUFFIX) ? label : `${label}${FORK_SUFFIX}`;
}

export async function resumeRecord(deps: RecordActionDeps, id: string, opts: RecordResumeOptions): Promise<RecordResumeResult> {
  const { manager } = deps;
  const mode = opts.mode;
  if (!manager.resumeSubject(id)) return { ok: false, mode, reason: 'not_found', message: '会话不存在' };
  if (mode === 'fork') return forkRecord(deps, id);
  const revived = !manager.getSession(id);
  if (revived) {
    manager.reviveRecord(id);
    log('session', `从历史拉起会话 ${id.slice(0, 8)}（${mode === 'resume' ? '续接' : '全新开始'}）`);
  }
  const r = await restartWithWorktree(deps.resume, id, opts.rebuildWorktree ? { mode, rebuildWorktree: true } : { mode });
  if (!r.ok) {
    if (revived) manager.removeDormant(id);
    return r;
  }
  return { ...r, sessionId: id };
}

/** 分叉为新会话：要求对话记录存在且 CLI 支持 --fork-session；新会话在原目录启动，不接管原会话的工作区 */
async function forkRecord(deps: RecordActionDeps, id: string): Promise<RecordResumeResult> {
  const { manager } = deps;
  const subject = manager.resumeSubject(id)!;
  const check = await checkResumeFull(deps.resume, id);
  const claudeId = subject.claudeSessionId;
  if (!check.canFork || !claudeId) {
    const message = check.resumable || check.reason === 'busy'
      ? '这段对话不能分叉：需要对话记录存在且当前 claude 支持 --fork-session'
      : check.message;
    return { ok: false, mode: 'fork', reason: check.reason, message };
  }
  try {
    const s = manager.createSession({
      label: forkLabel(subject.label),
      cwd: check.cwdFallback ?? subject.cwd,
      launch: subject.launch,
      resumeFrom: { claudeSessionId: claudeId, fork: true, recordId: id },
    });
    return { ok: true, mode: 'fork', sessionId: s.id };
  } catch (err) {
    const message = `启动 claude 失败：${err instanceof Error ? err.message : String(err)}`;
    log('session', `会话 ${id.slice(0, 8)} 分叉失败：${message}`);
    return { ok: false, mode: 'fork', reason: 'spawn_failed', message };
  }
}

/** 改标签：会话在列表里时连同会话一起改；空标签或记录不存在返回 false */
export function renameRecord(deps: RecordActionDeps, id: unknown, label: unknown): boolean {
  if (typeof id !== 'string' || typeof label !== 'string') return false;
  const next = label.trim().slice(0, LABEL_MAX);
  if (!next) return false;
  if (deps.manager.getSession(id)) return deps.manager.renameSession(id, next);
  return deps.records?.patch(id, { label: next }) !== undefined;
}

/** 删除历史记录：只删已结束且不在列表里的，返回实际删掉的 id */
export function deleteRecords(deps: RecordActionDeps, ids: unknown): string[] {
  if (!deps.records || !Array.isArray(ids)) return [];
  const list = ids.filter((x): x is string => typeof x === 'string' && !deps.manager.getSession(x));
  return deps.records.remove(list);
}
