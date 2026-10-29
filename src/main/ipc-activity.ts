import { ipcMain } from 'electron';
import { ACTIVITY_TYPES, type ActivityPush, type ActivityQuery, type ActivityType } from '../shared/activity';
import type { ActivityLog } from './activity-log';

/**
 * 活动时间线的 IPC：分页查询、会话列表、清空，以及 250ms 合并一批的增量推送。
 * 渲染层传入的查询条件逐项校验，非法字段直接忽略。
 */

export interface ActivityIpcDeps {
  log: ActivityLog;
  /** 推送增量；窗口不可用或正在退出时由调用方丢弃 */
  push: (p: ActivityPush) => void;
}

const TYPE_SET = new Set<string>(ACTIVITY_TYPES);

/** 渲染层查询条件的清洗：只保留认识的字段与取值 */
export function sanitizeActivityQuery(raw: unknown): ActivityQuery {
  const q: ActivityQuery = {};
  if (!raw || typeof raw !== 'object') return q;
  const r = raw as Record<string, unknown>;
  if (typeof r.beforeSeq === 'number' && Number.isFinite(r.beforeSeq)) q.beforeSeq = r.beforeSeq;
  if (typeof r.limit === 'number' && Number.isFinite(r.limit)) q.limit = r.limit;
  if (Array.isArray(r.sessionIds)) {
    const ids = r.sessionIds.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 80).slice(0, 50);
    if (ids.length > 0) q.sessionIds = ids;
  }
  if (Array.isArray(r.types)) {
    const types = r.types.filter((x): x is ActivityType => typeof x === 'string' && TYPE_SET.has(x));
    if (types.length > 0) q.types = types;
  }
  if (r.attentionOnly === true) q.attentionOnly = true;
  return q;
}

export function registerActivityIpc(deps: ActivityIpcDeps): () => void {
  const { log } = deps;
  ipcMain.handle('activity:query', (_e, q: unknown) => log.query(sanitizeActivityQuery(q)));
  ipcMain.handle('activity:sessions', () => log.sessions());
  ipcMain.handle('activity:clear', () => { log.clear(); return true; });
  return log.subscribe(p => deps.push(p));
}
