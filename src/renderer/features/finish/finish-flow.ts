import type { Session } from '../../../shared/types';
import type { FinishStatus, GitOpResult, SendResult } from '../../../shared/review-types';
import { ghCreateCommand, quoteArg } from '../../../shared/remote-url.js';
import type { FinishBridge } from '../../core/api.js';
import type { ChoiceOptions, ConfirmOptions, ToastLevel } from '../../core/dialog-types.js';
import { ipcErrorText } from '../../core/dom.js';

/**
 * 收尾各步的交互流程：执行前弹确认框列出工作目录与完整命令，执行后按主进程的复查结果
 * （会话刚变忙）再确认一次并带 force 重试；合并冲突时让用户选择开解决冲突的会话、放弃合并或稍后处理。
 * 界面入口（收尾页按钮、命令面板）都走这里，返回主进程的结果供页面刷新与记录。
 */

export interface FinishFlowDeps {
  api: FinishBridge;
  toast(text: string, level?: ToastLevel): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  choice<T extends string>(opts: ChoiceOptions<T>): Promise<T | null>;
  /** 选中新建的会话并显示其终端 */
  openSession(id: string): void;
}

export const BUSY_WARN = '⚠ Claude 正在运行，可能马上又改这个工作区';

/** 本地配置文件在暂存时被排除，命令展示里用占位说明 */
const ADD_DISPLAY = 'git add -A -- . <排除面板复制的本地配置>';

function failText(r: GitOpResult): string {
  return r.detail ? `${r.message}：${r.detail.split('\n')[0]}` : r.message;
}

function cmdMessage(cwd: string, cmds: string[], extra: string[], busy: boolean): string {
  const lines = [`工作目录：${cwd}`, '将执行：', ...cmds.map(c => `  ${c}`)];
  if (extra.length) lines.push('', ...extra);
  if (busy) lines.push('', BUSY_WARN);
  return lines.join('\n');
}

/**
 * 确认后执行，主进程要求忙碌确认时再问一次并带 force 重试。
 * 用户取消返回 null；IPC 异常转为失败结果。
 */
async function confirmRun(
  deps: FinishFlowDeps, opts: ConfirmOptions, busy: boolean, op: (force: boolean) => Promise<GitOpResult>,
): Promise<GitOpResult | null> {
  if (!await deps.confirm(opts)) return null;
  let force = busy;
  for (let i = 0; i < 2; i++) {
    let r: GitOpResult;
    try {
      r = await op(force);
    } catch (err) {
      r = { ok: false, message: ipcErrorText(err), steps: [] };
    }
    if (r.needConfirm === 'busy' && !force) {
      if (!await deps.confirm({ title: opts.title, message: `${BUSY_WARN}\n仍要继续吗？`, okText: '仍然继续', danger: true })) return null;
      force = true;
      continue;
    }
    return r;
  }
  return null;
}

function report(deps: FinishFlowDeps, r: GitOpResult): void {
  deps.toast(r.ok ? r.message : failText(r), r.ok ? 'success' : 'error');
}

export async function commitFlow(
  deps: FinishFlowDeps, s: Session, st: FinishStatus, msg: string, noVerify: boolean,
): Promise<GitOpResult | null> {
  const text = msg.trim();
  if (!text) { deps.toast('提交信息不能为空', 'warning'); return null; }
  const cwd = s.worktree?.path ?? s.cwd;
  const commit = `git commit -F <临时文件>${noVerify ? ' --no-verify' : ''}`;
  const first = text.split('\n')[0];
  const r = await confirmRun(deps, {
    title: `提交 ${st.dirty} 个改动`,
    message: cmdMessage(cwd, [ADD_DISPLAY, commit], [`提交信息：${first}`], st.busy),
    okText: '提交',
  }, st.busy, force => deps.api.commit(s.id, text, { noVerify, force }));
  if (r) report(deps, r);
  return r;
}

export async function mergeFlow(deps: FinishFlowDeps, s: Session, st: FinishStatus, ffOnly: boolean): Promise<GitOpResult | null> {
  const cmd = ffOnly
    ? `git merge --ff-only ${quoteArg(st.branch)}`
    : `git merge --no-ff -m ${quoteArg(`Merge branch '${st.branch}'`)} ${quoteArg(st.branch)}`;
  const extra = [`把 ${st.branch} 的 ${st.ahead} 个提交合并到主工作区的 ${st.baseRef}`];
  if (st.precheck?.state === 'conflict') extra.push(`⚠ 预检有冲突：${st.precheck.files.join('、')}`);
  const r = await confirmRun(deps, {
    title: `合并到 ${st.baseRef}`,
    message: cmdMessage(st.main.path, [cmd], extra, st.busy),
    okText: '合并',
  }, st.busy, force => deps.api.merge(s.id, { ffOnly, force }));
  if (!r) return null;
  if (r.conflicts && r.conflicts.length > 0) {
    await conflictFlow(deps, s, st, r.conflicts);
    return r;
  }
  report(deps, r);
  return r;
}

type ConflictPick = 'session' | 'abort' | 'later';

/** 合并冲突后的三个去向 */
export async function conflictFlow(deps: FinishFlowDeps, s: Session, st: FinishStatus, files: string[]): Promise<void> {
  const shown = files.slice(0, 8).map(f => `  ${f}`);
  if (files.length > shown.length) shown.push(`  … 共 ${files.length} 个`);
  const pick = await deps.choice<ConflictPick>({
    title: '合并出现冲突',
    message: [`主工作区 ${st.main.path} 现在处于合并中状态，冲突文件：`, ...shown].join('\n'),
    choices: [
      { value: 'later', text: '稍后手动处理' },
      { value: 'abort', text: '放弃合并', style: 'danger' },
      { value: 'session', text: '开一个解决冲突的会话', style: 'primary' },
    ],
    defaultValue: 'session',
  });
  if (pick === 'session') await openConflictSession(deps, s.id);
  else if (pick === 'abort') await abortFlow(deps, s, st);
  else deps.toast('主工作区仍处于合并中，可稍后在收尾页放弃合并或开解决冲突的会话', 'warning');
}

export async function abortFlow(deps: FinishFlowDeps, s: Session, st: FinishStatus): Promise<GitOpResult | null> {
  const ok = await deps.confirm({
    title: '放弃合并',
    message: cmdMessage(st.main.path, ['git merge --abort'], ['主工作区会回到合并前，冲突的解决进度会丢失'], false),
    okText: '放弃合并',
    danger: true,
  });
  if (!ok) return null;
  let r: GitOpResult;
  try {
    r = await deps.api.abortMerge(s.id);
  } catch (err) {
    r = { ok: false, message: ipcErrorText(err), steps: [] };
  }
  report(deps, r);
  return r;
}

export async function openConflictSession(deps: FinishFlowDeps, sid: string): Promise<boolean> {
  try {
    const r = await deps.api.conflictSession(sid);
    if ('error' in r) { deps.toast(r.error, 'error'); return false; }
    deps.openSession(r.id);
    deps.toast('已创建解决冲突的会话，提示词将在 Claude 就绪后自动发送', 'info');
    return true;
  } catch (err) {
    deps.toast(ipcErrorText(err), 'error');
    return false;
  }
}

export async function pushFlow(deps: FinishFlowDeps, s: Session, st: FinishStatus, remote: string): Promise<GitOpResult | null> {
  const cwd = s.worktree?.path ?? s.cwd;
  const r = await confirmRun(deps, {
    title: `推送到 ${remote}`,
    message: cmdMessage(cwd, [`git push -u ${quoteArg(remote)} ${quoteArg(st.branch)}`], [], false),
    okText: '推送',
  }, false, () => deps.api.push(s.id, remote));
  if (r) report(deps, r);
  return r;
}

export async function prFlow(
  deps: FinishFlowDeps, s: Session, st: FinishStatus, remote: string, title: string, body: string, pushFirst: boolean,
): Promise<GitOpResult | null> {
  if (!title.trim()) { deps.toast('PR 标题不能为空', 'warning'); return null; }
  const cwd = s.worktree?.path ?? s.cwd;
  const cmds = [
    ...(pushFirst ? [`git push -u ${quoteArg(remote)} ${quoteArg(st.branch)}`] : []),
    `gh pr create --base ${quoteArg(st.baseRef)} --head ${quoteArg(st.branch)} --title ${quoteArg(title.trim())} --body-file <临时文件>`,
  ];
  const r = await confirmRun(deps, {
    title: '创建 PR',
    message: cmdMessage(cwd, cmds, [], false),
    okText: '创建 PR',
  }, false, () => deps.api.pr(s.id, { remote, title, body, pushFirst }));
  if (!r) return null;
  deps.toast(r.ok ? `${r.message}${r.url ? `：${r.url}` : ''}` : r.message, r.ok ? 'success' : 'warning');
  return r;
}

export async function copyGhCommand(deps: FinishFlowDeps, st: FinishStatus, title: string, body: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(ghCreateCommand(st.baseRef, st.branch, title.trim(), body.trim()));
    deps.toast('已复制 gh 命令', 'success');
  } catch (err) {
    deps.toast(`复制失败：${ipcErrorText(err)}`, 'error');
  }
}

export async function openCompare(deps: FinishFlowDeps, sid: string, remote: string): Promise<void> {
  try {
    const err = await deps.api.openCompare(sid, remote);
    if (err) deps.toast(err, 'error');
  } catch (e) {
    deps.toast(ipcErrorText(e), 'error');
  }
}

/** 让会话自己处理（提交或在工作区合入基线），忙碌时让用户选择排队或立即发送 */
export async function sendPromptFlow(
  deps: FinishFlowDeps, sid: string, reason: 'commit' | 'merge-in-worktree' | 'pending',
): Promise<boolean> {
  try {
    let r: SendResult = await deps.api.sendPrompt(sid, reason, 'auto');
    if (r.needChoice) {
      const perm = r.needChoice === 'permission';
      const pick = await deps.choice<'now' | 'queue'>({
        title: perm ? 'Claude 正在等你确认权限' : 'Claude 正在处理本轮任务',
        message: perm
          ? '先处理权限再发送；也可以排队，本轮结束后自动发送。'
          : '立即发送会在 Claude 处理中插入消息；排队则在本轮结束后自动发送。',
        choices: perm
          ? [{ value: 'queue', text: '排队，本轮结束后发送', style: 'primary' }]
          : [{ value: 'now', text: '立即发送' }, { value: 'queue', text: '排队，本轮结束后发送', style: 'primary' }],
        defaultValue: 'queue',
      });
      if (!pick) return false;
      r = await deps.api.sendPrompt(sid, reason, pick);
    }
    deps.toast(r.message, r.ok ? (r.queued ? 'info' : 'success') : 'error');
    if (r.ok && r.sent && r.warnPasteMode) deps.toast('未检测到粘贴模式，多行消息可能被逐行提交，请留意终端', 'warning');
    return r.ok;
  } catch (err) {
    deps.toast(ipcErrorText(err), 'error');
    return false;
  }
}
