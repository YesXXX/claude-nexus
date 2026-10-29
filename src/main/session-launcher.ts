import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { log } from './logger';
import type { KillResult, Session, WorktreeInfo } from '../shared/types';

/** 渲染层传入的提示词上限：超过这个长度的粘贴在 TUI 里也难以审阅 */
export const PROMPT_INPUT_MAX = 100_000;

export interface LaunchInput {
  label: string;
  cwd: string;
  /** 为真时先建独立工作区，再在工作区里拉起会话 */
  worktree?: boolean;
  branch?: string;
  baseRef?: string;
  /** 首条提示词：不走命令行参数，交给发件箱等 Claude 就绪后粘贴 */
  initialPrompt?: string;
  /** 批量派发时所属的批次，写入会话元数据 */
  batchId?: string;
}

/** 启动会话所需的最小依赖，便于单测替换 */
export interface LaunchDeps {
  manager: {
    createSession(input: { label: string; cwd: string; id?: string; worktree?: WorktreeInfo; batchId?: string }): Session;
    getSession(id: string): Session | undefined;
  };
  worktrees?: {
    create(input: { sessionId: string; label: string; cwd: string; branch?: string; baseRef?: string }):
      Promise<{ info: WorktreeInfo; cwd: string }>;
    remove(info: WorktreeInfo, force: boolean): Promise<unknown>;
  };
  changes?: { refresh(id: string): Promise<unknown> | unknown };
  prompts?: { deliver(id: string, text: string): void };
  /** 测试注入固定 id */
  uuid?: () => string;
}

/** 校验并规整渲染层传入的创建参数；不合法时抛出给用户看的中文错误 */
export function normalizeLaunch(label: unknown, cwd: unknown, opts?: Partial<Record<keyof LaunchInput, unknown>>): LaunchInput {
  if (typeof label !== 'string' || !label.trim()) throw new Error('任务标签不能为空');
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('工作目录不能为空');
  const dir = cwd.trim();
  if (!fs.existsSync(dir)) throw new Error(`工作目录不存在：${dir}`);
  const prompt = typeof opts?.initialPrompt === 'string' ? opts.initialPrompt.trim() : '';
  if (prompt.length > PROMPT_INPUT_MAX) throw new Error(`首条提示词过长（上限 ${PROMPT_INPUT_MAX} 字）`);
  const input: LaunchInput = { label: label.trim(), cwd: dir };
  if (prompt) input.initialPrompt = prompt;
  if (opts?.worktree) {
    input.worktree = true;
    if (typeof opts.branch === 'string') input.branch = opts.branch;
    if (typeof opts.baseRef === 'string') input.baseRef = opts.baseRef;
  }
  return input;
}

/**
 * 新会话先统计一次改动基线（列表徽标不必等到第一次工具调用），
 * 带首条提示词的交给发件箱等就绪后发送；排队失败只记日志，会话照常可用。
 */
function afterCreate(deps: LaunchDeps, s: Session, prompt: string): Session {
  void deps.changes?.refresh(s.id);
  if (!prompt || !deps.prompts) return s;
  try {
    deps.prompts.deliver(s.id, prompt);
  } catch (err) {
    log('outbox', `会话 ${s.id.slice(0, 8)} 首条提示词排队失败：${String(err)}`);
  }
  return deps.manager.getSession(s.id) ?? s;
}

/**
 * 拉起一个会话。独立工作区模式先建工作区再拉起；会话起不来就把刚建的工作区一并撤掉
 * （强制删除，不留孤立目录和分支），再把原错误抛给调用方。
 */
export async function launchSession(deps: LaunchDeps, input: LaunchInput): Promise<Session> {
  const prompt = input.initialPrompt ?? '';
  const batch = input.batchId ? { batchId: input.batchId } : {};
  if (!input.worktree) {
    return afterCreate(deps, deps.manager.createSession({ label: input.label, cwd: input.cwd, ...batch }), prompt);
  }

  const { worktrees } = deps;
  if (!worktrees) throw new Error('独立工作区不可用');
  const id = (deps.uuid ?? randomUUID)();
  const { info, cwd } = await worktrees.create({
    sessionId: id, label: input.label, cwd: input.cwd, branch: input.branch, baseRef: input.baseRef,
  });
  let s: Session;
  try {
    s = deps.manager.createSession({ id, label: input.label, cwd, worktree: info, ...batch });
  } catch (err) {
    log('worktree', `会话创建失败，回滚工作区 ${info.path}：${String(err)}`);
    await worktrees.remove(info, true);
    throw err;
  }
  return afterCreate(deps, s, prompt);
}

export interface EndDeps {
  manager: {
    getSession(id: string): Session | undefined;
    killSession(id: string): void;
    killSessionAndWait(id: string): Promise<unknown>;
  };
  worktrees?: { remove(info: WorktreeInfo, force: boolean): Promise<KillResult> };
  changes?: { forget(id: string): void };
  /** 本会话改动：只丢内存状态，磁盘上的改动集随会话记录删除 */
  sessionChanges?: { forget(id: string): void };
  usage?: { forget(id: string): void };
  records?: { patch(id: string, patch: { worktreeRemoved: boolean }): unknown };
}

export interface EndOptions { force?: boolean; keepWorktree?: boolean }

/**
 * 结束会话：普通会话直接结束；工作区会话默认等进程退出后删除工作区（keepWorktree 则保留，留待命令面板清理）。
 * 目录已删（分支因未合并而保留也算目录已删）时在记录里标记，之后续接需要先重建工作区。
 */
export async function endSession(deps: EndDeps, id: string, opts: EndOptions = {}): Promise<KillResult> {
  const { manager, worktrees } = deps;
  const wt = manager.getSession(id)?.worktree;
  deps.changes?.forget(id);
  deps.sessionChanges?.forget(id);
  deps.usage?.forget(id);
  if (!wt || !worktrees || opts.keepWorktree) {
    manager.killSession(id);
    return { ok: true };
  }
  await manager.killSessionAndWait(id);
  const r = await worktrees.remove(wt, !!opts.force);
  if (r.ok && (r.kept === undefined || r.kept === 'unmerged')) deps.records?.patch(id, { worktreeRemoved: true });
  return r;
}
