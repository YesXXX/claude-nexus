import { ipcMain } from 'electron';
import { asLineNumber, openChangedPath } from './ipc';
import { launchEditorAt } from './editor-launch';
import { safeId } from './revert-backup';
import type { SessionChanges } from './session-changes';
import type { SessionRevert } from './session-revert';
import type { RevertResult } from './file-revert';
import type { FileDiff } from '../shared/types';
import type { SessionChangeList } from '../shared/session-change-types';
import type { GitOpResult, RevertEntry, RevertPlan } from '../shared/review-types';

/**
 * 本会话改动 IPC：列表、单文件对比、打开 / 定位、撤销与恢复、清除记录。参数一律按 unknown 校验，
 * 文件路径必须是该会话改动集里的完整地址（由 SessionChanges 校验），渲染层借此读写不到任意文件。
 */
export function registerSessionChangesIpc(deps: {
  changes: SessionChanges;
  revert: SessionRevert;
  exists: (id: string) => boolean;
  /** 外部编辑器命令（空串为未配置）；带行号打开时使用 */
  editor?: { command(): string };
}): void {
  const { changes, revert } = deps;
  const sid = (v: unknown): string | undefined => (safeId(v) && deps.exists(v) ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const flag = (o: unknown, k: string): boolean => !!o && typeof o === 'object' && (o as Record<string, unknown>)[k] === true;
  const bad = (message: string): GitOpResult => ({ ok: false, message, steps: [] });

  ipcMain.handle('panel:session-changes', async (_e, id: unknown): Promise<SessionChangeList> => {
    const s = sid(id);
    if (!s) throw new Error('会话不存在');
    return changes.list(s);
  });
  ipcMain.handle('panel:session-changes-clear', async (_e, id: unknown): Promise<{ removed: number }> => {
    const s = sid(id);
    if (!s) return { removed: 0 };
    return changes.clearAll(s);
  });
  ipcMain.handle('panel:session-changes-dismiss', async (_e, id: unknown, paths: unknown): Promise<{ removed: number }> => {
    const s = sid(id);
    if (!s || !Array.isArray(paths) || paths.length > 1000
      || !paths.every(p => typeof p === 'string' && !!p)) return { removed: 0 };
    return changes.dismiss(s, paths as string[]);
  });
  ipcMain.handle('panel:session-changes-dismiss-root', async (
    _e, id: unknown, root: unknown, outside: unknown,
  ): Promise<{ removed: number }> => {
    const s = sid(id);
    if (!s || typeof root !== 'string' || !root) return { removed: 0 };
    return changes.dismissRoot(s, root, outside === true);
  });
  ipcMain.handle('panel:session-file-diff', async (_e, id: unknown, p: unknown, ignoreWs: unknown): Promise<FileDiff> => {
    const s = sid(id);
    if (!s) return { path: str(p) ?? '', binary: false, truncated: false, hunks: [], error: '会话不存在' };
    return changes.fileDiff(s, p, { ignoreWs: ignoreWs === true });
  });
  ipcMain.handle('panel:session-open-path', async (
    _e, id: unknown, p: unknown, reveal: unknown, line: unknown,
  ): Promise<string> => {
    const s = sid(id);
    const e = s ? changes.entry(s, p) : undefined;
    if (!e) return '文件不在本会话改动中';
    const ln = asLineNumber(line);
    if (ln !== undefined && reveal !== true && deps.editor) {
      const err = await launchEditorAt(deps.editor.command(), e.abs, ln);
      if (err !== '') return err;
    }
    return openChangedPath(e.abs, reveal === true);
  });
  ipcMain.handle('panel:session-revert-plan', async (_e, id: unknown, p: unknown): Promise<RevertPlan> => {
    const s = sid(id);
    if (!s) return { command: '', paths: [], source: '', untracked: false, largeBytes: 0, blocked: '会话不存在', busy: false };
    return revert.plan(s, p);
  });
  ipcMain.handle('panel:session-revert-file', async (_e, id: unknown, p: unknown, opts: unknown): Promise<RevertResult> => {
    const s = sid(id);
    if (!s) return bad('会话不存在');
    return revert.revert(s, p, { force: flag(opts, 'force'), large: flag(opts, 'large') });
  });
  ipcMain.handle('panel:session-revert-last', (_e, id: unknown): RevertEntry | null => {
    const s = sid(id);
    return s ? revert.last(s) : null;
  });
  ipcMain.handle('panel:session-revert-restore', async (_e, id: unknown, entryId: unknown, opts: unknown): Promise<GitOpResult> => {
    const s = sid(id);
    const e = str(entryId);
    if (!s || !e) return bad('参数无效');
    return revert.restore(s, e, { overwrite: flag(opts, 'overwrite'), force: flag(opts, 'force') });
  });
}
