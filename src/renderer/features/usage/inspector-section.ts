import type { Session } from '../../../shared/types';
import type { SessionUsageSummary } from '../../../shared/usage-types';
import { fmtInt, WINDOW_SOURCE_TEXT } from '../../../shared/usage-format.js';
import type { AppContext } from '../../core/context.js';
import { el } from '../../core/dom.js';
import { openUsageSettings } from './settings-dialog.js';

/**
 * 属性面板「上下文」节：主线程上下文的已用 / 窗口、占用条、模型与窗口来源、压缩次数。
 * 摘要随会话列表推送，渲染时直接可用，不另外拉取。还没有统计数据（首轮未结束、没有对话记录）时整节不显示，
 * 没有数据的原因记在主进程日志的 usage 标签下。
 */

/** 属性面板分区顺序：排在验证与改动之后、子代理之前 */
const ORDER = 300;

export function installUsageSection(ctx: AppContext): void {
  ctx.registry.registerInspectorSection({
    id: 'usage.context', order: ORDER,
    render: s => (s?.usage ? renderSection(s, s.usage) : null),
  });
}

function headButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'usage-hbtn', text);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function renderContext(u: SessionUsageSummary): HTMLElement {
  const c = u.context;
  if (!c) return el('div', 'insp-empty', '暂无上下文数据');
  const box = el('div', `uc lv-${c.level}`);
  const head = el('div', 'uc-head');
  head.appendChild(el('span', 'uc-k', '已用'));
  head.appendChild(el('span', 'uc-v', `${fmtInt(c.used)} / ${fmtInt(c.window)}（${c.pct}%）`));
  box.appendChild(head);
  const bar = el('div', 'uc-bar');
  const fill = el('div', 'uc-fill');
  fill.style.width = `${Math.min(100, Math.max(0, c.pct))}%`;
  bar.appendChild(fill);
  box.appendChild(bar);
  const compact = c.compactions ? ` · 已压缩 ${c.compactions} 次` : c.compacted ? ' · 已压缩' : '';
  box.appendChild(el('div', 'uc-sub', `${c.model} · 窗口来源：${WINDOW_SOURCE_TEXT[c.windowSource]}${compact}`));
  return box;
}

function renderSection(s: Session, u: SessionUsageSummary): HTMLElement | null {
  if (u.state === 'pending' || u.state === 'no_data' || !u.context) return null;
  const sec = el('section', 'sec usage-sec');
  sec.dataset.sessionId = s.id;
  const h = el('h4');
  h.appendChild(el('span', '', '上下文'));
  const ops = el('span', 'usage-hops');
  ops.append(headButton('设置…', '告警阈值与上下文窗口覆盖', () => { void openUsageSettings(); }));
  h.appendChild(ops);
  sec.appendChild(h);

  sec.appendChild(renderContext(u));
  return sec;
}
