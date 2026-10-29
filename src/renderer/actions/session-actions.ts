import type { KillResult, NotificationPayload, Session, WorktreeRecord } from '../../shared/types';
import { api } from '../core/api.js';
import { ipcErrorText } from '../core/dom.js';
import { render } from '../core/render.js';
import { findSession, state } from '../core/state.js';
import { choiceDialog, confirmDialog } from '../ui/dialogs.js';
import { toast } from '../ui/toast.js';

/** 会话级操作流程：审批、结束（含工作区选择）、清理遗留工作区、打开工作区 */

/** 审批锁是否已失效：会话离开等待权限 / 会话消失 / 超 3s 兜底 */
export function isApproveLockStale(): boolean {
  const lock = state.pendingApprove;   // 先取出再读，窄化结果才能在后续表达式中保持
  if (!lock) return false;
  const ps = findSession(lock.id);
  return !ps || ps.status !== 'waiting_permission' || Date.now() - lock.at > 3000;
}

/** 发出审批决定的唯一入口：先锁定再发送，锁定期间连点/狂按一律忽略 */
export function sendApprove(id: string, choice: 'yes' | 'no' | 'always'): void {
  if (state.pendingApprove && state.pendingApprove.id === id) return;
  state.pendingApprove = { id, at: Date.now() };
  render();   // 立即渲染按钮禁用态
  setTimeout(() => { if (state.pendingApprove) render(); }, 3000);   // 主动评估超时解锁，推送丢失也有 3s 兜底
  void api().approve(id, choice).then(ok => {
    if (!ok) { state.pendingApprove = null; render(); }   // 发送失败立即解锁，可重试
  });
}

/** 结束会话：工作区会话先查未提交 / 未合并，再让用户选择删除或保留工作区；有内容会丢失时二次确认 */
export async function endSessionFlow(s: Session): Promise<void> {
  const wt = s.worktree;
  if (!wt) {
    const yes = await confirmDialog({
      title: '结束会话',
      message: `确定结束会话「${s.label}」？终端里的 Claude 进程会被终止。`,
      okText: '结束会话',
      danger: true,
    });
    if (yes) await api().kill(s.id);
    return;
  }

  const st = await api().worktreeStatus(s.id).catch(() => null);
  const dirty = st?.dirtyFiles ?? 0;
  const commits = st?.unmergedCommits ?? 0;
  const facts: string[] = [];
  if (dirty > 0) facts.push(`${dirty} 个未提交文件`);
  if (commits > 0) facts.push(`${commits} 个提交未合并到 ${wt.baseRef}`);
  const lines = [
    `工作区 ${wt.path}（分支 ${wt.branch}）`,
    st ? (facts.length > 0 ? `有 ${facts.join('，')}。` : '工作区干净，没有未提交或未合并的内容。') : '无法读取工作区状态。',
  ];
  const choice = await choiceDialog({
    title: `结束会话「${s.label}」`,
    message: lines.join('\n'),
    danger: true,
    choices: [
      { value: 'remove', text: '结束并删除工作区', style: 'danger' },
      { value: 'keep', text: '结束并保留工作区', style: 'primary' },
    ],
  });
  if (!choice) return;
  if (choice === 'keep') {
    await api().kill(s.id, { keepWorktree: true });
    toast(`工作区已保留：${wt.branch}，可在命令面板中清理`, 'info');
    return;
  }
  let force = false;
  if (dirty > 0 || commits > 0) {
    const yes = await confirmDialog({
      title: '确认删除工作区',
      message: `将永久丢失 ${facts.join('和')}，确定删除？`,
      okText: '永久删除',
      danger: true,
    });
    if (!yes) return;
    force = true;
  }
  const r = await api().kill(s.id, { force }).catch(err => ({ ok: false, message: ipcErrorText(err) } as KillResult));
  toast(r.message ?? `已删除工作区 ${wt.branch}`, killResultLevel(r));
}

export function killResultLevel(r: KillResult): NotificationPayload['level'] {
  if (!r.ok) return 'error';
  return r.kept ? 'warning' : 'success';
}

/**
 * 命令面板清理遗留工作区：流程与结束会话相同（查状态、有内容会丢失时二次确认）。
 * 返回是否已删除，调用方据此更新自己的遗留工作区缓存。
 */
export async function cleanupWorktreeFlow(rec: WorktreeRecord): Promise<boolean> {
  const yes = await confirmDialog({
    title: '清理工作区',
    message: `删除工作区 ${rec.path}（分支 ${rec.branch}）？\n干净的工作区直接删除；有未提交内容或未合并提交时会再次确认。`,
    okText: '删除',
    danger: true,
  });
  if (!yes) return false;
  let r = await api().removeWorktree(rec.path, false);
  if (r.kept === 'error') {
    const force = await confirmDialog({
      title: '确认删除工作区',
      message: '工作区有未提交的改动，普通删除被 git 拒绝。\n强制删除将永久丢失这些内容，且分支上未合并的提交也会一并删除，确定继续？',
      okText: '永久删除',
      danger: true,
    });
    if (!force) return false;
    r = await api().removeWorktree(rec.path, true);
  }
  toast(r.message ?? (r.ok ? `已删除工作区 ${rec.branch}` : '删除失败'), killResultLevel(r));
  return r.ok;
}

/** 在资源管理器中打开会话的工作区目录，失败给出提示 */
export async function openWorktreeOf(id: string): Promise<void> {
  const err = await api().openWorktree(id).catch(e => ipcErrorText(e));
  if (err) toast(`打开失败：${err}`, 'error');
}
