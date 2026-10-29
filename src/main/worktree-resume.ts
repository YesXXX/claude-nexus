import * as fs from 'fs';
import { log } from './logger';
import type { RestartOptions, RestartResult, ResumeCheck, Session, SessionRecord, WorktreeInfo } from '../shared/types';

/** 续接用到的工作区操作（WorktreeManager 的子集，便于单测替换） */
export interface WorktreeOps {
  branchExists(repoRoot: string, branch: string): Promise<boolean>;
  restore(info: WorktreeInfo, owner: { sessionId: string; label: string }): Promise<void>;
}

/** 续接用到的会话管理能力（SessionManager 的子集） */
export interface ResumeHost {
  getSession(id: string): Session | undefined;
  checkResume(id: string): ResumeCheck | undefined;
  restartSession(id: string, opts: RestartOptions): RestartResult;
  /** 检查对象：列表里的会话，或按历史记录构造的会话；缺省只看列表 */
  resumeSubject?(id: string): Session | undefined;
}

export interface WorktreeResumeDeps {
  host: ResumeHost;
  worktrees?: WorktreeOps;
  /** 重建成功后清掉记录里的「工作区已删除」标记 */
  patchRecord?: (id: string, patch: Partial<SessionRecord>) => void;
}

const NOT_FOUND: ResumeCheck = { resumable: false, message: '会话不存在', transcript: 'unknown', canFresh: false, canFork: false };

/**
 * 续接前检查，工作区目录缺失时再查一次 git：主仓库与分支都在才可原地重建；
 * 否则说明原因，界面只给「在原仓库新建会话」。
 */
export async function checkResumeFull(deps: WorktreeResumeDeps, id: string): Promise<ResumeCheck> {
  const check = deps.host.checkResume(id);
  if (!check) return NOT_FOUND;
  const wt = (deps.host.resumeSubject?.(id) ?? deps.host.getSession(id))?.worktree;
  if (check.reason !== 'worktree_missing' || !wt) return check;
  if (!fs.existsSync(wt.repoRoot)) {
    return { ...check, canRebuildWorktree: false, message: `工作区与主仓库目录都已不存在：${wt.repoRoot}` };
  }
  const branchOk = deps.worktrees ? await deps.worktrees.branchExists(wt.repoRoot, wt.branch) : false;
  if (!branchOk) {
    return { ...check, canRebuildWorktree: false, message: `工作区目录已不存在，分支 ${wt.branch} 也已删除` };
  }
  return { ...check, canRebuildWorktree: true, message: `工作区目录已不存在，分支 ${wt.branch} 仍在` };
}

/**
 * 重启会话；带 rebuildWorktree 且工作区目录缺失时，先按原路径与原分支重建工作区再续接。
 * 重建失败不拉起进程，返回可直接展示的原因。
 */
export async function restartWithWorktree(deps: WorktreeResumeDeps, id: string, opts: RestartOptions): Promise<RestartResult> {
  const s = deps.host.getSession(id);
  const wt = s?.worktree;
  if (!s || !wt || !opts.rebuildWorktree || fs.existsSync(wt.path)) return deps.host.restartSession(id, opts);
  const mode = opts.mode === 'fresh' ? 'fresh' : 'resume';
  if (s.readOnly) return { ok: false, mode, reason: 'readonly', message: '这是认领的外部会话，进程结束前不能续接' };
  const check = await checkResumeFull(deps, id);
  if (!check.canRebuildWorktree || !deps.worktrees) {
    return { ok: false, mode, reason: 'worktree_missing', message: check.message };
  }
  try {
    await deps.worktrees.restore(wt, { sessionId: s.id, label: s.label });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('worktree', `会话 ${id.slice(0, 8)} 重建工作区失败：${message}`);
    return { ok: false, mode, reason: 'worktree_missing', message };
  }
  deps.patchRecord?.(id, { worktreeRemoved: undefined });
  log('worktree', `会话 ${id.slice(0, 8)} 已重建工作区 ${wt.path}，接着${mode === 'resume' ? '续接' : '全新开始'}`);
  const { rebuildWorktree: _rebuild, ...rest } = opts;
  const r = deps.host.restartSession(id, rest);
  if (r.ok) return { ...r, message: r.message ? `已重建工作区；${r.message}` : '已重建工作区' };
  return { ...r, message: `工作区已重建，但${r.message ?? '启动失败'}` };
}
