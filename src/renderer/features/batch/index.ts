import type { BatchRecord } from '../../../shared/batch-types';
import { batchStatusText } from '../../../shared/batch-view.js';
import type { AppContext } from '../../core/context.js';
import { el } from '../../core/dom.js';
import type { PaletteItem } from '../../core/registry.js';
import { notifyBatchChanged, openCompare } from './compare.js';
import { installBatchForm } from './form.js';

/**
 * 批量派发：新建表单的「并行方案数」、批次对比视图、会话行上的批次标记与命令面板入口。
 * 批次列表缓存在这里，批次变化推送与打开命令面板时刷新；会话行标记只读缓存，不发 IPC。
 */

export const BATCH_COMPARE_OPENER = 'batch.compare';

export function install(ctx: AppContext): void {
  let batches: BatchRecord[] = [];

  const refresh = async (): Promise<boolean> => {
    try {
      const next = await ctx.api.batch.list();
      const changed = JSON.stringify(next) !== JSON.stringify(batches);
      batches = next;
      if (changed) ctx.requestRender();
      return changed;
    } catch {
      return false;
    }
  };
  const byId = (id: string): BatchRecord | undefined => batches.find(b => b.id === id);
  const open = (id: string): void => openCompare(ctx, id);

  ctx.api.batch.onChanged(id => {
    notifyBatchChanged(id);
    void refresh();
  });
  void refresh();

  installBatchForm(ctx, id => {
    void refresh();
    open(id);
  });

  // 属性面板状态分区里的批次标记：显示方案序号，点击打开对比视图
  ctx.registry.registerStatusBadge({
    id: 'batch.marker', order: 440,
    render: s => {
      if (!s.batchId) return null;
      const b = byId(s.batchId);
      const idx = b?.indexes[s.id];
      const m = el('button', 'batch-marker', idx ? `⧉ 批次方案 #${idx}` : '⧉ 批次方案');
      m.type = 'button';
      m.dataset.batchId = s.batchId;
      m.title = b ? `批次「${b.label}」的方案 #${idx ?? '?'}，点击打开对比` : '批量派发的方案，点击打开对比';
      m.addEventListener('click', e => {
        e.stopPropagation();
        open(s.batchId!);
      });
      return m;
    },
  });

  ctx.registry.registerOpener({
    id: BATCH_COMPARE_OPENER, order: 540,
    open: () => {
      const sel = ctx.state.sessions.find(s => s.id === ctx.state.selectedId);
      const target = sel?.batchId ?? [...batches].sort((a, b) => b.createdAt - a.createdAt)[0]?.id;
      if (target) open(target);
      else ctx.toast('还没有批量派发的批次', 'info');
    },
  });

  ctx.registry.registerCommands({
    id: 'batch.palette', order: 540,
    refresh,
    items: c => {
      const items: PaletteItem[] = [];
      const own = c.session?.batchId;
      const sorted = [...batches].sort((a, b) => {
        if (a.id === own) return -1;
        if (b.id === own) return 1;
        return b.createdAt - a.createdAt;
      });
      for (const b of sorted) {
        items.push({
          section: '命令', icon: '⧉', title: `打开批次对比：${b.label}`,
          sub: `${b.sessionIds.length} 个方案 · ${batchStatusText(b)}`,
          keywords: `pici duibi batch compare fangan ${b.label}`,
          run: () => open(b.id),
        });
      }
      return items;
    },
  });
}
