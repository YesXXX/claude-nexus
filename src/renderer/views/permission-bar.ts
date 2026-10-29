import type { Session } from '../../shared/types';
import { byId, el, statusIcon } from '../core/dom.js';
import { state } from '../core/state.js';
import { isApproveLockStale, sendApprove } from '../actions/session-actions.js';

// 权限请求条：等待权限时显示在终端下方，一键 允许/拒绝/总是允许
export function renderPermissionBar(s: Session): void {
  const bar = byId('permission-bar');
  if (s.status !== 'waiting_permission' || !s.pendingAction) {
    bar.hidden = true;
    return;
  }
  // 锁定解除：会话已离开等待权限 / 会话消失 / 超 3s 兜底（状态确认路径由 onSessions 推送负责）
  if (isApproveLockStale()) state.pendingApprove = null;

  bar.innerHTML = '';
  bar.hidden = false;

  const ic = el('div', 'ic');
  ic.appendChild(statusIcon('waiting_permission'));
  bar.appendChild(ic);

  const txt = el('div', 'txt');
  // 标题直接写工具名，命令单独一格；「请求运行命令 / 使用工具」放进悬停提示
  const q = el('div', 'q');
  q.appendChild(el('b', '', s.pendingAction.toolName));
  q.title = s.pendingAction.toolName === 'Bash' ? 'Claude 请求运行命令' : 'Claude 请求使用工具';
  txt.appendChild(q);
  const cmd = el('div', 'cmd', s.pendingAction.commandText || '（无命令文本）');
  cmd.title = s.pendingAction.commandText || '（无命令文本）';
  txt.appendChild(cmd);
  bar.appendChild(txt);

  const locked = state.pendingApprove?.id === s.id;
  const labels: Array<[string, string, 'yes' | 'no' | 'always']> = [
    ['拒绝', 'N', 'no'], ['总是允许', 'A', 'always'], ['允许', 'Y', 'yes'],
  ];
  // 按键 Y / N / A 照常可用，只写在悬停提示里
  for (const [text, key, choice] of labels) {
    const b = el('button', `btn${choice === 'yes' ? ' white' : ''}`, text) as HTMLButtonElement;
    b.title = `${text}（${key}）`;
    b.dataset.choice = choice;
    b.disabled = locked;
    b.addEventListener('click', () => sendApprove(s.id, choice));
    bar.appendChild(b);
  }
}

/** 非焦点窗格是否显示内联批准条 */
export function needsInlineApprove(s: Session): boolean {
  return s.status === 'waiting_permission' && !!s.pendingAction && !s.readOnly;
}

/** 内联批准条的内容签名：工具、命令或锁定状态变化时才重建 */
export function inlineApproveKey(s: Session): string {
  const locked = state.pendingApprove?.id === s.id;
  return `${s.pendingAction?.toolName ?? ''}|${s.pendingAction?.commandText ?? ''}|${locked}`;
}

/** 非焦点窗格的内联批准条：等待批准 · 工具 · 命令 · 拒绝 / 允许，直接对该会话发送决定 */
export function renderInlineApprove(s: Session): HTMLElement[] {
  const tool = s.pendingAction?.toolName ?? '';
  const cmd = s.pendingAction?.commandText || '（无命令文本）';
  const code = el('code', '', `${tool} · ${cmd}`);
  code.title = `${tool} · ${cmd}`;
  const locked = state.pendingApprove?.id === s.id;
  const btns = ([['拒绝', 'no'], ['允许', 'yes']] as Array<[string, 'yes' | 'no']>).map(([text, choice]) => {
    const b = el('button', `btn${choice === 'yes' ? ' white' : ''}`, text) as HTMLButtonElement;
    b.type = 'button';
    b.dataset.choice = choice;
    b.disabled = locked;
    b.addEventListener('click', e => {
      e.stopPropagation();
      sendApprove(s.id, choice);
    });
    return b;
  });
  return [el('span', 'mp-ap-t', '等待批准'), code, el('span', 'mp-gap'), ...btns];
}
