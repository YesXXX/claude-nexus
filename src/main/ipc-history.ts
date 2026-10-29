import { ipcMain } from 'electron';
import type { SessionManager } from './session-manager';
import type { SessionRecordStore } from './session-record-store';
import { historyCwds } from '../shared/session-records';
import type { HistoryMeta } from '../shared/types';

/**
 * 历史面板专用的 IPC：概况（可用性、目录列表）、固定、清空。
 * 记录模块缺失时概况返回不可用，固定与清空不做任何事。
 */

export interface HistoryIpcDeps {
  manager: SessionManager;
  records?: SessionRecordStore;
}

const UNAVAILABLE = '会话记录模块未启用';

export function historyMeta(records: SessionRecordStore | undefined): HistoryMeta {
  if (!records) return { ok: false, reason: UNAVAILABLE, skipped: 0, total: 0, pinned: 0, cwds: [] };
  const st = records.status();
  const ended = records.all().filter(r => r.state === 'ended');
  const meta: HistoryMeta = {
    ok: st.ok, skipped: st.skipped, total: ended.length,
    pinned: ended.filter(r => r.pinned === true).length, cwds: historyCwds(ended),
  };
  if (st.reason) meta.reason = st.reason;
  return meta;
}

export function registerHistoryIpc(deps: HistoryIpcDeps): void {
  const { manager, records } = deps;
  ipcMain.handle('panel:history-meta', (): HistoryMeta => historyMeta(records));
  ipcMain.handle('panel:record-pin', (_e, id: unknown, pinned: unknown): boolean =>
    !!records && typeof id === 'string' && records.setPinned(id, pinned === true));
  // 清空只删已结束且不在会话列表里的记录；不碰工作区与对话记录
  ipcMain.handle('panel:records-clear', (_e, keepPinned: unknown): string[] =>
    records ? records.clear(keepPinned !== false, id => !!manager.getSession(id)) : []);
}
