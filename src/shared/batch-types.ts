import type { ChangedFile, ChangeSummary, KillResult, Session, SessionStatus, WorktreeInfo, WorktreeStatus } from './types';
import type { VerifySummary } from './verify-types';

/** 一次派发的方案数范围：至少 2 个才有比较意义，最多 6 列 */
export const BATCH_MIN = 2;
export const BATCH_MAX = 6;
/** 对比视图每个方案列出的文件数 */
export const BATCH_TOP_FILES = 8;

export type BatchStatus = 'active' | 'resolved' | 'ended';

/** 批次内单个方案的运行统计（由一轮结束事件累计） */
export interface BatchItemStats {
  turns: number;
  lastTurnAt?: number;
}

export interface BatchRecord {
  id: string;
  label: string;
  prompt: string;
  cwd: string;
  repoRoot: string;
  baseRef: string;
  baseCommit: string;
  /** 按方案序号排列（#1 在前），创建失败的序号不占位 */
  sessionIds: string[];
  /** 会话 id → 方案序号（从 1 开始，与标签里的 #i 一致） */
  indexes: Record<string, number>;
  stats: Record<string, BatchItemStats>;
  createdAt: number;
  status: BatchStatus;
  keptSessionId?: string;
  /** 转为 resolved / ended 的时间，过期清理按它计算 */
  endedAt?: number;
}

export interface BatchItemView {
  sessionId: string;
  index: number;
  label: string;
  alive: boolean;
  status?: SessionStatus;
  durationMs: number;
  /** 本批次内已完成的轮数，首轮完成即可比较 */
  turnsCompleted: number;
  worktree?: WorktreeInfo;
  /** 相对基线口径 */
  changes?: ChangeSummary;
  /** 改动行数最多的前几个文件 */
  topFiles: ChangedFile[];
  verify?: VerifySummary;
  error?: string;
}

export interface BatchView { batch: BatchRecord; items: BatchItemView[] }

export interface BatchCreateInput {
  label: string;
  cwd: string;
  prompt: string;
  count: number;
  baseRef?: string;
}

export interface BatchCreateResult {
  batch?: BatchRecord;
  sessions: Session[];
  errors: Array<{ index: number; message: string }>;
}

/** 丢弃前的确认信息：每个将被丢弃的方案的工作区状态 */
export interface BatchDiscardPreview {
  sessionId: string;
  index: number;
  label: string;
  alive: boolean;
  worktree?: WorktreeInfo;
  status?: WorktreeStatus;
}

export interface BatchDiscardResult {
  sessionId: string;
  index: number;
  result: KillResult;
}

/** 创建进度推送 */
export interface BatchProgress { done: number; total: number; label: string }

/** 方案标签：`<任务> #i` */
export function batchItemLabel(label: string, index: number): string {
  return `${label} #${index}`;
}

/** 改动行数最多的前 n 个文件（二进制与无法统计的按 0 计），同数时按路径排序保证稳定 */
export function topChangedFiles(files: ChangedFile[], n = BATCH_TOP_FILES): ChangedFile[] {
  const weight = (f: ChangedFile): number => (f.additions ?? 0) + (f.deletions ?? 0);
  return [...files].sort((a, b) => weight(b) - weight(a) || a.path.localeCompare(b.path)).slice(0, n);
}

/** 已完成首轮的方案数 */
export function batchFirstTurnDone(items: BatchItemView[]): number {
  return items.filter(i => i.turnsCompleted > 0).length;
}

/** 批次是否可以直接删除记录（仍在进行的批次不行） */
export function batchForgettable(b: BatchRecord): boolean {
  return b.status !== 'active';
}

/** 校验批次文件里的单条记录；缺失的统计字段补默认值，不合法返回 null */
export function normalizeBatch(raw: unknown): BatchRecord | null {
  const r = raw as Partial<BatchRecord> | null;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.id !== 'string' || !r.id || typeof r.label !== 'string' || typeof r.cwd !== 'string') return null;
  if (!Array.isArray(r.sessionIds)) return null;
  const sessionIds = r.sessionIds.filter((x): x is string => typeof x === 'string' && !!x);
  const indexes: Record<string, number> = {};
  sessionIds.forEach((sid, i) => {
    const v = r.indexes?.[sid];
    indexes[sid] = typeof v === 'number' && v > 0 ? v : i + 1;
  });
  const stats: Record<string, BatchItemStats> = {};
  for (const sid of sessionIds) {
    const st = r.stats?.[sid];
    stats[sid] = {
      turns: typeof st?.turns === 'number' && st.turns >= 0 ? st.turns : 0,
      ...(typeof st?.lastTurnAt === 'number' ? { lastTurnAt: st.lastTurnAt } : {}),
    };
  }
  const status: BatchStatus = r.status === 'resolved' || r.status === 'ended' ? r.status : 'active';
  const rec: BatchRecord = {
    id: r.id, label: r.label, prompt: typeof r.prompt === 'string' ? r.prompt : '', cwd: r.cwd,
    repoRoot: typeof r.repoRoot === 'string' ? r.repoRoot : r.cwd,
    baseRef: typeof r.baseRef === 'string' ? r.baseRef : '',
    baseCommit: typeof r.baseCommit === 'string' ? r.baseCommit : '',
    sessionIds, indexes, stats,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    status,
  };
  if (typeof r.keptSessionId === 'string' && sessionIds.includes(r.keptSessionId)) rec.keptSessionId = r.keptSessionId;
  if (typeof r.endedAt === 'number') rec.endedAt = r.endedAt;
  return rec;
}
