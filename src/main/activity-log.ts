import {
  DATA_MAX_BYTES, DETAIL_MAX, TITLE_MAX, defaultActivityLevel, describeActivity, isActivityLevel, isActivityType,
  matchesActivityQuery,
  type ActivityEvent, type ActivityInput, type ActivityPush, type ActivityQuery, type ActivityQueryResult,
  type ActivityReporter, type ActivitySessionInfo, type ActivityType,
} from '../shared/activity';
import { redact } from '../shared/redact';
import { ActivityFileStore } from './activity-store';
import { log } from './logger';

/**
 * 活动日志：主进程里有上限的环形事件记录，是全部活动事件的唯一入口。
 * - report 校验并规范化输入（未知类型、缺来源丢弃；标题与详情打码截断；data 过大丢弃），不抛错。
 * - 工具调用在这里合并成 tool.batch 并原地更新（rev 递增），避免高频工具事件挤占环形容量。
 * - 订阅者按 250ms 批量收到 upsert（同 id 只留最新版本）；watch 回调则在每次写入时同步触发。
 * - 落盘为追加写 JSONL，500ms 防抖；行数超过上限两倍或文件超过 8MB 时整体重写压缩。
 */

export const ACTIVITY_MAX_EVENTS = 5000;
export const ACTIVITY_MAX_AGE_MS = 14 * 24 * 3600_000;
export const DEDUPE_WINDOW_MS = 60_000;
export const BATCH_GAP_MS = 5 * 60_000;
export const BATCH_MAX_COUNT = 200;
export const BATCH_RECENT = 3;
export const PUSH_DELAY_MS = 250;
export const WRITE_DELAY_MS = 500;
export const COMPACT_BYTES = 8 * 1024 * 1024;
export const QUERY_DEFAULT_LIMIT = 200;
export const QUERY_MAX_LIMIT = 500;

/** 上报时取会话的快照：名字与目录随事件保存，会话结束后时间线仍能显示 */
export interface ActivitySessionSnapshot {
  label?: string;
  cwd?: string;
  alive?: boolean;
}

export interface ActivityLogOptions {
  /** JSONL 文件路径；null 或缺省时只在内存运行 */
  file?: string | null;
  describeSession?: (id: string) => ActivitySessionSnapshot | undefined;
  now?: () => number;
  maxEvents?: number;
  maxAgeMs?: number;
  pushDelayMs?: number;
  writeDelayMs?: number;
  compactBytes?: number;
}

interface ToolBatchData {
  count: number;
  tools: Record<string, number>;
  recent: string[];
  lastAt: number;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 路径末段（兼容两种分隔符） */
export function cwdTail(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || undefined;
}

/** data 里的字符串一律打码截断；只保留可序列化的普通值，嵌套最多 4 层、数组最多 20 项 */
function sanitizeData(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return redact(v, DETAIL_MAX);
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean' || v === null) return v;
  if (depth >= 4 || typeof v !== 'object') return undefined;
  if (Array.isArray(v)) return v.slice(0, 20).map(x => sanitizeData(x, depth + 1)).filter(x => x !== undefined);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const s = sanitizeData(x, depth + 1);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

/** 工具计数 → 「Edit×5 Bash×4」，按次数降序 */
export function toolCountsText(tools: Record<string, number>): string {
  return Object.entries(tools).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' ');
}

export class ActivityLog implements ActivityReporter {
  private list: ActivityEvent[] = [];
  private readonly byId = new Map<string, ActivityEvent>();
  private seq = 0;
  /** 各会话当前打开的 tool.batch 事件 id */
  private readonly openBatch = new Map<string, string>();
  private readonly dedupe = new Map<string, number>();
  private readonly listeners = new Set<(p: ActivityPush) => void>();
  private readonly watchers = new Set<(e: ActivityEvent, fresh: boolean) => void>();
  private readonly pushQueue = new Map<string, ActivityEvent>();
  private pushCleared = false;
  private pushTimer: NodeJS.Timeout | null = null;
  private readonly writeQueue = new Map<string, ActivityEvent>();
  private writeTimer: NodeJS.Timeout | null = null;
  private readonly store: ActivityFileStore | null;
  private readonly now: () => number;
  private readonly max: number;
  private readonly maxAge: number;

  constructor(private readonly opts: ActivityLogOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.max = opts.maxEvents ?? ACTIVITY_MAX_EVENTS;
    this.maxAge = opts.maxAgeMs ?? ACTIVITY_MAX_AGE_MS;
    this.store = opts.file ? new ActivityFileStore(opts.file, this.now) : null;
    if (this.store) this.load(this.store);
  }

  private load(store: ActivityFileStore): void {
    const r = store.load();
    const cutoff = this.now() - this.maxAge;
    const kept = r.events.filter(e => e.at >= cutoff).slice(-this.max);
    this.list = kept;
    for (const e of kept) this.byId.set(e.id, e);
    this.seq = r.events.reduce((m, e) => Math.max(m, e.seq), 0);
    if (r.lines > 0 || r.skipped > 0) {
      log('activity', `载入活动日志 ${kept.length} 条（文件 ${r.lines} 行，跳过损坏 ${r.skipped} 行，淘汰 ${r.events.length - kept.length} 条）`);
    }
    const needCompact = r.skipped > 0 || kept.length < r.events.length
      || r.lines > this.max * 2 || store.bytes > (this.opts.compactBytes ?? COMPACT_BYTES);
    if (needCompact) store.rewrite(this.list);
  }

  /** 统一上报入口：校验、去重、规范化后写入；被丢弃时返回 null，从不抛错 */
  report(input: ActivityInput): ActivityEvent | null {
    try {
      return this.ingest(input);
    } catch (err) {
      log('activity', `上报处理出错，已丢弃：${String(err)}`);
      return null;
    }
  }

  private ingest(input: ActivityInput): ActivityEvent | null {
    if (typeof input !== 'object' || input === null) {
      log('activity', '丢弃非法上报：输入不是对象');
      return null;
    }
    if (!isActivityType(input.type)) {
      log('activity', `丢弃非法上报：未知类型 ${String((input as { type?: unknown }).type).slice(0, 40)}`);
      return null;
    }
    if (typeof input.source !== 'string' || !input.source.trim()) {
      log('activity', `丢弃非法上报：${input.type} 缺少 source`);
      return null;
    }
    const sessionId = typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : undefined;
    const now = this.now();
    const at = typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : now;
    if (typeof input.dedupeKey === 'string' && input.dedupeKey) {
      const key = `${sessionId ?? '*'}\u0000${input.dedupeKey}`;
      const last = this.dedupe.get(key);
      if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return null;
      this.dedupe.set(key, now);
      if (this.dedupe.size > 1000) this.pruneDedupe(now);
    }
    const data = this.normalizeData(input);
    const level = isActivityLevel(input.level) ? input.level : defaultActivityLevel(input.type, data);
    const rawTitle = typeof input.title === 'string' ? oneLine(input.title) : '';
    const title = redact(rawTitle || describeActivity(input.type, data), TITLE_MAX);
    const rawDetail = typeof input.detail === 'string' ? oneLine(input.detail) : '';
    const detail = rawDetail ? redact(rawDetail, DETAIL_MAX) : undefined;
    // 任一非工具事件都结束该会话正在合并的工具调用
    if (sessionId && input.type !== 'tool.batch') this.openBatch.delete(sessionId);
    const e = this.build(input.type, input.source.trim().slice(0, 40), at, level, title, {
      sessionId, detail, data,
      agentId: typeof input.agentId === 'string' && input.agentId ? input.agentId.slice(0, 80) : undefined,
    });
    this.insert(e);
    return e;
  }

  private normalizeData(input: ActivityInput): object | undefined {
    if (input.data === undefined || input.data === null) return undefined;
    if (typeof input.data !== 'object' || Array.isArray(input.data)) {
      log('activity', `${input.type} 的 data 不是对象，已去除`);
      return undefined;
    }
    const data = sanitizeData(input.data) as object;
    let size = Infinity;
    try { size = Buffer.byteLength(JSON.stringify(data)); } catch { /* 无法序列化按超限处理 */ }
    if (size > DATA_MAX_BYTES) {
      log('activity', `${input.type} 的 data 超过 ${DATA_MAX_BYTES} 字节（${size}），已去除`);
      return undefined;
    }
    return data;
  }

  private pruneDedupe(now: number): void {
    for (const [k, t] of this.dedupe) if (now - t >= DEDUPE_WINDOW_MS) this.dedupe.delete(k);
  }

  private build(
    type: ActivityType, source: string, at: number, level: ActivityEvent['level'], title: string,
    extra: { sessionId?: string; agentId?: string; detail?: string; data?: object },
  ): ActivityEvent {
    const seq = ++this.seq;
    const e: ActivityEvent = { id: `${at.toString(36)}-${seq.toString(36)}`, seq, rev: 1, at, updatedAt: at, type, level, source, title };
    if (extra.sessionId) {
      e.sessionId = extra.sessionId;
      const snap = this.snapshot(extra.sessionId);
      if (snap.label) e.sessionLabel = snap.label;
      if (snap.cwdTail) e.cwdTail = snap.cwdTail;
    }
    if (extra.agentId) e.agentId = extra.agentId;
    if (extra.detail) e.detail = extra.detail;
    if (extra.data) e.data = extra.data;
    return e;
  }

  /** 会话名字与目录：优先取当前会话，取不到时沿用该会话最近一条事件里记下的 */
  private snapshot(sessionId: string): { label?: string; cwdTail?: string } {
    let snap: ActivitySessionSnapshot | undefined;
    try { snap = this.opts.describeSession?.(sessionId); } catch { snap = undefined; }
    if (snap?.label || snap?.cwd) {
      return { label: snap.label ? redact(oneLine(snap.label), 60) : undefined, cwdTail: cwdTail(snap.cwd) };
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.sessionId === sessionId && e.sessionLabel) return { label: e.sessionLabel, cwdTail: e.cwdTail };
    }
    return {};
  }

  private insert(e: ActivityEvent): void {
    this.list.push(e);
    this.byId.set(e.id, e);
    const cutoff = this.now() - this.maxAge;
    while (this.list.length > this.max || (this.list.length > 0 && this.list[0].at < cutoff)) {
      const old = this.list.shift()!;
      this.byId.delete(old.id);
      if (old.sessionId && this.openBatch.get(old.sessionId) === old.id) this.openBatch.delete(old.sessionId);
    }
    this.emit(e, true);
  }

  /** 原地替换已有事件（rev 已由调用方递增） */
  private replace(e: ActivityEvent): void {
    let lo = 0;
    let hi = this.list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = this.list[mid].seq;
      if (s === e.seq) { this.list[mid] = e; break; }
      if (s < e.seq) lo = mid + 1; else hi = mid - 1;
    }
    this.byId.set(e.id, e);
    this.emit(e, false);
  }

  /**
   * 记一次工具调用：并入该会话打开的 tool.batch（计数、各工具次数、最近 3 条摘要），
   * 距上次调用超过 5 分钟或已满 200 次时另起一条。
   */
  recordTool(sessionId: string, toolName: string | undefined, summary?: string, at?: number): ActivityEvent | null {
    try {
      const now = typeof at === 'number' ? at : this.now();
      const tool = oneLine(toolName || '工具').slice(0, 60) || '工具';
      const brief = summary ? oneLine(summary) : '';
      const line = redact(brief ? `${tool}：${brief}` : tool, DETAIL_MAX);
      const openId = this.openBatch.get(sessionId);
      const open = openId ? this.byId.get(openId) : undefined;
      const od = open?.data as ToolBatchData | undefined;
      if (open && od && now - od.lastAt <= BATCH_GAP_MS && od.count < BATCH_MAX_COUNT) {
        const data: ToolBatchData = {
          count: od.count + 1,
          tools: { ...od.tools, [tool]: (od.tools[tool] ?? 0) + 1 },
          recent: [...od.recent, line].slice(-BATCH_RECENT),
          lastAt: now,
        };
        const next: ActivityEvent = {
          ...open, rev: open.rev + 1, updatedAt: now, data,
          title: describeActivity('tool.batch', data), detail: redact(toolCountsText(data.tools), DETAIL_MAX),
        };
        if (data.count >= BATCH_MAX_COUNT) this.openBatch.delete(sessionId);
        this.replace(next);
        return next;
      }
      const data: ToolBatchData = { count: 1, tools: { [tool]: 1 }, recent: [line], lastAt: now };
      const e = this.build('tool.batch', 'session', now, 'info', describeActivity('tool.batch', data), {
        sessionId, data, detail: redact(toolCountsText(data.tools), DETAIL_MAX),
      });
      this.insert(e);
      this.openBatch.set(sessionId, e.id);
      return e;
    } catch (err) {
      log('activity', `记录工具调用出错：${String(err)}`);
      return null;
    }
  }

  /** 结束会话正在合并的工具调用（之后的工具调用另起一条） */
  closeToolBatch(sessionId: string): void {
    this.openBatch.delete(sessionId);
  }

  private emit(e: ActivityEvent, fresh: boolean): void {
    for (const w of this.watchers) {
      try { w(e, fresh); } catch (err) { log('activity', `活动观察者出错：${String(err)}`); }
    }
    if (this.listeners.size > 0) {
      this.pushQueue.set(e.id, e);
      this.schedulePush();
    }
    if (this.store) {
      this.writeQueue.set(e.id, e);
      this.scheduleWrite();
    }
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => { this.pushTimer = null; this.flushPush(); }, this.opts.pushDelayMs ?? PUSH_DELAY_MS);
    this.pushTimer.unref?.();
  }

  /** 立即把排队的 upsert 推给订阅者 */
  flushPush(): void {
    if (this.pushTimer) { clearTimeout(this.pushTimer); this.pushTimer = null; }
    if (this.pushQueue.size === 0 && !this.pushCleared) return;
    const push: ActivityPush = { upserts: [...this.pushQueue.values()].sort((a, b) => a.seq - b.seq) };
    if (this.pushCleared) push.cleared = true;
    this.pushQueue.clear();
    this.pushCleared = false;
    for (const l of this.listeners) {
      try { l(push); } catch (err) { log('activity', `活动订阅者出错：${String(err)}`); }
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => { this.writeTimer = null; this.flushSync(); }, this.opts.writeDelayMs ?? WRITE_DELAY_MS);
    this.writeTimer.unref?.();
  }

  /** 同步落盘排队中的事件（退出前调用）；必要时整体重写压缩 */
  flushSync(): void {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    const store = this.store;
    if (!store || this.writeQueue.size === 0) return;
    const events = [...this.writeQueue.values()].sort((a, b) => a.seq - b.seq);
    this.writeQueue.clear();
    store.append(events);
    if (store.lines > this.max * 2 || store.bytes > (this.opts.compactBytes ?? COMPACT_BYTES)) {
      if (store.rewrite(this.list)) log('activity', `活动日志已压缩为 ${this.list.length} 条`);
    }
  }

  /** 订阅批量推送，返回取消函数 */
  subscribe(cb: (p: ActivityPush) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** 每次新增（fresh 为真）或原地更新事件时同步回调，供通知等需要即时响应的模块使用 */
  watch(cb: (e: ActivityEvent, fresh: boolean) => void): () => void {
    this.watchers.add(cb);
    return () => { this.watchers.delete(cb); };
  }

  /** 按 seq 倒序分页查询 */
  query(q: ActivityQuery = {}): ActivityQueryResult {
    const limit = Math.min(QUERY_MAX_LIMIT, Math.max(1, Math.floor(Number(q.limit) || QUERY_DEFAULT_LIMIT)));
    const before = typeof q.beforeSeq === 'number' && Number.isFinite(q.beforeSeq) ? q.beforeSeq : Infinity;
    const out: ActivityEvent[] = [];
    let hasMore = false;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.seq >= before || !matchesActivityQuery(e, q)) continue;
      if (out.length >= limit) { hasMore = true; break; }
      out.push(e);
    }
    const latestSeq = this.list.length > 0 ? this.list[this.list.length - 1].seq : 0;
    return { events: out, hasMore, latestSeq };
  }

  /** 日志里出现过的会话，按最近事件倒序 */
  sessions(): ActivitySessionInfo[] {
    const seen = new Map<string, string>();
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (!e.sessionId || seen.has(e.sessionId)) continue;
      seen.set(e.sessionId, e.sessionLabel ?? e.sessionId.slice(0, 8));
    }
    return [...seen].map(([id, label]) => {
      let alive = false;
      try { alive = this.opts.describeSession?.(id)?.alive === true; } catch { alive = false; }
      return { id, label, alive };
    });
  }

  /** 清空全部事件（含磁盘），订阅者收到 cleared 推送 */
  clear(): void {
    this.list = [];
    this.byId.clear();
    this.openBatch.clear();
    this.dedupe.clear();
    this.writeQueue.clear();
    this.store?.rewrite([]);
    this.pushQueue.clear();
    this.pushCleared = true;
    if (this.listeners.size > 0) this.schedulePush();
    log('activity', '活动日志已清空');
  }

  get size(): number {
    return this.list.length;
  }

  get(id: string): ActivityEvent | undefined {
    return this.byId.get(id);
  }

  dispose(): void {
    this.flushSync();
    if (this.pushTimer) { clearTimeout(this.pushTimer); this.pushTimer = null; }
    this.listeners.clear();
    this.watchers.clear();
  }
}
