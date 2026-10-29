import type { Session, SubagentEntry } from '../../shared/types';
import { longDuration } from '../../shared/session-view.js';
import { api } from '../core/api.js';
import { byId, el, statusIcon } from '../core/dom.js';
import { projectName, SUB_ICON_STATUS, SUBAGENT_STATUS_TEXT, subagentIcon, subagentTitle } from '../core/labels.js';
import { selectSession } from '../actions/selection.js';

/** 子代理详情：页头（父会话、类型图标、状态）与操作按钮 */

export function renderSubagentPane(s: Session, sub: SubagentEntry): void {
  byId('subagent-project').textContent = projectName(s);
  byId('subagent-project').title = s.cwd;

  const parentBtn = byId<HTMLButtonElement>('subagent-parent');
  parentBtn.textContent = s.label;
  parentBtn.title = `返回父会话：${s.label}`;
  parentBtn.onclick = () => selectSession(s.id);

  byId('subagent-icon').textContent = subagentIcon(sub.agentType);
  const label = byId('subagent-label');
  label.textContent = subagentTitle(sub);
  label.title = `agentId: ${sub.agentId}`;

  const pill = byId('subagent-status');
  pill.innerHTML = '';
  pill.appendChild(statusIcon(SUB_ICON_STATUS[sub.status]));
  pill.append(SUBAGENT_STATUS_TEXT[sub.status]);
  pill.title = `已持续 ${longDuration(Date.now() - sub.statusSince)}`;

  const actions = byId('subagent-actions');
  actions.innerHTML = '';
  const back = el('button', 'btn', '← 返回父会话') as HTMLButtonElement;
  back.title = '返回父会话（Esc）';
  back.addEventListener('click', () => selectSession(s.id));
  actions.appendChild(back);

  // 已结束才允许关闭：移除后 panel:state.sessions 推送会让详情视图自动回退到父会话
  if (sub.status !== 'running') {
    const close = el('button', 'btn danger', '关闭子代理') as HTMLButtonElement;
    close.addEventListener('click', () => { void api().dismissSubagent(s.id, sub.agentId); });
    actions.appendChild(close);
  }
}
