import type { Session } from '../../../shared/types';
import type { FinishStatus, OutboxReason } from '../../../shared/review-types';
import type { ChangesExtInstance, ChangesHost } from '../../core/changes-ext.js';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import type { PaletteItem } from '../../core/registry.js';
import { sendPromptFlow, type FinishFlowDeps } from './finish-flow.js';
import { createFinishView, type FinishAction, type FinishView } from './finish-view.js';

/**
 * 工作区收尾：独立工作区会话的详情区多一个「收尾」标签（Ctrl+Shift+F 在终端与收尾之间切换），
 * 命令面板提供提交 / 合并 / 推送 / 创建 PR 的入口；新会话就绪超时后保留的提示词在改动页顶部提示，可手动发送或放弃。
 */

const TAB = 'finish';

const PALETTE: Array<{ action: FinishAction; icon: string; title: string; keywords: string }> = [
  { action: 'commit', icon: '✓', title: '收尾：提交', keywords: 'shouwei tijiao commit finish' },
  { action: 'merge', icon: '⑃', title: '收尾：合并', keywords: 'shouwei hebing merge finish' },
  { action: 'push', icon: '↑', title: '收尾：推送', keywords: 'shouwei tuisong push finish' },
  { action: 'pr', icon: '⇪', title: '收尾：创建 PR', keywords: 'shouwei pr pull request finish' },
];

const PENDING_TEXT: Partial<Record<OutboxReason, string>> = {
  conflict: '解决冲突的提示词',
};

export function install(ctx: AppContext): void {
  const statuses = new Map<string, FinishStatus>();
  const pending = new Map<string, OutboxReason>();
  const pendingRenderers = new Set<() => void>();
  let view: FinishView | null = null;

  const openSession = (id: string): void => {
    // 新会话随下一次会话推送到达渲染层，到达后再选中，避免右侧出现空白
    const go = (left: number): void => {
      if (ctx.state.sessions.some(s => s.id === id) || left <= 0) {
        ctx.actions.showTerminalTab(id);
        ctx.actions.selectSession(id);
        ctx.actions.focusSessionInput(id);
        return;
      }
      setTimeout(() => go(left - 1), 50);
    };
    go(60);
  };

  const flow: FinishFlowDeps = {
    api: ctx.api.finish,
    toast: ctx.toast,
    confirm: o => ctx.confirm(o),
    choice: o => ctx.choice(o),
    openSession,
  };

  const loadPending = async (id: string): Promise<void> => {
    const r = await ctx.api.finish.pendingPrompt(id).catch(() => null);
    if (r) pending.set(id, r);
    else pending.delete(id);
    pendingRenderers.forEach(f => f());
  };

  ctx.registry.registerDetailTab({
    id: 'finish.finish',
    title: '收尾',
    order: 200,
    available: s => !!s.worktree,
    stat: s => {
      const st = statuses.get(s.id);
      return st && st.ahead > 0 ? el('span', 'fin-tab-stat', `↑${st.ahead}`) : null;
    },
    tooltip: s => {
      const st = statuses.get(s.id);
      const base = '工作区收尾：提交、合并、推送、创建 PR（Ctrl+Shift+F）';
      return st ? `${base}；领先 ${st.baseRef} ${st.ahead} 个提交，${st.dirty} 个未提交改动` : base;
    },
    create: host => {
      view = createFinishView(host, {
        api: ctx.api.finish,
        flow,
        onStatus: (id, st) => { statuses.set(id, st); ctx.requestRender(); },
      });
      return view;
    },
  });

  const canFinish = (s: Session | undefined): s is Session => !!s && !!s.worktree;

  ctx.registry.registerHotkey({
    id: 'finish.toggle', keys: 'Ctrl ⇧ F', label: '终端 / 收尾', phase: 'always', order: 5, helpOrder: 95,
    match: (e, c) => e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && canFinish(c.session),
    run: e => {
      e.preventDefault(); e.stopPropagation();
      ctx.actions.setPaneTab(ctx.state.paneTab === TAB ? 'term' : TAB);
    },
  });

  const reveal = (action: FinishAction): void => {
    if (ctx.state.paneTab !== TAB) ctx.actions.setPaneTab(TAB);
    else view?.refresh();
    view?.reveal(action);
  };

  ctx.registry.registerCommands({
    id: 'finish.palette',
    order: 590,
    items: ({ session }) => {
      const out: PaletteItem[] = [];
      if (canFinish(session)) {
        for (const p of PALETTE) {
          out.push({
            section: '命令', icon: p.icon, title: p.title, sub: session.worktree?.branch ?? session.label,
            keywords: p.keywords, run: () => reveal(p.action),
          });
        }
      }
      const reason = session ? pending.get(session.id) : undefined;
      if (session && reason) {
        out.push({
          section: '命令', icon: '➤', title: '发送准备好的提示词', sub: PENDING_TEXT[reason] ?? session.label,
          keywords: 'tishici fasong prompt send pending',
          run: () => void sendPromptFlow(flow, session.id, 'pending').then(() => loadPending(session.id)),
        });
      }
      return out;
    },
  });

  ctx.registry.registerChangesExtension({
    id: 'finish.pending-prompt',
    order: 650,
    attach(host: ChangesHost): ChangesExtInstance {
      const bar = el('div', 'fin-pending');
      bar.hidden = true;
      const render = (): void => {
        const s = host.session();
        const reason = s ? pending.get(s.id) : undefined;
        bar.replaceChildren();
        bar.hidden = !reason;
        if (!s || !reason) return;
        const send = el('button', 'chg-btn primary fin-pending-send', '发送');
        send.type = 'button';
        send.disabled = !!s.readOnly;
        send.addEventListener('click', () => void sendPromptFlow(flow, s.id, 'pending').then(() => loadPending(s.id)));
        const drop = el('button', 'chg-btn fin-pending-drop', '放弃');
        drop.type = 'button';
        drop.addEventListener('click', () => {
          void ctx.api.finish.discardPrompt(s.id)
            .then(ok => { if (ok) ctx.toast('已放弃准备好的提示词', 'info'); })
            .catch(err => ctx.toast(ipcErrorText(err), 'error'))
            .finally(() => void loadPending(s.id));
        });
        bar.append(
          el('span', 'fin-pending-mark', '➤'),
          el('span', 'fin-pending-text', `${PENDING_TEXT[reason] ?? '提示词'}未发送：Claude 启动时没有及时就绪`),
          el('span', 'chg-sp'), send, drop,
        );
      };
      pendingRenderers.add(render);
      return {
        bar,
        show(s: Session): void { render(); void loadPending(s.id); },
        update: () => render(),
      };
    },
  });

  // 就绪超时的提示走 outbox 通知（批注模块已负责弹出），这里只据此重查待发送状态
  ctx.api.annotations.onNotice(id => { void loadPending(id); });
}
