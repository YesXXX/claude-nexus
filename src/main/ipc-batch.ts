import { ipcMain } from 'electron';
import type { BatchManager } from './batch-manager';
import type {
  BatchCreateInput, BatchCreateResult, BatchDiscardPreview, BatchDiscardResult, BatchRecord, BatchView,
} from '../shared/batch-types';

/** 渲染层传入的派发参数：类型不对的字段按缺省处理，具体校验交给批次管理 */
export function asBatchCreateInput(v: unknown): BatchCreateInput {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const input: BatchCreateInput = {
    label: typeof o.label === 'string' ? o.label : '',
    cwd: typeof o.cwd === 'string' ? o.cwd.trim() : '',
    prompt: typeof o.prompt === 'string' ? o.prompt : '',
    count: typeof o.count === 'number' && Number.isFinite(o.count) ? o.count : 0,
  };
  if (typeof o.baseRef === 'string' && o.baseRef.trim()) input.baseRef = o.baseRef.trim();
  return input;
}

/** 批量派发的 IPC；创建进度只推给发起派发的窗口 */
export function registerBatchIpc(batches: BatchManager): void {
  ipcMain.handle('batch:create', async (e, v: unknown): Promise<BatchCreateResult> => {
    const input = asBatchCreateInput(v);
    if (!input.cwd) throw new Error('工作目录不能为空');
    return batches.create(input, p => {
      if (!e.sender.isDestroyed()) e.sender.send('batch:progress', p);
    });
  });
  ipcMain.handle('batch:list', (): BatchRecord[] => batches.list());
  ipcMain.handle('batch:view', (_e, id: unknown): Promise<BatchView | null> =>
    typeof id === 'string' ? batches.view(id) : Promise.resolve(null));
  ipcMain.handle('batch:preview', (_e, id: unknown, keepId: unknown): Promise<BatchDiscardPreview[]> =>
    typeof id === 'string' ? batches.preview(id, typeof keepId === 'string' ? keepId : undefined) : Promise.resolve([]));
  ipcMain.handle('batch:keep', (_e, id: unknown, sessionId: unknown): Promise<BatchDiscardResult[]> => {
    if (typeof id !== 'string' || typeof sessionId !== 'string') return Promise.reject(new Error('参数无效'));
    return batches.keep(id, sessionId);
  });
  ipcMain.handle('batch:discard-all', (_e, id: unknown): Promise<BatchDiscardResult[]> =>
    typeof id === 'string' ? batches.discardAll(id) : Promise.reject(new Error('参数无效')));
  ipcMain.handle('batch:forget', (_e, id: unknown): boolean => typeof id === 'string' && batches.forget(id));
}
