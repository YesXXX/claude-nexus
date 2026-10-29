import type { ChangeSummary } from '../../shared/types';
import type { SessionChangeSummary } from '../../shared/session-change-types';
import type { ChangesView } from '../features/changes/changes-view.js';
import { createChangesView } from '../features/changes/changes-view.js';
import type { AppContext } from '../core/context.js';
import { el } from '../core/dom.js';
import { changesExtensions } from '../core/registry.js';
import { inReview, reviewFocus, setReviewFocus } from '../core/review-layout.js';

/** 内置详情标签：终端（宿主为现有的 #term-card，不经过 create）与改动审阅 */

let changesView: ChangesView | null = null;

/** 当前改动视图实例（尚未切到过改动标签时为 null），供命令面板刷新与切换口径 */
export function getChangesView(): ChangesView | null {
  return changesView;
}

function changesTitle(c: ChangeSummary | undefined): string {
  if (!c) return '仓库视角：尚未统计';
  if (c.error) return `仓库视角：${c.error}`;
  const scope = c.mode === 'base' ? '相对基线' : '仅未提交';
  return `仓库视角：${c.files} 个文件 · +${c.additions} −${c.deletions}（${scope}）`;
}

function sessionTitle(c: SessionChangeSummary | undefined): string {
  if (!c) return '本会话改动：尚未统计';
  if (c.error) return `本会话改动：${c.error}`;
  const roots = c.roots > 1 ? `，跨 ${c.roots} 个目录` : '';
  return `本会话改动：${c.files} 个文件 · +${c.additions} −${c.deletions}${roots}`;
}

export function installBuiltinDetailTabs(ctx: AppContext): void {
  ctx.registry.registerDetailTab({ id: 'core.term', title: '终端', order: 0 });

  // / 聚焦改动列表的搜索框：与改动页其他单键快捷键同口径，只在改动视图内（或停在改动标签且焦点落在页面上）生效
  ctx.registry.registerHotkey({
    id: 'changes.focus-search', keys: '/', label: '改动：搜索文件', phase: 'outside-input', order: 505, helpOrder: 94.6,
    match: (e, c) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || c.inTerminal || e.key !== '/') return false;
      return c.inChanges || (inReview() && (!c.target || c.target === document.body));
    },
    run: e => {
      e.preventDefault();
      changesView?.focusSearch();
    },
  });

  // 本会话改动的数字直接挂在标签上，切换前就能看到有没有东西可审；仓库视角的数字在悬停提示里
  ctx.registry.registerDetailTab({
    id: 'core.changes',
    title: '改动',
    order: 100,
    stat: s => {
      const c = s.sessionChanges;
      const hasChanges = !!c && !c.error && c.files > 0;
      const notes = s.annotations?.pending ?? 0;
      if (!hasChanges && notes <= 0) return null;
      const frag = document.createDocumentFragment();
      if (c && hasChanges) {
        frag.append(String(c.files));
        frag.appendChild(el('span', 'chg-add', ` +${c.additions}`));
        frag.appendChild(el('span', 'chg-del', ` −${c.deletions}`));
      }
      // 待发送的批注条数
      if (notes > 0) frag.appendChild(el('span', 'ann-tab-stat', `${hasChanges ? ' ' : ''}◆${notes}`));
      return frag;
    },
    tooltip: s => {
      const notes = s.annotations?.pending ?? 0;
      const base = `${sessionTitle(s.sessionChanges)}\n${changesTitle(s.changes)}`;
      return notes > 0 ? `${base}\n${notes} 条批注待发送` : base;
    },
    create: host => {
      changesView = createChangesView(host, ctx.api, {
        toast: ctx.toast,
        confirm: o => ctx.confirm(o),
        extensions: changesExtensions(),
        focusMode: { on: reviewFocus, set: setReviewFocus },
      });
      return changesView;
    },
  });
}
