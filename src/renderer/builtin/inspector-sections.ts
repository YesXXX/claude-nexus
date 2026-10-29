import type { Session } from '../../shared/types';
import type { GroupKey } from '../../shared/session-view.js';
import { groupSessions, longDuration, orderForDisplay, shortDuration } from '../../shared/session-view.js';
import type { AppContext } from '../core/context.js';
import { short } from '../core/debug.js';
import { el, statusIcon } from '../core/dom.js';
import { GROUP_ICON, STATUS_TEXT, SUB_ICON_STATUS, SUBAGENT_STATUS_TEXT, subagentTitle } from '../core/labels.js';
import { renderEach, statusBadges } from '../core/registry.js';
import { state } from '../core/state.js';
import { foldSection } from '../ui/fold-section.js';
import { toast } from '../ui/toast.js';
import { selectSubagent } from '../actions/selection.js';
import { openWorktreeOf } from '../actions/session-actions.js';
import { setPaneTab } from '../views/detail-pane.js';

/**
 * 内置属性面板分区与状态标记。未选中会话时显示总览。
 * 选中会话时按关键程度由上往下排列（order 以百为档，功能模块的分区插在对应档位）：
 * 状态（含待审批与状态标记）0 → 自动验证 100 → 改动 200 → 上下文 300 → 子代理 400 → 最近活动 500
 * → 工作区 600 → 属性 700 → 对话 800。没有内容的分区不显示；属性与对话默认折叠。快捷键在设置页查看。
 */
export function installBuiltinInspectorSections(ctx: AppContext): void {
  const { registerInspectorSection, registerStatusBadge } = ctx.registry;
  registerInspectorSection({ id: 'core.overview', order: 0, render: s => (s ? null : renderOverviewSection()) });
  registerInspectorSection({ id: 'core.status', order: 0, render: s => (s ? renderStatusSection(s) : null) });
  registerInspectorSection({ id: 'core.changes', order: 200, render: s => (s ? renderChangesSection(s) : null) });
  registerInspectorSection({ id: 'core.subagents', order: 400, render: s => (s?.subagents?.length ? renderSubagentsSection(s) : null) });
  registerInspectorSection({ id: 'core.worktree', order: 600, render: s => (s?.worktree ? renderWorktreeSection(s) : null) });
  registerInspectorSection({ id: 'core.props', order: 700, render: s => (s ? renderPropsSection(s) : null) });

  registerStatusBadge({
    id: 'core.escalated', order: 0,
    render: s => (s.escalated ? badge('⏰ 已再次提醒', 'warn', '等待超过设定时间，已再次发出提醒') : null),
  });
  registerStatusBadge({
    id: 'core.read-only', order: 100,
    render: s => (s.readOnly ? badge('只读', '', '面板重启后认领的孤儿会话，输入请回到原终端或接管并续接') : null),
  });
  registerStatusBadge({
    id: 'core.exit-code', order: 200,
    render: s => (s.exitCode !== null && s.exitCode !== undefined
      ? badge(`退出码 ${s.exitCode}`, s.status === 'error' ? 'err' : '')
      : null),
  });
}

function badge(text: string, cls: string, title = ''): HTMLElement {
  const b = el('span', `tagx${cls ? ' ' + cls : ''}`, text);
  if (title) b.title = title;
  return b;
}

/** 状态分区：当前状态（持续时间在悬停提示里）、待审批的工具与命令、各功能的状态标记 */
function renderStatusSection(s: Session): HTMLElement {
  const sec = el('section', 'sec status-sec');
  sec.dataset.sessionId = s.id;
  sec.appendChild(el('h4', '', '状态'));
  const now = el('div', 'st-now');
  now.appendChild(statusIcon(s.status));
  now.appendChild(el('span', 'st-text', STATUS_TEXT[s.status]));
  now.title = `已持续 ${longDuration(Date.now() - s.statusSince)} · 进入当前状态于 ${new Date(s.statusSince).toLocaleString()}`;
  sec.appendChild(now);
  if (s.pendingAction) {
    const p = el('div', 'st-pending');
    p.appendChild(el('span', 'st-pending-k', s.pendingAction.toolName));
    p.appendChild(el('code', 'st-pending-v', s.pendingAction.commandText || '（无命令文本）'));
    sec.appendChild(p);
  }
  const badges = renderEach(statusBadges(), s, (b, x) => b.render(x));
  if (badges.length > 0) {
    const row = el('div', 'st-badges');
    row.append(...badges);
    sec.appendChild(row);
  }
  return sec;
}

/**
 * 路径按分隔符插入可断行点：窄栏里只在 \ 或 / 之后换行，不会把目录名拦腰截断；
 * 单段本身超长时再由 CSS 的 overflow-wrap 兜底。
 */
function pathNode(p: string): HTMLElement {
  const span = el('span', 'path');
  span.title = p;
  for (const part of p.split(/(?<=[\\/])/)) {
    span.append(part);
    span.appendChild(document.createElement('wbr'));
  }
  return span;
}

/**
 * 主行是本会话改动（Claude 动过的全部文件），仓库视角有 git 改动时下面一行暗色补上；
 * 两边都没有改动时整节不显示。更新时间放在悬停提示里。
 */
function renderChangesSection(s: Session): HTMLElement | null {
  const sc = s.sessionChanges;
  const c = s.changes;
  const mine = !!sc && !sc.error && sc.files > 0;
  const repoHas = !!c && !c.error && c.files > 0;
  if (!mine && !repoHas && !sc?.error) return null;
  const sec = el('section', 'sec');
  sec.appendChild(el('h4', '', '改动'));
  const row = el('button', 'chg-sum') as HTMLButtonElement;
  row.type = 'button';
  const tip = ['在详情中查看改动（Ctrl+Shift+D）'];
  if (sc?.error) {
    row.appendChild(el('span', 'chg-dim', sc.error));
  } else if (mine && sc) {
    row.append(`本会话 ${sc.files} 个文件 · `);
    row.appendChild(el('span', 'chg-add', `+${sc.additions}`));
    row.append(' ');
    row.appendChild(el('span', 'chg-del', `−${sc.deletions}`));
    if (sc.roots > 1) row.appendChild(el('span', 'chg-dim', ` · 跨 ${sc.roots} 个目录`));
    tip.push(`${clockText(sc.updatedAt)} 更新`);
  } else {
    row.appendChild(el('span', 'chg-dim', '本会话暂无改动'));
  }
  if (repoHas && c) {
    let repo = `仓库视角：${c.files} 个文件 +${c.additions} −${c.deletions}`;
    if (s.worktree) repo += c.mode === 'base' ? '（相对基线）' : '（仅未提交）';
    row.appendChild(el('div', 'chg-dim chg-sum-repo', repo));
  }
  row.title = tip.join(' · ');
  row.addEventListener('click', () => setPaneTab('changes'));
  sec.appendChild(row);
  return sec;
}

function clockText(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 总览：只列有会话的状态；还没有任何会话时整节不显示 */
function renderOverviewSection(): HTMLElement | null {
  const groups = groupSessions(orderForDisplay(state.sessions));
  const counts = new Map<GroupKey, number>(groups.map(g => [g.key, g.sessions.length]));
  const rows: Array<[GroupKey, string]> = [
    ['perm', '等待权限'], ['input', '等待输入'], ['trouble', '异常 / 失联'],
    ['running', '运行中'], ['done', '已完成'],
  ];
  const shown = rows.filter(([key]) => (counts.get(key) ?? 0) > 0);
  if (shown.length === 0) return null;
  const sec = el('section', 'sec');
  sec.appendChild(el('h4', '', '总览'));
  const ov = el('div', 'ov');
  for (const [key, title] of shown) {
    const lab = el('div', 'lab');
    lab.appendChild(statusIcon(GROUP_ICON[key], 'still'));
    lab.append(title);
    ov.appendChild(lab);
    ov.appendChild(el('div', 'num', String(counts.get(key) ?? 0)));
  }
  sec.appendChild(ov);
  return sec;
}

/** 属性：工作目录、会话 id、来源、创建时间；默认折叠 */
function renderPropsSection(s: Session): HTMLElement {
  const { sec, body } = foldSection('props', '属性', 'props-sec');
  const kv = el('div', 'kv');

  const push = (k: string, v: Node | string, cls = ''): void => {
    kv.appendChild(el('div', 'k', k));
    const cell = el('div', `v${cls ? ' ' + cls : ''}`);
    if (typeof v === 'string') cell.textContent = v; else cell.appendChild(v);
    kv.appendChild(cell);
  };

  push('工作目录', pathNode(s.cwd), 'm');
  const idCell = el('span');
  idCell.append(short(s.id));
  if (s.claudeSessionId) idCell.append(` · ${short(s.claudeSessionId)}`);
  push('会话', idCell, 'm');
  push('来源', s.readOnly ? '认领的孤儿会话（只读）' : '面板托管');
  push('创建时间', new Date(s.createdAt).toLocaleString());

  body.appendChild(kv);
  return sec;
}

function renderWorktreeSection(s: Session): HTMLElement {
  const wt = s.worktree!;
  const sec = el('section', 'sec');
  sec.appendChild(el('h4', '', '工作区'));
  const kv = el('div', 'kv');
  const push = (k: string, v: Node | string, cls = ''): void => {
    kv.appendChild(el('div', 'k', k));
    const cell = el('div', `v${cls ? ' ' + cls : ''}`);
    if (typeof v === 'string') cell.textContent = v; else cell.appendChild(v);
    kv.appendChild(cell);
  };
  push('分支', wt.branch, 'm');
  push('基线', wt.baseRef === wt.baseCommit.slice(0, 8) ? wt.baseRef : `${wt.baseRef} · ${wt.baseCommit.slice(0, 8)}`, 'm');
  push('工作区', pathNode(wt.path), 'm');
  push('主仓库', pathNode(wt.repoRoot), 'm');
  sec.appendChild(kv);

  const ops = el('div', 'sec-ops');
  const copy = el('button', 'btn', '复制工作区路径') as HTMLButtonElement;
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(wt.path).then(() => toast('已复制工作区路径')).catch(() => undefined);
  });
  const open = el('button', 'btn', '在资源管理器中打开') as HTMLButtonElement;
  open.addEventListener('click', () => { void openWorktreeOf(s.id); });
  ops.append(copy, open);
  sec.appendChild(ops);
  return sec;
}

function renderSubagentsSection(s: Session): HTMLElement {
  const subs = s.subagents ?? [];
  const sec = el('section', 'sec');
  const h = el('h4', '', `子代理${subs.length > 0 ? ` · ${subs.length}` : ''}`);
  sec.appendChild(h);

  const tl = el('div', 'tl');
  for (const sub of subs) {
    const isSelected = state.selectedSubagent?.sessionId === s.id && state.selectedSubagent.agentId === sub.agentId;
    const row = el('button', `tl-i${isSelected ? ' sel' : ''}`) as HTMLButtonElement;
    row.type = 'button';
    row.appendChild(statusIcon(SUB_ICON_STATUS[sub.status]));
    const x = el('div', 'x');
    x.appendChild(el('div', 'a', subagentTitle(sub)));
    x.appendChild(el('div', 'b',
      `${sub.agentType} · ${SUBAGENT_STATUS_TEXT[sub.status]} · ${shortDuration(Date.now() - sub.statusSince)}`));
    row.appendChild(x);
    row.addEventListener('click', () => selectSubagent(s.id, sub.agentId));
    tl.appendChild(row);
  }
  sec.appendChild(tl);
  return sec;
}
