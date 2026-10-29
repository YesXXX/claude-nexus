import type {
  EndKind, RecordPage, RecordQuery, RecordState, RestorePrompt, RestoreReason, ResumeSettings, Session, SessionRecord,
  SessionStatus,
} from './types';

/** 会话用过的 Claude 会话 id 最多保留这么多个（最新在末尾） */
export const CLAUDE_IDS_MAX = 20;

/** 记录格式版本：只在出现不兼容变化时递增 */
export const RECORD_VERSION = 1;

/** 历史清理的缺省阈值 */
export const DEFAULT_HISTORY_LIMITS = { historyMaxCount: 300, historyMaxDays: 90 } as const;

export interface HistoryLimits {
  historyMaxCount: number;
  historyMaxDays: number;
}

const QUERY_LIMIT_DEFAULT = 50;
const QUERY_LIMIT_MAX = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

const RECORD_STATES: readonly RecordState[] = ['live', 'exited', 'suspended', 'ended'];
export const END_KINDS: readonly EndKind[] = ['killed', 'error', 'quit', 'migrated'];
/** 记录里提示词的长度上限，与状态机事件的截断一致 */
const PROMPT_MAX = 2000;
const STATUSES: readonly SessionStatus[] = [
  'running', 'waiting_permission', 'waiting_input', 'completed', 'error', 'disconnected', 'suspended',
];

/**
 * 把新的 Claude 会话 id 追加到历史列表末尾：已存在则挪到末尾，超出上限时丢掉最旧的。
 * 返回新数组，不修改入参。
 */
export function appendClaudeId(list: readonly string[] | undefined, id: string): string[] {
  const next = (list ?? []).filter(x => x !== id);
  next.push(id);
  return next.length > CLAUDE_IDS_MAX ? next.slice(next.length - CLAUDE_IDS_MAX) : next;
}

/**
 * 记录状态迁移表。同状态之间的更新（只改字段）总是允许。
 * - live：进程退出 → exited；退出时保留或崩溃 → suspended；结束 → ended
 * - exited / suspended：续接或全新开始 → live；结束 → ended
 * - ended：从历史续接 → live
 */
const TRANSITIONS: Record<RecordState, readonly RecordState[]> = {
  live: ['exited', 'suspended', 'ended'],
  exited: ['live', 'ended'],
  suspended: ['live', 'ended'],
  ended: ['live'],
};

export function canTransitionRecord(from: RecordState, to: RecordState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function num(x: unknown, fallback: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

/**
 * 校验并补齐从磁盘读到的记录：版本不认识、缺 id 或 cwd 返回 null；
 * 其余缺失或类型不对的必填字段用安全的缺省值补上。不认识的字段原样保留。
 */
export function normalizeRecord(raw: unknown): SessionRecord | null {
  if (!isObject(raw)) return null;
  if (raw.version !== RECORD_VERSION) return null;
  if (typeof raw.id !== 'string' || !raw.id || typeof raw.cwd !== 'string' || !raw.cwd) return null;
  const createdAt = num(raw.createdAt, 0);
  const updatedAt = num(raw.updatedAt, createdAt);
  const ids = Array.isArray(raw.claudeSessionIds)
    ? raw.claudeSessionIds.filter((x): x is string => typeof x === 'string')
    : [];
  const rec = {
    ...raw,
    label: typeof raw.label === 'string' ? raw.label : '',
    createdAt,
    updatedAt,
    lastActiveAt: num(raw.lastActiveAt, updatedAt),
    state: RECORD_STATES.includes(raw.state as RecordState) ? raw.state : 'ended',
    lastStatus: STATUSES.includes(raw.lastStatus as SessionStatus) ? raw.lastStatus : 'disconnected',
    claudeSessionIds: ids,
    turns: num(raw.turns, 0),
    resumeCount: num(raw.resumeCount, 0),
  };
  return rec as unknown as SessionRecord;
}

/**
 * 记录里随会话变化的字段。缺失的字段显式给 undefined：patch 合并时据此删除旧值
 * （如全新开始后清掉的对话记录路径、续接成功后清掉的续接失败）。
 * 待续接行的 suspended 不是退出前的真实状态，不覆盖记录里的 lastStatus。
 */
export function recordFieldsFromSession(s: Session): Partial<SessionRecord> {
  const fields: Partial<SessionRecord> = {
    label: s.label,
    cwd: s.cwd,
    lastStatus: s.status,
    exitCode: s.exitCode,
    claudeSessionId: s.claudeSessionId,
    claudeSessionIds: s.claudeSessionIds ?? (s.claudeSessionId ? [s.claudeSessionId] : []),
    transcriptPath: s.claudeTranscriptPath,
    launch: s.launch,
    worktree: s.worktree,
    batchId: s.batchId,
    lastResumeFailure: s.resumeFailure,
  };
  if (s.status === 'suspended') delete fields.lastStatus;
  return fields;
}

/** 按会话生成一条新的 live 记录 */
export function newRecord(s: Session, now: number): SessionRecord {
  const rec: SessionRecord = {
    version: RECORD_VERSION,
    id: s.id,
    label: s.label,
    cwd: s.cwd,
    createdAt: s.createdAt,
    updatedAt: now,
    lastActiveAt: now,
    state: 'live',
    lastStatus: s.status,
    claudeSessionIds: [],
    turns: 0,
    resumeCount: 0,
  };
  return stripUndefined({ ...rec, ...recordFieldsFromSession(s) }) as SessionRecord;
}

/** 去掉值为 undefined 的键（写盘前与合并后使用） */
export function stripUndefined<T extends object>(obj: T): T {
  const out = { ...obj } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as T;
}

/** 路径比较用的规范形式：统一正斜杠、小写、去掉末尾斜杠 */
export function normalizePathKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function underRoot(p: string, root: string): boolean {
  const a = normalizePathKey(p);
  const b = normalizePathKey(root);
  return !!b && (a === b || a.startsWith(`${b}/`));
}

function matchesText(r: SessionRecord, text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [
    r.label, r.cwd, r.firstPrompt ?? '', r.lastPrompt ?? '', ...r.claudeSessionIds, r.claudeSessionId ?? '',
    r.worktree?.branch ?? '',
  ].map(h => h.toLowerCase());
  return words.every(w => hay.some(h => h.includes(w)));
}

/** 结束状态分类：退出码非零或最后状态为异常算异常退出，其余按结束原因归类 */
export function endKindOf(r: SessionRecord): EndKind {
  if (r.lastStatus === 'error' || (typeof r.exitCode === 'number' && r.exitCode !== 0)) return 'error';
  if (r.endReason === 'quit_end' || r.endReason === 'not_restored') return 'quit';
  if (r.endReason === 'migrated') return 'migrated';
  return 'killed';
}

/** 提交提示词时要写进记录的字段：首条只在缺失时补上，最近一条每次覆盖 */
export function promptFields(prev: SessionRecord | undefined, prompt: string): Partial<SessionRecord> {
  const p = prompt.slice(0, PROMPT_MAX);
  return prev?.firstPrompt ? { lastPrompt: p } : { firstPrompt: p, lastPrompt: p };
}

function sortKey(r: SessionRecord, sort: NonNullable<RecordQuery['sort']>): number {
  if (sort === 'created') return r.createdAt;
  if (sort === 'ended') return r.endedAt ?? 0;
  return r.lastActiveAt;
}

/**
 * 规范化来自渲染层的查询参数：丢掉类型不对的字段，limit 收在 1～200，offset 不小于 0。
 */
export function sanitizeQuery(raw: unknown): RecordQuery {
  const q: RecordQuery = {};
  if (!isObject(raw)) return q;
  if (Array.isArray(raw.states)) {
    const states = raw.states.filter((s): s is RecordState => RECORD_STATES.includes(s as RecordState));
    if (states.length > 0) q.states = states;
  }
  if (typeof raw.text === 'string' && raw.text.trim()) q.text = raw.text.trim().slice(0, 200);
  if (Array.isArray(raw.endKinds)) {
    const kinds = raw.endKinds.filter((k): k is EndKind => END_KINDS.includes(k as EndKind));
    if (kinds.length > 0) q.endKinds = kinds;
  }
  if (raw.pinnedFirst === true) q.pinnedFirst = true;
  if (typeof raw.cwd === 'string' && raw.cwd) q.cwd = raw.cwd;
  if (typeof raw.repoRoot === 'string' && raw.repoRoot) q.repoRoot = raw.repoRoot;
  if (typeof raw.since === 'number' && Number.isFinite(raw.since)) q.since = raw.since;
  if (typeof raw.until === 'number' && Number.isFinite(raw.until)) q.until = raw.until;
  if (raw.sort === 'lastActive' || raw.sort === 'created' || raw.sort === 'ended') q.sort = raw.sort;
  if (typeof raw.limit === 'number' && Number.isFinite(raw.limit)) q.limit = raw.limit;
  if (typeof raw.offset === 'number' && Number.isFinite(raw.offset)) q.offset = raw.offset;
  return q;
}

/** 在内存里按条件筛选、排序、分页；total 是分页前的命中总数 */
export function queryRecords(list: readonly SessionRecord[], q: RecordQuery = {}): RecordPage {
  const states = q.states && q.states.length > 0 ? q.states : ['ended'];
  const sort = q.sort ?? 'lastActive';
  const limit = Math.min(QUERY_LIMIT_MAX, Math.max(1, Math.floor(q.limit ?? QUERY_LIMIT_DEFAULT)));
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const cwdKey = q.cwd ? normalizePathKey(q.cwd) : null;
  const hits = list.filter(r => {
    if (!states.includes(r.state)) return false;
    if (q.text && !matchesText(r, q.text)) return false;
    if (q.endKinds && !q.endKinds.includes(endKindOf(r))) return false;
    if (cwdKey && normalizePathKey(r.cwd) !== cwdKey) return false;
    if (q.repoRoot) {
      const byWorktree = !!r.worktree && normalizePathKey(r.worktree.repoRoot) === normalizePathKey(q.repoRoot);
      if (!byWorktree && !underRoot(r.cwd, q.repoRoot)) return false;
    }
    if (q.since !== undefined && r.lastActiveAt < q.since) return false;
    if (q.until !== undefined && r.lastActiveAt > q.until) return false;
    return true;
  });
  const pin = (r: SessionRecord): number => (q.pinnedFirst && r.pinned === true ? 1 : 0);
  hits.sort((a, b) => pin(b) - pin(a) || sortKey(b, sort) - sortKey(a, sort) || b.createdAt - a.createdAt);
  return { items: hits.slice(offset, offset + limit), total: hits.length };
}

/**
 * 需要清理的记录 id：只看 ended 且未置顶（pinned）的记录。
 * 结束时间超过 historyMaxDays 天的删除；其余按结束时间倒序，超出 historyMaxCount 条的删除。
 */
export function pruneCandidates(list: readonly SessionRecord[], limits: HistoryLimits, now: number): string[] {
  const ended = list.filter(r => r.state === 'ended' && r.pinned !== true);
  const endTime = (r: SessionRecord): number => r.endedAt ?? r.updatedAt;
  const cutoff = now - limits.historyMaxDays * DAY_MS;
  const out = new Set<string>();
  const keep: SessionRecord[] = [];
  for (const r of ended) {
    if (endTime(r) < cutoff) out.add(r.id); else keep.push(r);
  }
  keep.sort((a, b) => endTime(b) - endTime(a));
  for (const r of keep.slice(Math.max(0, limits.historyMaxCount))) out.add(r.id);
  return [...out];
}

/** 已结束记录出现过的目录，按最近结束时间倒序去重（大小写与斜杠不同视为同一目录） */
export function historyCwds(list: readonly SessionRecord[]): string[] {
  const ended = list.filter(r => r.state === 'ended')
    .sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of ended) {
    const key = normalizePathKey(r.cwd);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r.cwd);
  }
  return out;
}

/** 启动时对一条未结束记录的处理 */
export interface DormantPlan {
  id: string;
  state: 'suspended' | 'exited';
  restoreReason?: RestoreReason;
}

/** 启动处理方案：哪些已认领、哪些以无进程行恢复、哪些转入历史、哪些自动续接、询问档横幅提示哪些 */
export interface StartupPlan {
  adopted: string[];
  dormant: DormantPlan[];
  /** 需要先把记录改成 suspended(crash) 的 id：上次面板崩溃，记录停在 live、进程已死 */
  crashed: string[];
  /** 不恢复档：待续接的记录转 ended(not_restored) */
  end: string[];
  autoResume: string[];
  prompt: RestorePrompt | null;
}

const REASON_PRIORITY: Record<RestoreReason, number> = { crash: 0, update: 1, quit: 2 };

/** 多个待续接原因时按 crash > update > quit 取最高的一个 */
export function pickRestoreReason(reasons: readonly RestoreReason[]): RestoreReason | null {
  let best: RestoreReason | null = null;
  for (const r of reasons) if (best === null || REASON_PRIORITY[r] < REASON_PRIORITY[best]) best = r;
  return best;
}

/**
 * 启动时按记录与设置决定每个会话的去向：
 * - 已认领（pid 仍存活）→ 保持 live；
 * - 记录停在 live 但没被认领（面板崩溃、进程已死）→ 视为 suspended(crash)；
 * - suspended：不恢复档转 ended(not_restored)；自动档全部自动续接；询问档里安装更新前保留的直接续接，其余进横幅；
 * - exited：以无进程行原样恢复，与退出前看到的列表一致；
 * - ended：不处理。
 */
export function startupDisposition(
  records: readonly SessionRecord[], adoptedIds: ReadonlySet<string>, onStartup: ResumeSettings['onStartup'],
): StartupPlan {
  const plan: StartupPlan = { adopted: [], dormant: [], crashed: [], end: [], autoResume: [], prompt: null };
  const promptIds: string[] = [];
  const promptReasons: RestoreReason[] = [];
  const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt);
  for (const r of sorted) {
    if (r.state === 'ended') continue;
    if (adoptedIds.has(r.id)) { plan.adopted.push(r.id); continue; }
    if (r.state === 'exited') { plan.dormant.push({ id: r.id, state: 'exited' }); continue; }
    const crashed = r.state === 'live';
    if (crashed) plan.crashed.push(r.id);
    const reason: RestoreReason = crashed ? 'crash' : r.restoreReason ?? 'quit';
    if (onStartup === 'never') { plan.end.push(r.id); continue; }
    plan.dormant.push({ id: r.id, state: 'suspended', restoreReason: reason });
    if (onStartup === 'auto' || reason === 'update') {
      plan.autoResume.push(r.id);
    } else {
      promptIds.push(r.id);
      promptReasons.push(reason);
    }
  }
  const reason = pickRestoreReason(promptReasons);
  if (reason) plan.prompt = { ids: promptIds, reason };
  return plan;
}

const EXITED_STATUSES: readonly SessionStatus[] = ['completed', 'error', 'disconnected'];

/**
 * 由记录构造跨重启恢复的无进程会话行：suspended 记录显示为待续接，exited 记录沿用退出时的状态
 * （记录里的状态不是退出类时按失联显示）。
 */
export function dormantSession(r: SessionRecord, plan: DormantPlan): Session {
  const status: SessionStatus = plan.state === 'suspended'
    ? 'suspended'
    : EXITED_STATUSES.includes(r.lastStatus) ? r.lastStatus : 'disconnected';
  const s: Session = {
    id: r.id, label: r.label, cwd: r.cwd, status,
    statusSince: r.updatedAt, createdAt: r.createdAt, escalated: false,
    exitCode: r.exitCode,
    claudeSessionId: r.claudeSessionId,
    claudeSessionIds: [...r.claudeSessionIds],
    claudeTranscriptPath: r.transcriptPath,
    launch: r.launch,
    worktree: r.worktree,
    batchId: r.batchId,
    resumeFailure: r.lastResumeFailure,
    restoreReason: plan.state === 'suspended' ? plan.restoreReason ?? r.restoreReason ?? 'quit' : undefined,
    dormant: true,
    dormantSince: r.updatedAt,
    turns: r.turns,
  };
  return stripUndefined(s);
}
