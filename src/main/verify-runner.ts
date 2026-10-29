import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import { killTree as realKillTree, killTreeSync as realKillTreeSync } from './proc-tree';
import { OutputCapture } from './verify-capture';
import { spawnShell, type VerifyChild, type VerifySpawn } from './verify-exec';
import type { PanelEvent, Session } from '../shared/types';
import type {
  VerifyActionResult, VerifyConfig, VerifyDetail, VerifyGlobal, VerifyStatus, VerifySummary,
} from '../shared/verify-types';

/**
 * 每轮自动验证：Claude 一轮结束后延迟片刻执行用户为仓库配置的命令，Claude 一开始新一轮就立即让路。
 * - 触发：turn_completed 后延迟 startDelayMs（缺省 1.5 秒）；延迟期间会话离开空闲就作废。
 * - 让路：提交提示词、工具开始、权限请求、进程退出、会话被结束或重启时，结束整个验证进程树，结果标为已取消。
 * - 同一会话串行，新的一次取代旧的；全局并发有上限，超出的排队；同一目录同一时刻只跑一个。
 * - 两轮之间工作区指纹不变时跳过，沿用上次结果。
 * - 准备命令每个会话只在第一次验证前执行一次，失败则本次结果为错误。
 */

export const DEFAULT_START_DELAY_MS = 1500;
const LOG_KEEP_MS = 7 * 24 * 3600 * 1000;

/** 会话离开空闲、验证必须让路的事件 */
const YIELD_EVENTS = new Set<PanelEvent['type']>(['prompt_submitted', 'tool_started', 'permission_request']);
/** 一轮结束后可以开始验证的会话状态 */
const IDLE_STATUSES = new Set<Session['status']>(['completed', 'waiting_input']);

export interface ResolvedVerifyConfig {
  key: string;
  config: VerifyConfig | null;
}

export interface VerifyRunnerDeps {
  getSession: (id: string) => Session | undefined;
  /** 会话所属仓库的配置；会话不存在等情况返回 null */
  resolveConfig: (id: string) => Promise<ResolvedVerifyConfig | null>;
  global: () => VerifyGlobal;
  /** 工作区指纹；非 git 目录返回 null。缺省不做跳过 */
  fingerprint?: (cwd: string) => Promise<string | null>;
  spawn?: VerifySpawn;
  killTree?: (pid: number) => Promise<void>;
  killTreeSync?: (pid: number) => void;
  /** 完整日志目录 */
  logDir: string;
  /** 某会话的摘要变化（推送会话列表） */
  onSummary: (id: string) => void;
  /** 一次验证得出结果（不含取消与沿用），通知用 */
  onFinished?: (id: string, summary: VerifySummary) => void;
  /** 开始时同目录还有几个其他会话在运行 */
  countInterferers?: (id: string) => number;
  startDelayMs?: number;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

interface Job {
  seq: number;
  sessionId: string;
  manual: boolean;
  phase: 'delay' | 'resolving' | 'queued' | 'running';
  timer?: NodeJS.Timeout;
  cwd: string;
  cwdKey: string;
  config?: VerifyConfig;
  fingerprint?: string | null;
  child?: VerifyChild;
  timeoutTimer?: NodeJS.Timeout;
  capture?: OutputCapture;
  queuedAt?: number;
  startedAt?: number;
  interfered?: number;
  setup?: boolean;
  cancelReason?: string;
  timedOut?: boolean;
  /** 被同会话更新的一次取代：结束后直接丢弃，不写结果 */
  superseded?: boolean;
}

interface SessionState {
  job?: Job;
  summary?: VerifySummary;
  detail?: VerifyDetail;
  /** 上次得出结果时的工作区指纹 */
  lastFingerprint?: string;
  /** 上次得出的结果（通过、失败、超时），沿用时据此展示 */
  lastFinal?: VerifySummary;
  setupDone: boolean;
}

function cwdKeyOf(cwd: string): string {
  const abs = path.resolve(cwd);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

export class VerifyRunner {
  private readonly states = new Map<string, SessionState>();
  private readonly queue: Job[] = [];
  private readonly running = new Set<Job>();
  private seq = 0;
  private disposed = false;
  private readonly now: () => number;
  private readonly spawn: VerifySpawn;
  private readonly kill: (pid: number) => Promise<void>;

  constructor(private readonly deps: VerifyRunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.spawn = deps.spawn ?? spawnShell;
    this.kill = deps.killTree ?? realKillTree;
  }

  private state(id: string): SessionState {
    let st = this.states.get(id);
    if (!st) { st = { setupDone: false }; this.states.set(id, st); }
    return st;
  }

  getSummary(id: string): VerifySummary | undefined {
    const s = this.states.get(id)?.summary;
    return s ? { ...s } : undefined;
  }

  /** 最近一次的输出详情；正在运行时给出已有的摘要与空输出 */
  getDetail(id: string): VerifyDetail | undefined {
    const st = this.states.get(id);
    if (!st?.summary) return undefined;
    if (st.detail && st.summary.status !== 'queued' && st.summary.status !== 'running') {
      return { ...st.detail, ...st.summary };
    }
    return { ...st.summary, output: st.detail?.output ?? '', omittedBytes: st.detail?.omittedBytes ?? 0, logFile: st.detail?.logFile };
  }

  /** 完整日志路径（存在时） */
  logFile(id: string): string | undefined {
    const f = this.states.get(id)?.detail?.logFile;
    return f && fs.existsSync(f) ? f : undefined;
  }

  /** 会话事件旁路：一轮结束触发，新一轮开始或进程退出让路 */
  onEvent(id: string, event: PanelEvent): void {
    if (this.disposed) return;
    if (event.type === 'turn_completed') this.schedule(id, false);
    else if (YIELD_EVENTS.has(event.type)) this.cancel(id, 'Claude 开始了新一轮');
    else if (event.type === 'process_exit') this.cancel(id, '会话进程已退出');
  }

  /** 会话的进程被面板结束：取消验证；结束会话时一并丢掉该会话的状态 */
  onDetach(id: string, reason: 'killed' | 'restarted'): void {
    this.cancel(id, reason === 'killed' ? '会话已结束' : '会话已重启');
    if (reason === 'killed') {
      const st = this.states.get(id);
      if (st && !st.job) this.states.delete(id);
      else if (st) st.setupDone = false;
    }
  }

  /** 手动运行：忽略「无改动不重跑」与启用开关，不等延迟 */
  async run(id: string): Promise<VerifyActionResult> {
    const s = this.deps.getSession(id);
    if (!s) return { ok: false, reason: '会话不存在' };
    if (s.status === 'running' || s.status === 'waiting_permission') return { ok: false, reason: 'Claude 正忙，等这一轮结束再运行' };
    const cfg = await this.deps.resolveConfig(id);
    if (!cfg?.config) return { ok: false, reason: '此仓库未配置验证命令' };
    this.schedule(id, true);
    return { ok: true };
  }

  /** 手动取消；没有进行中的验证时返回 false */
  cancelManual(id: string): boolean {
    return this.cancel(id, '已手动取消');
  }

  private schedule(id: string, manual: boolean): void {
    const s = this.deps.getSession(id);
    if (!s || s.readOnly) return;
    const st = this.state(id);
    if (st.job) this.supersede(st, st.job);
    const job: Job = { seq: ++this.seq, sessionId: id, manual, phase: 'delay', cwd: s.cwd, cwdKey: cwdKeyOf(s.cwd) };
    st.job = job;
    const delay = manual ? 0 : this.deps.startDelayMs ?? DEFAULT_START_DELAY_MS;
    job.timer = setTimeout(() => { void this.afterDelay(job); }, delay);
  }

  /** 旧的一次被取代：未开始的直接作废，运行中的结束进程树、结果丢弃 */
  private supersede(st: SessionState, job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    if (job.phase === 'queued') this.dequeue(job);
    if (job.phase === 'queued' || job.phase === 'running') {
      st.summary = { ...this.baseSummary(job), status: 'cancelled', message: '有新一轮结束，稍后重新验证' };
      this.deps.onSummary(job.sessionId);
    }
    if (job.phase === 'running') {
      job.superseded = true;
      job.cancelReason = '被新一轮验证取代';
      this.terminate(job);
    }
    st.job = undefined;
  }

  private current(job: Job): boolean {
    return !this.disposed && this.states.get(job.sessionId)?.job === job;
  }

  private async afterDelay(job: Job): Promise<void> {
    job.timer = undefined;
    if (!this.current(job)) return;
    const st = this.state(job.sessionId);
    const s = this.deps.getSession(job.sessionId);
    if (!s || (!job.manual && !IDLE_STATUSES.has(s.status))) { st.job = undefined; return; }
    job.phase = 'resolving';
    let cfg: ResolvedVerifyConfig | null = null;
    try { cfg = await this.deps.resolveConfig(job.sessionId); } catch (err) { log('verify', `读取验证配置失败：${String(err)}`); }
    if (!this.current(job)) return;
    const config = cfg?.config;
    if (!config || (!job.manual && !config.enabled)) { st.job = undefined; return; }
    job.config = config;
    if (this.deps.fingerprint) {
      try { job.fingerprint = await this.deps.fingerprint(job.cwd); } catch { job.fingerprint = null; }
      if (!this.current(job)) return;
    }
    if (!job.manual && config.skipUnchanged && job.fingerprint && job.fingerprint === st.lastFingerprint
      && st.lastFinal && st.lastFinal.command === config.command) {
      st.job = undefined;
      st.summary = { ...st.lastFinal, reused: true };
      log('verify', `会话 ${job.sessionId.slice(0, 8)} 工作区未变化，沿用上次验证结果`);
      this.deps.onSummary(job.sessionId);
      return;
    }
    job.phase = 'queued';
    job.queuedAt = this.now();
    this.queue.push(job);
    this.pump();
  }

  private baseSummary(job: Job): VerifySummary {
    const s: VerifySummary = { status: 'queued', command: job.config?.command ?? '' };
    if (job.queuedAt !== undefined) s.queuedAt = job.queuedAt;
    if (job.startedAt !== undefined) s.startedAt = job.startedAt;
    if (job.interfered) s.interfered = job.interfered;
    if (job.setup) s.setup = true;
    return s;
  }

  private dequeue(job: Job): void {
    const i = this.queue.indexOf(job);
    if (i >= 0) this.queue.splice(i, 1);
  }

  /** 按并发上限与同目录互斥启动排队的验证，并刷新排队位置 */
  private pump(): void {
    if (this.disposed) return;
    const max = this.deps.global().maxConcurrent;
    const busyDirs = new Set([...this.running].map(j => j.cwdKey));
    for (const job of [...this.queue]) {
      if (this.running.size >= max) break;
      if (busyDirs.has(job.cwdKey)) continue;
      this.dequeue(job);
      busyDirs.add(job.cwdKey);
      this.start(job);
    }
    this.queue.forEach((job, i) => {
      const st = this.state(job.sessionId);
      const prev = st.summary;
      if (prev?.status === 'queued' && prev.queuePosition === i) return;
      st.summary = { ...this.baseSummary(job), status: 'queued', queuePosition: i };
      this.deps.onSummary(job.sessionId);
    });
  }

  private start(job: Job): void {
    const st = this.state(job.sessionId);
    const config = job.config!;
    job.phase = 'running';
    job.startedAt = this.now();
    job.interfered = this.deps.countInterferers?.(job.sessionId) ?? 0;
    this.running.add(job);
    try { fs.mkdirSync(this.deps.logDir, { recursive: true }); } catch { /* 写日志时再报 */ }
    job.capture = new OutputCapture(path.join(this.deps.logDir, `${job.sessionId}-${job.seq}.part`));
    if (config.setupCommand && !st.setupDone) {
      job.setup = true;
      job.capture.write(`$ ${config.setupCommand}\r\n`);
      this.exec(job, config.setupCommand, config.setupTimeoutSec ?? 900);
    } else {
      this.exec(job, config.command, config.timeoutSec);
    }
  }

  private exec(job: Job, command: string, timeoutSec: number): void {
    const st = this.state(job.sessionId);
    st.summary = { ...this.baseSummary(job), status: 'running' };
    this.deps.onSummary(job.sessionId);
    const env = { ...(this.deps.env ?? process.env), CI: '1', FORCE_COLOR: '1' };
    let child: VerifyChild;
    try {
      child = this.spawn(command, { cwd: job.cwd, env });
    } catch (err) {
      this.finish(job, 'error', { message: `命令无法启动：${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    job.child = child;
    log('verify', `会话 ${job.sessionId.slice(0, 8)} 开始${job.setup ? '准备命令' : '验证'} pid=${child.pid ?? '-'}：${command}`);
    child.onData(c => job.capture?.write(c));
    job.timeoutTimer = setTimeout(() => {
      job.timedOut = true;
      log('verify', `会话 ${job.sessionId.slice(0, 8)} 验证超时（${timeoutSec} 秒），结束进程树`);
      this.terminate(job);
    }, timeoutSec * 1000);
    child.onExit((code, error) => this.onChildExit(job, code, error, timeoutSec));
  }

  private onChildExit(job: Job, code: number | null, error: string | undefined, timeoutSec: number): void {
    if (job.timeoutTimer) { clearTimeout(job.timeoutTimer); job.timeoutTimer = undefined; }
    job.child = undefined;
    if (job.cancelReason) { this.finish(job, 'cancelled', { message: job.cancelReason }); return; }
    if (job.timedOut) {
      this.finish(job, 'timeout', { message: `${job.setup ? '准备命令' : '验证'}超时（${timeoutSec} 秒）`, exitCode: code });
      return;
    }
    if (error) { this.finish(job, 'error', { message: `命令无法启动：${error}` }); return; }
    if (job.setup) {
      if (code !== 0) { this.finish(job, 'error', { message: `准备命令失败（退出码 ${code ?? '未知'}）`, exitCode: code }); return; }
      const st = this.state(job.sessionId);
      st.setupDone = true;
      job.setup = false;
      const config = job.config!;
      job.capture?.write(`\r\n$ ${config.command}\r\n`);
      this.exec(job, config.command, config.timeoutSec);
      return;
    }
    this.finish(job, code === 0 ? 'passed' : 'failed', { exitCode: code });
  }

  private finish(job: Job, status: VerifyStatus, extra: { message?: string; exitCode?: number | null }): void {
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
    this.running.delete(job);
    const st = this.states.get(job.sessionId);
    if (job.superseded || this.disposed || !st) {
      job.capture?.discard();
      this.pump();
      return;
    }
    const finishedAt = this.now();
    const summary: VerifySummary = { ...this.baseSummary(job), status, finishedAt };
    if (job.startedAt !== undefined) summary.durationMs = finishedAt - job.startedAt;
    if (extra.exitCode !== undefined) summary.exitCode = extra.exitCode;
    if (extra.message) summary.message = extra.message;
    const cap = job.capture?.finish(path.join(this.deps.logDir, `${job.sessionId}.log`));
    st.detail = {
      ...summary,
      output: cap?.output ?? '',
      omittedBytes: cap?.omittedBytes ?? 0,
      ...(cap ? { encoding: cap.encoding } : {}),
      ...(cap?.logFile ? { logFile: cap.logFile } : {}),
    };
    st.summary = summary;
    if (st.job === job) st.job = undefined;
    if (status === 'passed' || status === 'failed' || status === 'timeout') {
      st.lastFinal = summary;
      if (job.fingerprint) st.lastFingerprint = job.fingerprint; else delete st.lastFingerprint;
    }
    log('verify', `会话 ${job.sessionId.slice(0, 8)} 验证结束：${status}${summary.exitCode !== undefined ? ` 退出码 ${summary.exitCode}` : ''}${summary.durationMs !== undefined ? ` 用时 ${summary.durationMs}ms` : ''}`);
    this.deps.onSummary(job.sessionId);
    if (status !== 'cancelled') this.deps.onFinished?.(job.sessionId, { ...summary });
    // 会话已被结束：取消的结果没人再看，状态一并丢掉
    if (!this.deps.getSession(job.sessionId) && !st.job) this.states.delete(job.sessionId);
    this.pump();
  }

  /** 结束运行中的进程树；没有进程（启动失败）时直接收尾 */
  private terminate(job: Job): void {
    const pid = job.child?.pid;
    if (pid) void this.kill(pid);
  }

  /**
   * 取消某会话的验证：等待延迟中的直接作废；排队的移出队列；运行中的结束进程树，结果标为已取消。
   * 返回是否有被取消的验证。
   */
  private cancel(id: string, reason: string): boolean {
    const st = this.states.get(id);
    const job = st?.job;
    if (!st || !job) return false;
    if (job.timer) { clearTimeout(job.timer); job.timer = undefined; }
    if (job.phase === 'delay' || job.phase === 'resolving') { st.job = undefined; return true; }
    if (job.phase === 'queued') {
      this.dequeue(job);
      st.job = undefined;
      st.summary = { ...this.baseSummary(job), status: 'cancelled', message: reason };
      this.deps.onSummary(id);
      this.pump();
      return true;
    }
    if (job.cancelReason) return true;
    job.cancelReason = reason;
    st.summary = { ...this.baseSummary(job), status: 'cancelled', message: reason };
    this.deps.onSummary(id);
    log('verify', `会话 ${id.slice(0, 8)} 验证取消（${reason}），结束进程树`);
    if (job.child?.pid) this.terminate(job);
    return true;
  }

  /** 正在运行的验证数与排队数 */
  stats(): { running: number; queued: number } {
    return { running: this.running.size, queued: this.queue.length };
  }

  /** 全局设置变化后按新的并发上限重新调度排队的验证 */
  kick(): void {
    this.pump();
  }

  /** 面板退出：同步结束全部验证进程树，清掉所有定时器，之后不再接受新的验证 */
  disposeAll(): number {
    this.disposed = true;
    const killSync = this.deps.killTreeSync ?? realKillTreeSync;
    let killed = 0;
    for (const job of this.running) {
      if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
      job.capture?.discard();
      const pid = job.child?.pid;
      if (pid) { killSync(pid); killed++; }
    }
    for (const st of this.states.values()) {
      if (st.job?.timer) clearTimeout(st.job.timer);
      st.job = undefined;
    }
    this.running.clear();
    this.queue.length = 0;
    return killed;
  }

  /** 启动时清理：过期的日志与残留的临时文件 */
  pruneLogs(maxAgeMs = LOG_KEEP_MS): number {
    let removed = 0;
    let names: string[];
    try { names = fs.readdirSync(this.deps.logDir); } catch { return 0; }
    const cutoff = this.now() - maxAgeMs;
    for (const name of names) {
      const file = path.join(this.deps.logDir, name);
      try {
        if (name.endsWith('.part') || (name.endsWith('.log') && fs.statSync(file).mtimeMs < cutoff)) {
          fs.rmSync(file, { force: true });
          removed++;
        }
      } catch { /* 被占用等：下次再清 */ }
    }
    return removed;
  }
}
