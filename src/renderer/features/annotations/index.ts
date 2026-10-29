import type { Session } from '../../../shared/types';
import type { ChangesExtInstance, ChangesHost } from '../../core/changes-ext.js';
import type { AppContext } from '../../core/context.js';
import { el } from '../../core/dom.js';
import type { PaletteItem } from '../../core/registry.js';
import { AnnotationCache } from './annotation-cache.js';
import { createAnnotationPanel, sendBlockReason, type AnnotationPanel } from './annotation-panel.js';
import { createDiffAnnotator } from './diff-annotator.js';
import { sendAnnotations, type SendDeps } from './send-flow.js';

/**
 * 改动批注：在改动视图的 diff 上按行写修改意见，攒成一条消息发给该会话的 Claude。
 * 批注存在主进程，渲染层只缓存列表；主进程推送变化时重新拉取当前展示或已缓存的会话。
 * 会话行上显示待发送条数或排队状态，命令面板提供发送与查看入口。
 */
export function install(ctx: AppContext): void {
  const api = ctx.api.annotations;
  const cache = new AnnotationCache(api);
  const sendDeps: SendDeps = {
    api,
    toast: ctx.toast,
    choice: opts => ctx.choice(opts),
    reload: id => void cache.load(id),
  };
  /** 最近一次展示的改动视图实例，供命令面板「查看批注」打开抽屉 */
  let active: { panel: AnnotationPanel; sid(): string | undefined } | null = null;
  let pendingOpen: string | null = null;

  ctx.registry.registerChangesExtension({
    id: 'annotations.changes',
    order: 500,
    attach(host: ChangesHost): ChangesExtInstance {
      const annotator = createDiffAnnotator(host, { api, cache, toast: ctx.toast, confirm: o => ctx.confirm(o) });
      const panel = createAnnotationPanel(host, annotator, { ...sendDeps, get: id => cache.get(id) });
      let current: string | undefined;
      const me = { panel, sid: () => current };
      cache.subscribe(id => {
        if (id !== current) return;
        panel.render();
        annotator.redraw();
        host.rerenderRows();
      });
      const showSession = (s: Session): void => {
        active = me;
        if (s.id !== current) {
          annotator.reset();
          panel.closeDrawer();
          current = s.id;
        }
        panel.render();
        void cache.load(s.id);
        if (pendingOpen === s.id) { pendingOpen = null; panel.openDrawer(); }
      };
      // 批注按仓库相对路径记录：行标记与「批注」按钮只在仓库视角出现，横条与抽屉两种视角都显示
      const repo = (): boolean => host.scope() === 'repo';
      return {
        bar: panel.bar,
        overlay: panel.drawer,
        rowExtras: f => (repo() ? panel.rowMark(f) : null),
        headActions: f => (repo() ? panel.headAction(f) : null),
        diffRendered: () => annotator.redraw(),
        show: showSession,
        scopeChanged: () => annotator.reset(),
        update: () => panel.render(),
      };
    },
  });

  ctx.registry.registerStatusBadge({
    id: 'annotations.metric',
    order: 540,
    render(s: Session): HTMLElement | null {
      const a = s.annotations;
      if (!a || (!a.pending && !a.queued)) return null;
      const m = el('span', `ann-metric${a.queued ? ' queued' : ''}`, a.queued ? '◆ 批注排队中' : `◆ ${a.pending} 条批注待发送`);
      m.title = a.queued ? '批注已排队，本轮结束后发送' : `${a.pending} 条批注待发送`;
      return m;
    },
  });

  ctx.registry.registerCommands({
    id: 'annotations.palette',
    order: 560,
    items: ({ session }) => {
      const a = session?.annotations;
      if (!session || !a || (!a.pending && !a.queued)) return [];
      const id = session.id;
      const why = sendBlockReason(session);
      const out: PaletteItem[] = [{
        section: '命令', icon: '◆', title: '查看批注', sub: `${a.pending} 条待发送${a.queued ? '，有排队消息' : ''}`,
        keywords: 'pizhu chakan annotation review',
        run: () => {
          ctx.actions.setPaneTab('changes');
          if (active && active.sid() === id) active.panel.openDrawer();
          else pendingOpen = id;
        },
      }];
      if (a.pending && !a.queued) {
        out.push({
          section: '命令', icon: '◆', title: '发送批注给 Claude', sub: why || `${a.pending} 条批注合并为一条消息`,
          keywords: 'pizhu fasong annotation send claude',
          run: () => { if (!why) void sendAnnotations(id, sendDeps); },
          ...(why ? { disabled: true, hint: why } : {}),
        });
      }
      return out;
    },
  });

  api.onChanged(id => {
    if (cache.has(id) || active?.sid() === id) void cache.load(id);
  });
  api.onNotice((_id, message, level) => ctx.toast(message, level));
}
