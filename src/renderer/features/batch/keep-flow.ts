import type { BatchView } from '../../../shared/batch-types';
import { cleanupSummary, dirtyPreviews, discardLine } from '../../../shared/batch-view.js';
import type { AppContext } from '../../core/context.js';
import { ipcErrorText } from '../../core/dom.js';

/**
 * 保留 / 全部放弃的确认流程：
 * 先读取将被丢弃方案的工作区状态，逐条列出未提交文件与未合并提交；
 * 其中任何一个有未保存的改动时再做一次危险确认，确认后才结束会话并删除工作区。
 * 被占用的工作区不会强删，汇总提示里说明可稍后在命令面板中清理。
 */

/** 确认后执行清理；返回 true 表示已执行（无论是否部分失败） */
export async function runKeep(ctx: AppContext, view: BatchView, keepSessionId: string): Promise<boolean> {
  const b = view.batch;
  const keptIndex = b.indexes[keepSessionId];
  let previews;
  try {
    previews = await ctx.api.batch.preview(b.id, keepSessionId);
  } catch (e) {
    ctx.toast(ipcErrorText(e), 'error');
    return false;
  }
  const lines = previews.map(discardLine);
  const ok = await ctx.confirm({
    title: `保留方案 #${keptIndex}？`,
    message: previews.length
      ? `其余 ${previews.length} 个方案将结束会话并删除工作区与分支：\n${lines.join('\n')}`
      : '没有其他需要清理的方案',
    okText: '保留并清理其余',
  });
  if (!ok) return false;
  if (!await confirmDirty(ctx, previews)) return false;
  try {
    const results = await ctx.api.batch.keep(b.id, keepSessionId);
    const sum = cleanupSummary(results, keptIndex);
    ctx.toast(sum.text, sum.warn ? 'warning' : 'success');
    return true;
  } catch (e) {
    ctx.toast(ipcErrorText(e), 'error');
    return false;
  }
}

export async function runDiscardAll(ctx: AppContext, view: BatchView): Promise<boolean> {
  const b = view.batch;
  let previews;
  try {
    previews = await ctx.api.batch.preview(b.id);
  } catch (e) {
    ctx.toast(ipcErrorText(e), 'error');
    return false;
  }
  if (!previews.length) {
    ctx.toast('没有需要清理的方案', 'info');
    return false;
  }
  const ok = await ctx.confirm({
    title: `放弃「${b.label}」的全部方案？`,
    message: `全部 ${previews.length} 个方案将结束会话并删除工作区与分支：\n${previews.map(discardLine).join('\n')}`,
    okText: '全部放弃',
    danger: true,
  });
  if (!ok) return false;
  if (!await confirmDirty(ctx, previews)) return false;
  try {
    const results = await ctx.api.batch.discardAll(b.id);
    const sum = cleanupSummary(results);
    ctx.toast(sum.text, sum.warn ? 'warning' : 'success');
    return true;
  } catch (e) {
    ctx.toast(ipcErrorText(e), 'error');
    return false;
  }
}

/** 有未提交文件或未合并提交的方案需要二次确认 */
async function confirmDirty(ctx: AppContext, previews: Parameters<typeof dirtyPreviews>[0]): Promise<boolean> {
  const dirty = dirtyPreviews(previews);
  if (!dirty.length) return true;
  return ctx.confirm({
    title: '这些方案有未保存的改动',
    message: `${dirty.map(discardLine).join('\n')}\n删除后无法恢复，确定继续？`,
    okText: '仍然删除',
    danger: true,
  });
}
