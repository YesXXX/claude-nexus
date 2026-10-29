import { ipcMain } from 'electron';
import type { FileRevert, RevertResult } from './file-revert';
import type { DiffMode } from '../shared/types';
import type { GitOpResult, RevertEntry, RevertPlan } from '../shared/review-types';

/**
 * 撤销 IPC：撤销前的确认信息、撤销、最近一次撤销、恢复。参数一律按 unknown 校验，
 * 路径走 ChangeTracker 白名单，备份 id 只允许安全字符，渲染层传来的命令一概不用。
 */
export function registerRevertIpc(revert: FileRevert): void {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const mode = (v: unknown): DiffMode | undefined => (v === 'working' || v === 'base' ? v : undefined);
  const flag = (o: unknown, k: string): boolean => !!o && typeof o === 'object' && (o as Record<string, unknown>)[k] === true;
  const bad = (message: string): GitOpResult => ({ ok: false, message, steps: [] });

  ipcMain.handle('panel:revert-plan', async (_e, id: unknown, p: unknown, m: unknown): Promise<RevertPlan> => {
    const s = str(id);
    const rel = str(p);
    if (!s || !rel) return { command: '', paths: [], source: '', untracked: false, largeBytes: 0, blocked: '参数无效', busy: false };
    return revert.plan(s, rel, mode(m));
  });
  ipcMain.handle('panel:revert-file', async (_e, id: unknown, p: unknown, m: unknown, opts: unknown): Promise<RevertResult> => {
    const s = str(id);
    const rel = str(p);
    if (!s || !rel) return bad('参数无效');
    return revert.revert(s, rel, mode(m), { force: flag(opts, 'force'), large: flag(opts, 'large') });
  });
  ipcMain.handle('panel:revert-last', (_e, id: unknown): RevertEntry | null => {
    const s = str(id);
    return s ? revert.last(s) : null;
  });
  ipcMain.handle('panel:revert-restore', async (_e, id: unknown, entryId: unknown, opts: unknown): Promise<GitOpResult> => {
    const s = str(id);
    const e = str(entryId);
    if (!s || !e) return bad('参数无效');
    return revert.restore(s, e, { overwrite: flag(opts, 'overwrite'), force: flag(opts, 'force') });
  });
}
