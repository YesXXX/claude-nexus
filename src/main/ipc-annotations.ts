import { ipcMain } from 'electron';
import type { AnnotationService } from './annotation-service';
import type { Annotation, AnnotationList, AnnotationPreview, OutboxWhen, SendResult } from '../shared/review-types';

/**
 * 批注 IPC：列表、增删改、发送预览、发送与取消排队。参数一律按 unknown 校验，
 * 路径与行范围由主进程按重新取的 diff 截取，不信任渲染层传来的内容。
 */
export function registerAnnotationIpc(service: AnnotationService): void {
  const sid = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const empty: AnnotationList = { items: [], checks: [] };

  ipcMain.handle('panel:annotations', (_e, id: unknown): AnnotationList => {
    const s = sid(id);
    return s ? service.list(s) : empty;
  });
  ipcMain.handle('panel:annotation-add', async (_e, id: unknown, draft: unknown): Promise<Annotation | { error: string }> => {
    const s = sid(id);
    if (!s || !draft || typeof draft !== 'object') return { error: '参数无效' };
    return service.add(s, draft as Parameters<AnnotationService['add']>[1]);
  });
  ipcMain.handle('panel:annotation-update', (_e, id: unknown, annId: unknown, comment: unknown): boolean => {
    const s = sid(id);
    const a = sid(annId);
    return !!s && !!a && service.update(s, a, comment);
  });
  ipcMain.handle('panel:annotation-remove', (_e, id: unknown, annId: unknown): boolean => {
    const s = sid(id);
    const a = sid(annId);
    return !!s && !!a && service.remove(s, a);
  });
  ipcMain.handle('panel:annotation-preview', async (_e, id: unknown): Promise<AnnotationPreview> => {
    const s = sid(id);
    if (!s) {
      return {
        text: '', truncated: false, count: 0, omitted: 0, stale: 0, blocked: '会话不存在',
        busy: false, waitingPermission: false, pasteMode: false, queued: false,
      };
    }
    return service.preview(s);
  });
  ipcMain.handle('panel:annotation-send', async (_e, id: unknown, opts: unknown): Promise<SendResult> => {
    const s = sid(id);
    const when = (opts as { when?: unknown } | null)?.when;
    const w: OutboxWhen = when === 'now' || when === 'queue' ? when : 'auto';
    if (!s) return { ok: false, sent: false, queued: false, message: '会话不存在' };
    return service.send(s, w);
  });
  ipcMain.handle('panel:outbox-cancel', (_e, id: unknown): boolean => {
    const s = sid(id);
    return !!s && service.cancel(s);
  });
}
