import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import { UsageStore } from './usage-store';
import type { FileKind, FileState, Ledger } from './usage-store';
import { readIncrement } from './usage-reader';
import type { ReadResult } from './usage-reader';
import { applyParsed, revertFile } from './usage-accounting';
import { isUnderTranscriptRoot, locateTranscript } from './claude-paths';
import { buildSummary, pickMain } from './usage-report';
import type { ReportContext, SessionFiles } from './usage-report';
import { contextAlert, deliverAlert } from './usage-alerts';
import type { AlertNotify } from './usage-alerts';
import type { ActivityReporter } from '../shared/activity';
import type { HookMessage, Session } from '../shared/types';
import type { SessionUsageSummary, SetUsageSettingsResult, UsageSettings } from '../shared/usage-types';
import { isBrokenUsefulLine, localDateOf, parseLine } from '../shared/usage-parse';
import { normalizeModelId } from '../shared/usage-window';
import { sanitizeUsageSettings, summaryKey } from '../shared/usage-format';

/**
 * 会话上下文统计：按 hook 触发增量读取 transcript，按 message.id 去重记账到账本，
 * 并维护每个会话的上下文占用摘要。摘要变化时才通知（由调用方推送会话列表）。
 */

/** 计数下限相对会话创建时间的提前量 */
const COUNT_FLOOR_SLACK_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_THROTTLE_MS = 2_000;
const DEFAULT_CONCURRENCY = 2;
/** 处于这些状态的会话由兜底轮询补读 */
const LIVE_STATUSES = new Set(['running', 'waiting_permission', 'waiting_input']);

export interface UsageTrackerDeps {
  /** 账本目录：面板数据目录下的 usage */
  dir: string;
  /** transcript 根目录（路径校验与按 id 查找用） */
  root: () => string;
  getSession: (sessionId: string) => Session | undefined;
  listSessions: () => Session[];
  /** 某会话摘要的比较 key 变化时回调 */
  onSummaryChanged?: (sessionId: string) => void;
  now?: () => number;
  pollMs?: number;
  throttleMs?: number;
  chunkSize?: number;
  maxLine?: number;
  concurrency?: number;
  debounceMs?: number;
  /** 面板进程是否带 CLAUDE_CODE_CHILD（决定 no_data 原因文案） */
  claudeCodeChild?: boolean;
  /** 额外的 1M 标记模型（来自用户 claude 设置的模型映射） */
  extraFlagged1m?: string[];
  /** 上下文告警的上报器；未注入时走 notify */
  activity?: ActivityReporter;
  /** 未注入上报器时的通知退路（sessionId 为空表示全局通知） */
  notify?: AlertNotify;
}

export class UsageTracker {
  readonly store: UsageStore;
  private settings: UsageSettings;
  private flagged1m = new Set<string>();
  private readonly currentMain = new Map<string, string>();
  private readonly noData = new Map<string, string>();
  private readonly lastKey = new Map<string, string>();
  private readonly cache = new Map<string, SessionUsageSummary>();
  private readonly throttles = new Map<string, NodeJS.Timeout>();
  private readonly inflight = new Map<string, Promise<ReadResult | undefined>>();
  private readonly again = new Set<string>();
  private readonly waiters: Array<() => void> = [];
  private readonly logged = new Set<string>();
  private active = 0;
  private timers: NodeJS.Timeout[] = [];
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly deps: UsageTrackerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.store = new UsageStore(deps.dir, { debounceMs: deps.debounceMs, now: this.now });
    this.store.load();
    this.settings = this.store.loadSettings();
    for (const m of this.ledger.flagged1m) this.flagged1m.add(m);
    for (const m of deps.extraFlagged1m ?? []) this.flagged1m.add(normalizeModelId(m).id);
  }

  private get ledger(): Ledger {
    return this.store.ledger;
  }

  /** 启动兜底轮询 */
  start(): void {
    const poll = setInterval(() => this.pollLive(), this.deps.pollMs ?? DEFAULT_POLL_MS);
    poll.unref?.();
    this.timers.push(poll);
  }

  /**
   * 启动时与会话列表对齐：账本里归属已不存在会话的文件标记为 detached；
   * 现有会话按 hook 路径、Claude 会话 id 补关联，并各读一次。
   */
  syncSessions(): void {
    const sessions = this.deps.listSessions();
    const ids = new Set(sessions.map(s => s.id));
    for (const f of Object.values(this.ledger.files)) {
      if (!f.detached && !ids.has(f.sessionId)) { f.detached = true; this.store.markDirty(); }
    }
    for (const s of sessions) {
      this.linkFallback(s);
      if (this.filesOf(s.id).length > 0) void this.readSession(s.id);
    }
  }

  onHookMessage(msg: HookMessage): void {
    if (this.disposed) return;
    const s = this.deps.getSession(msg.sessionId);
    if (!s) return;
    if (msg.transcriptPath) this.attach(s.id, msg.transcriptPath, 'main');
    else if (!this.currentMain.has(s.id)) this.linkFallback(s);
    const ev = msg.event;
    if (ev.type === 'subagent_stop') {
      const p = ev.raw?.agent_transcript_path;
      if (typeof p === 'string' && p) this.attachAgentPath(s.id, p);
    }
    switch (ev.type) {
      case 'tool_finished':
        this.throttle(s.id);
        break;
      case 'turn_completed':
      case 'subagent_stop':
        this.cancelThrottle(s.id);
        void this.readSession(s.id, ev.type === 'turn_completed');
        break;
      default:
        break;
    }
  }

  /** 按 hook 路径缺失时的兜底：会话记录的 transcript 路径，否则按 Claude 会话 id 在根目录下查找 */
  private linkFallback(s: Session): void {
    if (s.claudeTranscriptPath && this.attach(s.id, s.claudeTranscriptPath, 'main')) return;
    const ids = s.claudeSessionIds?.length ? s.claudeSessionIds : s.claudeSessionId ? [s.claudeSessionId] : [];
    if (ids.length === 0) return;
    const root = this.deps.root();
    for (const id of ids) {
      const hit = locateTranscript(root, id);
      if (hit.state === 'found' && hit.path) this.attach(s.id, hit.path, 'main');
    }
  }

  /**
   * 登记一个 transcript 文件到会话。路径必须位于 transcript 根目录内；
   * 已归属另一个存活会话的路径忽略。主文件同时成为该会话的当前主文件。
   */
  attach(sessionId: string, file: string, kind: FileKind, agentId: string | null = null): boolean {
    const root = this.deps.root();
    if (!isUnderTranscriptRoot(file, root)) {
      this.logOnce(`outside:${file}`, `忽略 transcript 根目录之外的路径：${file}`);
      return false;
    }
    const key = path.resolve(file);
    const s = this.deps.getSession(sessionId);
    if (!s) return false;
    const now = this.now();
    let f = this.ledger.files[key];
    if (f && f.sessionId !== sessionId && !f.detached && this.deps.getSession(f.sessionId)) {
      this.logOnce(`owned:${key}:${sessionId}`, `transcript 已归属会话 ${f.sessionId.slice(0, 8)}，忽略：${key}`);
      return false;
    }
    if (f) {
      if (f.sessionId !== sessionId || f.detached) {
        f.sessionId = sessionId;
        f.detached = false;
        this.store.markDirty();
      }
      f.seenAt = now;
    } else {
      f = {
        sessionId, kind, agentId, offset: 0, countFrom: s.createdAt - COUNT_FLOOR_SLACK_MS,
        recent: [], contrib: {}, observedMax: {}, seenAt: now,
      };
      this.ledger.files[key] = f;
      this.store.markDirty();
    }
    if (f.kind === 'main') this.currentMain.set(sessionId, key);
    return true;
  }

  /** 子代理文件：文件名 agent-acompact-* 为压缩代理 */
  private attachAgentPath(sessionId: string, file: string): void {
    const m = path.basename(file).match(/^agent-(.+)\.jsonl$/i);
    if (!m) return;
    const agentId = m[1];
    const kind: FileKind = /^acompact/i.test(agentId) ? 'compact' : 'subagent';
    this.attach(sessionId, file, kind, agentId);
  }

  /** 主文件同名目录下的 subagents/agent-*.jsonl 登记为同一会话的子文件 */
  private discoverAgents(sessionId: string, mainFile: string): void {
    const dir = path.join(mainFile.slice(0, -'.jsonl'.length), 'subagents');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!/^agent-.+\.jsonl$/i.test(n)) continue;
      const p = path.join(dir, n);
      if (!this.ledger.files[path.resolve(p)]) this.attachAgentPath(sessionId, p);
    }
  }

  /** 会话结束：文件状态保留偏移但标记 detached（续接回来不重复计数） */
  forget(sessionId: string): void {
    for (const f of Object.values(this.ledger.files)) {
      if (f.sessionId === sessionId && !f.detached) { f.detached = true; this.store.markDirty(); }
    }
    this.cancelThrottle(sessionId);
    this.currentMain.delete(sessionId);
    this.noData.delete(sessionId);
    this.lastKey.delete(sessionId);
    this.cache.delete(sessionId);
  }

  private filesOf(sessionId: string): Array<[string, FileState]> {
    const out: Array<[string, FileState]> = [];
    for (const [p, f] of Object.entries(this.ledger.files)) {
      if (f.sessionId === sessionId && !f.detached) out.push([p, f]);
    }
    return out;
  }

  private throttle(sessionId: string): void {
    if (this.throttles.has(sessionId)) return;
    const t = setTimeout(() => {
      this.throttles.delete(sessionId);
      void this.readSession(sessionId);
    }, this.deps.throttleMs ?? DEFAULT_THROTTLE_MS);
    t.unref?.();
    this.throttles.set(sessionId, t);
  }

  private cancelThrottle(sessionId: string): void {
    const t = this.throttles.get(sessionId);
    if (t) { clearTimeout(t); this.throttles.delete(sessionId); }
  }

  /**
   * 读取会话关联的全部文件（主文件读完后发现新子代理文件，一并读取），然后刷新摘要。
   * judgeNoData 为真时（回合结束），当前主文件仍不存在则判定为无数据。
   */
  async readSession(sessionId: string, judgeNoData = false): Promise<void> {
    if (this.disposed) return;
    const results = new Map<string, ReadResult | undefined>();
    const readAll = async (): Promise<void> => {
      const pending = this.filesOf(sessionId).filter(([p]) => !results.has(p));
      await Promise.all(pending.map(async ([p]) => { results.set(p, await this.readFile(p)); }));
    };
    await readAll();
    for (const [p, f] of this.filesOf(sessionId)) {
      if (f.kind === 'main') this.discoverAgents(sessionId, p);
    }
    await readAll();
    if (this.disposed) return;
    const main = this.currentMain.get(sessionId);
    if (judgeNoData) {
      const r = main ? results.get(main) : undefined;
      if (!main || r?.state === 'missing') this.markNoData(sessionId, main);
    }
    if (main && results.get(main)?.state === 'ok') this.noData.delete(sessionId);
    this.refresh(sessionId);
  }

  private markNoData(sessionId: string, main: string | undefined): void {
    if (!main && this.filesOf(sessionId).length > 0) return;
    const reason = this.deps.claudeCodeChild
      ? 'claude 未写 transcript（面板从 Claude Code 内启动，继承了 CLAUDE_CODE_CHILD）'
      : 'transcript 文件不存在';
    if (!this.noData.has(sessionId)) {
      log('usage', `会话 ${sessionId.slice(0, 8)} 无用量数据：${reason}${main ? `（${main}）` : ''}`);
    }
    this.noData.set(sessionId, reason);
  }

  /** 同一文件同时只读一次；读取中再次请求则读完后补读一次。全局并发受限 */
  private readFile(key: string): Promise<ReadResult | undefined> {
    const cur = this.inflight.get(key);
    if (cur) {
      this.again.add(key);
      return cur;
    }
    const p = this.limited(() => this.doRead(key)).finally(() => {
      this.inflight.delete(key);
      if (this.again.delete(key) && !this.disposed) void this.readFile(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.deps.concurrency ?? DEFAULT_CONCURRENCY;
    while (this.active >= max) await new Promise<void>(resolve => this.waiters.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private async doRead(key: string): Promise<ReadResult | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const f = this.ledger.files[key];
      if (!f || this.disposed) return undefined;
      let res: ReadResult;
      try {
        res = await readIncrement(key, f.offset, {
          chunkSize: this.deps.chunkSize,
          maxLine: this.deps.maxLine,
          onLine: (line, end) => this.consume(key, f, line, end),
          onOversize: (at, end) => {
            f.offset = end;
            this.logOnce(`oversize:${key}`, `跳过超长行：${key} 偏移 ${at}`);
          },
        });
      } catch (err) {
        this.logOnce(`readerr:${key}`, `读取 transcript 失败：${key}：${String(err)}`);
        return undefined;
      }
      if (res.state === 'truncated') {
        log('usage', `transcript 变短（${f.offset} → ${res.size}），撤销后重读：${key}`);
        revertFile(this.ledger, f);
        this.store.markDirty();
        continue;
      }
      if (res.state === 'ok' && res.offset !== f.offset) { f.offset = res.offset; this.store.markDirty(); }
      return res;
    }
    return undefined;
  }

  /** 处理一行：offset 随行推进，与记账在同一次落盘里，保证账本与偏移一致 */
  private consume(key: string, f: FileState, line: string, end: number): void {
    f.offset = end;
    const parsed = parseLine(line);
    if (!parsed) {
      if (isBrokenUsefulLine(line)) this.logOnce(`broken:${key}`, `transcript 含无法解析的行，已跳过：${key}`);
      return;
    }
    this.store.markDirty();
    applyParsed(this.ledger, f, parsed, {
      now: this.now(),
      flagged1m: this.flagged1m,
      label: () => this.deps.getSession(f.sessionId)?.label
        ?? this.ledger.days[localDateOf(this.now())]?.sessions[f.sessionId]?.label ?? f.sessionId.slice(0, 8),
    });
  }

  private reportCtx(): ReportContext {
    return { settings: this.settings, flagged1m: this.flagged1m, now: this.now() };
  }

  private sessionFiles(sessionId: string): SessionFiles {
    return { sessionId, files: this.filesOf(sessionId), currentMain: this.currentMain.get(sessionId) };
  }

  private compute(sessionId: string): SessionUsageSummary {
    const sum = buildSummary(this.sessionFiles(sessionId), this.reportCtx(), this.noData.get(sessionId));
    this.cache.set(sessionId, sum);
    return sum;
  }

  /** 重算摘要；比较 key 变化才通知。检查上下文告警 */
  private refresh(sessionId: string): void {
    if (this.disposed || !this.deps.getSession(sessionId)) return;
    const sum = this.compute(sessionId);
    const key = summaryKey(sum);
    if (this.lastKey.get(sessionId) !== key) {
      this.lastKey.set(sessionId, key);
      this.deps.onSummaryChanged?.(sessionId);
    }
    if (sum.context) this.checkContext(sessionId, sum.context);
  }

  private checkContext(sessionId: string, ctx: NonNullable<SessionUsageSummary['context']>): void {
    const main = pickMain(this.sessionFiles(sessionId));
    if (!main) return;
    const label = this.deps.getSession(sessionId)?.label ?? sessionId.slice(0, 8);
    const a = contextAlert(sessionId, label, main[0], main[1], ctx, this.settings, this.now());
    if (a) { this.store.markDirty(); deliverAlert(a, this.deps); }
  }

  getSummary(sessionId: string): SessionUsageSummary | undefined {
    if (!this.deps.getSession(sessionId)) return undefined;
    return this.cache.get(sessionId) ?? this.compute(sessionId);
  }

  getSettings(): UsageSettings {
    return structuredClone(this.settings);
  }

  /** 校验并保存设置；不合法时返回错误且不写盘。保存后摘要按新设置重算 */
  setSettings(input: unknown): SetUsageSettingsResult {
    const r = sanitizeUsageSettings(input);
    if (!r.ok) return { ok: false, error: r.error };
    if (!this.store.saveSettings(r.value)) return { ok: false, error: '写入用量设置失败' };
    this.applySettings(r.value);
    return { ok: true };
  }

  /** 替换内存中的设置，摘要按新设置重算 */
  applySettings(s: UsageSettings): void {
    this.settings = structuredClone(s);
    this.cache.clear();
    for (const sess of this.deps.listSessions()) this.refresh(sess.id);
  }

  /** 兜底：运行中的会话定期补读，防止漏掉 hook */
  pollLive(): void {
    for (const s of this.deps.listSessions()) {
      if (LIVE_STATUSES.has(s.status) && this.filesOf(s.id).length > 0) void this.readSession(s.id);
    }
  }

  /** 等待当前所有读取结束（测试与退出前用） */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight.values()]);
  }

  private logOnce(key: string, msg: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    log('usage', msg);
  }

  flushSync(): void {
    this.store.flushSync();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const t of this.throttles.values()) clearTimeout(t);
    this.throttles.clear();
    this.store.dispose();
  }
}
