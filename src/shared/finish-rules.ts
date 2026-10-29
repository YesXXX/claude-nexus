import type { FinishStatus, GitInProgress } from './review-types';

/**
 * 收尾各步能否执行的判断：主进程执行前复查与界面按钮禁用共用这一份规则，
 * 两边给出的原因文本一致。返回 undefined 表示可以执行。
 */

export const IN_PROGRESS_TEXT: Record<GitInProgress, string> = {
  merge: '合并',
  rebase: '变基',
  'cherry-pick': '拣选',
};

export const READ_ONLY_TEXT = '此会话由其他面板实例运行，收尾操作只读';

function common(st: FinishStatus): string | undefined {
  if (st.readOnly) return READ_ONLY_TEXT;
  if (!st.branchExists) return `工作区分支 ${st.branch} 不存在（可能已在外部删除或改名）`;
  return undefined;
}

export function commitBlockReason(st: FinishStatus): string | undefined {
  const c = common(st);
  if (c) return c;
  if (st.dirty === 0) return '没有需要提交的改动';
  return undefined;
}

export function mergeBlockReason(st: FinishStatus): string | undefined {
  const c = common(st);
  if (c) return c;
  if (!st.baseIsBranch) return `基线 ${st.baseRef} 不是分支，无法合并；可在主工作区手动执行 git merge ${st.branch}`;
  if (st.ahead === 0) return '没有需要合并的提交';
  const m = st.main;
  if (!m.branch) return '主工作区未在任何分支上，请先在主工作区切换到基线分支';
  if (m.branch !== st.baseRef) {
    return `主工作区当前在 ${m.branch} 上，不在基线分支 ${st.baseRef} 上；请先在主工作区执行 git switch ${st.baseRef}`;
  }
  if (m.inProgress) return `主工作区有进行中的${IN_PROGRESS_TEXT[m.inProgress]}，请先完成或放弃`;
  if (!m.clean) return `主工作区有 ${m.dirtyCount} 个未提交改动，请先在主工作区提交或暂存`;
  if (m.busySessions.length > 0) return `主工作区里有正在运行的会话：${m.busySessions.join('、')}，请等它们这一轮结束后再合并`;
  return undefined;
}

export function pushBlockReason(st: FinishStatus, remote?: string): string | undefined {
  const c = common(st);
  if (c) return c;
  if (st.remotes.length === 0) return '没有配置远端，可在会话里执行 git remote add 添加';
  if (remote !== undefined && !st.remotes.some(r => r.name === remote)) return `远端 ${remote} 不存在`;
  if (st.ahead === 0) return '没有需要推送的提交';
  return undefined;
}

export function prBlockReason(st: FinishStatus, remote?: string): string | undefined {
  const p = pushBlockReason(st, remote);
  if (p) return p;
  if (!st.baseIsBranch) return `基线 ${st.baseRef} 不是分支，无法作为 PR 的目标`;
  return undefined;
}

/** 分支还没推送到该远端，或领先上游时，建 PR 前要先推送 */
export function needsPushBeforePr(st: FinishStatus, remote: string): boolean {
  if (!st.upstream) return true;
  if (!st.upstream.name.startsWith(`${remote}/`)) return true;
  return st.upstream.ahead > 0;
}
