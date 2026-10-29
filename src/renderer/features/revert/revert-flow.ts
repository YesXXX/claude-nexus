import type { ChangedFile, DiffMode } from '../../../shared/types';
import type { GitOpResult, RevertEntry, RevertPlan } from '../../../shared/review-types';
import type { RevertBridge } from '../../core/api.js';
import type { ConfirmOptions, ToastLevel } from '../../core/dialog-types.js';

/**
 * 撤销与恢复的交互流程：先向主进程要确认信息，弹危险样式确认框，执行后按主进程的复查结果
 * （会话刚变忙、文件刚变大、撤销后又被改过）再确认一次。界面入口（行按钮、diff 头部、右键、命令面板）都走这里。
 */

export interface FlowDeps {
  api: RevertBridge;
  toast(text: string, level?: ToastLevel): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
}

const BUSY_WARN = '⚠ Claude 正在运行，可能马上又改这个文件';

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

/** 确认框正文：口径与恢复到的提交、将执行的命令、备份说明、忙碌警告；session 为本会话视角（按改前快照恢复） */
export function planMessage(plan: RevertPlan, mode: DiffMode | undefined, session = false): string {
  const lines: string[] = [];
  if (session) {
    lines.push(plan.untracked ? '将删除该文件（本会话新建）' : '将恢复为本会话首次修改前的内容');
    if (plan.paths[0]) lines.push(`文件：${plan.paths[0]}`);
  } else if (plan.untracked) {
    lines.push('将删除该文件（未被 git 跟踪）');
  } else if (mode === 'base') {
    lines.push(`口径：相对基线 · 将恢复到基线提交 ${plan.source} 的版本`);
  } else {
    lines.push(`口径：仅未提交 · 将恢复到 HEAD 提交 ${plan.source} 的版本`);
  }
  if (plan.paths.length > 1) lines.push(`涉及两个路径：${plan.paths[0]}（新）与 ${plan.paths[1]}（原）`);
  if (!plan.untracked && !session) lines.push(`将执行：${plan.command}`);
  lines.push(plan.largeBytes > 0
    ? `文件过大（${formatBytes(plan.largeBytes)}），不备份，撤销后无法恢复`
    : '当前内容会先备份，可在撤销后「恢复」。');
  if (plan.busy) lines.push(BUSY_WARN);
  return lines.join('\n');
}

function failText(r: GitOpResult): string {
  return r.detail ? `${r.message}：${r.detail.split('\n')[0]}` : r.message;
}

/** 撤销一个文件；成功返回撤销记录，取消或失败返回 null。session 为真时 deps.api 应为本会话改动的撤销接口 */
export async function revertFile(
  deps: FlowDeps, sid: string, f: ChangedFile, mode: DiffMode | undefined, session = false,
): Promise<RevertEntry | null> {
  const plan = await deps.api.plan(sid, f.path, mode);
  if (plan.blocked) { deps.toast(plan.blocked, 'warning'); return null; }
  const ok = await deps.confirm({
    title: `撤销 ${f.path}`,
    message: planMessage(plan, mode, session),
    okText: plan.largeBytes > 0 ? '仍然撤销' : '撤销此文件',
    danger: true,
  });
  if (!ok) return null;
  const opts = { force: plan.busy, large: plan.largeBytes > 0 };
  for (let i = 0; i < 3; i++) {
    const r = await deps.api.revertFile(sid, f.path, mode, opts);
    if (r.ok) {
      deps.toast(r.message, r.entry?.restorable === false ? 'warning' : 'success');
      return r.entry ?? null;
    }
    if (r.needConfirm === 'busy' && !opts.force) {
      if (!await deps.confirm({ title: `撤销 ${f.path}`, message: `${BUSY_WARN}\n仍要撤销吗？`, okText: '仍然撤销', danger: true })) return null;
      opts.force = true;
      continue;
    }
    if (r.needConfirm === 'large' && !opts.large) {
      if (!await deps.confirm({ title: `撤销 ${f.path}`, message: r.message, okText: '仍然撤销', danger: true })) return null;
      opts.large = true;
      continue;
    }
    deps.toast(failText(r), 'error');
    return null;
  }
  return null;
}

/** 恢复一次撤销；成功返回 true */
export async function restoreEntry(deps: FlowDeps, entry: RevertEntry): Promise<boolean> {
  const name = entry.paths[0] ?? '';
  const opts = { overwrite: false, force: false };
  for (let i = 0; i < 3; i++) {
    const r = await deps.api.restore(entry.sessionId, entry.id, opts);
    if (r.ok) { deps.toast(r.message, 'success'); return true; }
    if (r.needConfirm === 'overwrite' && !opts.overwrite) {
      const files = r.detail ? `\n${r.detail}` : '';
      if (!await deps.confirm({ title: `恢复 ${name}`, message: `${r.message}${files}`, okText: '仍然恢复', danger: true })) return false;
      opts.overwrite = true;
      continue;
    }
    if (r.needConfirm === 'busy' && !opts.force) {
      if (!await deps.confirm({ title: `恢复 ${name}`, message: `${BUSY_WARN}\n仍要恢复吗？`, okText: '仍然恢复', danger: true })) return false;
      opts.force = true;
      continue;
    }
    deps.toast(failText(r), 'error');
    return false;
  }
  return false;
}
