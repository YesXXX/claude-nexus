import type { BatchCreateResult, BatchDiscardPreview, BatchDiscardResult, BatchItemView, BatchRecord } from './batch-types';

/** 批次对比视图与新建表单共用的文案，纯函数，主进程与渲染层都可单测 */

/** 新建表单里「并行方案数」的取值：非数字按 1，超出 1～6 时夹到边界 */
export function clampBatchCount(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(6, Math.max(1, Math.floor(n)));
}

/** 批次状态文案：进行中 / 已保留 #i / 已结束 */
export function batchStatusText(b: BatchRecord): string {
  if (b.status === 'resolved') {
    const i = b.keptSessionId ? b.indexes[b.keptSessionId] : undefined;
    return i ? `已保留 #${i}` : '已保留';
  }
  return b.status === 'ended' ? '已结束' : '进行中';
}

/** 页头进度：「2/3 已完成首轮」 */
export function batchFirstTurnText(items: BatchItemView[]): string {
  return `${items.filter(i => i.turnsCompleted > 0).length}/${items.length} 已完成首轮`;
}

/** 单个将被丢弃方案的确认文案：未提交文件数与未合并提交数 */
export function discardLine(p: BatchDiscardPreview): string {
  const head = `#${p.index}`;
  if (!p.worktree) return `${head}：没有独立工作区，只结束会话`;
  if (!p.status) return `${head}：工作区状态读取失败，仍会删除`;
  const parts: string[] = [];
  if (p.status.dirtyFiles > 0) parts.push(`${p.status.dirtyFiles} 个未提交文件`);
  if (p.status.unmergedCommits > 0) parts.push(`${p.status.unmergedCommits} 个未合并提交`);
  return parts.length ? `${head}：${parts.join('，')}` : `${head}：没有未保存的改动`;
}

/** 将被丢弃的方案里有未提交文件或未合并提交的（需要再确认一次） */
export function dirtyPreviews(list: BatchDiscardPreview[]): BatchDiscardPreview[] {
  return list.filter(p => !!p.status && (p.status.dirtyFiles > 0 || p.status.unmergedCommits > 0));
}

/**
 * 保留 / 全部放弃后的汇总：「已保留 #2，清理 2 个方案（1 个工作区被占用，已保留）」。
 * 被占用的工作区留待命令面板清理；其他失败单独计数。
 */
export function cleanupSummary(results: BatchDiscardResult[], keptIndex?: number): { text: string; warn: boolean } {
  let busy = 0;
  let failed = 0;
  for (const r of results) {
    if (r.result.kept === 'busy') busy++;
    else if (!r.result.ok) failed++;
  }
  const notes: string[] = [];
  if (busy) notes.push(`${busy} 个工作区被占用，已保留，可稍后在命令面板中清理`);
  if (failed) notes.push(`${failed} 个清理失败`);
  const head = keptIndex !== undefined
    ? `已保留 #${keptIndex}，清理 ${results.length} 个方案`
    : `已放弃全部 ${results.length} 个方案`;
  return { text: notes.length ? `${head}（${notes.join('；')}）` : head, warn: busy + failed > 0 };
}

/** 派发结果提示：全部成功、部分失败（列出序号与原因）或全部失败 */
export function createSummary(r: BatchCreateResult, count: number): { text: string; level: 'success' | 'warning' | 'error' } {
  const errs = r.errors.map(e => `#${e.index}：${e.message}`).join('；');
  if (!r.errors.length) return { text: `已派发 ${count} 个方案`, level: 'success' };
  if (!r.sessions.length) return { text: `批量派发失败：${errs}`, level: 'error' };
  return { text: `已派发 ${r.sessions.length}/${count} 个方案，失败 ${errs}`, level: 'warning' };
}
