import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { compareByAttention, HOOKS_VERSION, maybeBusy, transition } from '../shared/status-engine';
import { RingBuffer } from '../shared/ring-buffer';
import { scanPasteMode } from '../shared/paste-mode';
import { buildHookSettings } from './hook-config';
import { panelHome } from './panel-home';
import { log } from './logger';
import {
  ChangeSummary, HookMessage, LaunchOptions, PanelEvent, PendingAction, PtyFactory, PtyProcess,
  RestartOptions, RestartResult, ResumeCheck, Session, WorktreeInfo,
} from '../shared/types';
import type { SubagentTracker } from './subagent-tracker';
import { buildClaudeArgs, sanitizeChildEnv, sanitizeLaunch } from './claude-launch';
import { currentCaps, CliCapabilities } from './cli-capabilities';
import { claudeProjectsRoot, locateTranscript } from './claude-paths';
import {
  appendClaudeId, DEFAULT_HISTORY_LIMITS, DormantPlan, dormantSession, HistoryLimits, newRecord, promptFields,
  recordFieldsFromSession,
} from '../shared/session-records';
import { classifyResumeFailure, evaluateResume } from './resume-check';
import type { SessionRecordStore } from './session-record-store';
import type { AnnotationSummary, PendingPromptState, RestoreBatchResult, RestoreReason, SessionRecord } from '../shared/types';
import type { SessionUsageSummary } from '../shared/usage-types';
import type { VerifySummary } from '../shared/verify-types';
import type { SessionChangeSummary } from '../shared/session-change-types';

const OUTPUT_BUFFER_LINES = 1000;
/** 续接确认期：这段时间内既没收到 SessionStart 也没退出，视为续接成功（旧版 CLI 没有该 hook） */
const RESUME_CONFIRM_MS = 20_000;
/** 批量续接时相邻两次拉起的间隔 */
export const RESTORE_INTERVAL_MS = 800;
/** 单次批量续接的上限 */
export const RESTORE_BATCH_LIMIT = 20;

/** 本次拉起 claude 的方式：新建（可预分配 id）、续接、分叉 */
export interface SpawnPlan {
  sessionId?: string;
  resumeId?: string;
  forkSession?: boolean;
}

/** 分叉来源：从哪条记录的哪段对话分叉 */
export interface ForkSource {
  claudeSessionId: string;
  fork: true;
  recordId: string;
}

/** 会话生命周期节点 */
export type SessionLifecycle = 'created' | 'restarted' | 'adopted' | 'killed';

export interface SessionManagerDeps {
  ptyFactory: PtyFactory;
  hookClientPath: string;
  mockClaudePath: string;
  /** mock 模式 spawn 子进程用的 node 可执行文件绝对路径（`where node` / `which node` 解析）。不传则在 spawn 时 lazy 解析。 */
  nodePath?: string;
  now?: () => number;
  /** 状态变化回调；event 为引起变化的事件，通知服务据此区分回合结束与进程正常退出 */
  onTransition?: (prev: Session, curr: Session, event: PanelEvent) => void;
  onChange?: (sessions: Session[]) => void;
  onOutput?: (sessionId: string, line: string) => void;   // → IPC 推流终端输出
  /** 子代理 tracker：可选（向后兼容旧测试/单测场景），无则不挂子代理。 */
  subagentTracker?: SubagentTracker;
  /** 状态机事件旁路（改动统计据工具结束 / 回合结束触发刷新） */
  onEvent?: (sessionId: string, event: PanelEvent) => void;
  /** 取会话的改动摘要缓存，合并进推给渲染层的会话数据 */
  changeSummary?: (sessionId: string) => ChangeSummary | undefined;
  /** 取会话的本会话改动摘要（按 Claude 动过的文件统计），合并进推给渲染层的会话数据 */
  sessionChangeSummary?: (sessionId: string) => SessionChangeSummary | undefined;
  /** 取会话的用量摘要，合并进推给渲染层的会话数据 */
  usageSummary?: (sessionId: string) => SessionUsageSummary | undefined;
  /** 取会话的批注摘要（待发送条数、是否有排队），合并进推给渲染层的会话数据 */
  annotationSummary?: (sessionId: string) => AnnotationSummary | undefined;
  /** 取会话首条提示词的投递状态（等待就绪或未送达），合并进推给渲染层的会话数据 */
  pendingPrompt?: (sessionId: string) => PendingPromptState | undefined;
  /** 取会话最近一次自动验证的摘要，合并进推给渲染层的会话数据 */
  verifySummary?: (sessionId: string) => VerifySummary | undefined;
  /** 会话生命周期旁路：新建、重启、认领、被面板结束（活动日志据此记事件） */
  onLifecycle?: (kind: SessionLifecycle, session: Session) => void;
  /** 所有 hook 消息的旁路（含子代理事件），用量统计据此登记 transcript 并触发读取 */
  onHookMessage?: (msg: HookMessage) => void;
  /** CLI 能力（决定是否预分配 id、能否分叉）；缺省读 cli-capabilities 的当前值 */
  caps?: () => CliCapabilities;
  /** 对话记录根目录（续接前检查记录文件）；缺省按 claude-paths 解析 */
  projectsRoot?: () => string;
  /** 生成 UUID（测试注入固定值） */
  newUuid?: () => string;
  /** 续接确认期时长（ms），缺省 20 秒 */
  resumeConfirmMs?: number;
  /** 会话记录存储：不传则不写记录（旧单测场景） */
  records?: SessionRecordStore;
  /** 历史记录上限（会话转为已结束时据此清理）；缺省 300 条 / 90 天 */
  historyLimits?: () => HistoryLimits;
}

/**
 * 在 spawn mock-claude 之前解析系统 node 路径。node-pty 不查 PATH，必须传绝对路径。
 * 用 shell 的 `where`/`which` 兜底；解析失败让上层抛出明确错误。
 */
export function findNodePath(): string {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, ['node'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    const first = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first) return first;
  } catch { /* 兜底往下走 */ }
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

interface SessionMetadata {
  id: string;
  label: string;
  cwd: string;
  createdAt: number;
  pid?: number;
  /** Claude 自管 sessionId（新建时预分配，或任意 hook 上报的 payload.session_id，缺失时取 transcript_path 文件名） */
  sessionId?: string;
  /** 用过的全部 Claude 会话 id，最新在末尾 */
  sessionIds?: string[];
  transcriptPath?: string;
  launch?: LaunchOptions;
  /** 独立工作区会话的工作区信息（孤儿认领时恢复，结束会话时据此清理） */
  worktree?: WorktreeInfo;
  /** 会话 hooks 配置版本；缺省为升级前创建 */
  hooksVersion?: number;
  /** 所属批量派发批次；孤儿认领时恢复 */
  batchId?: string;
}

/**
 * 会话运行信号的订阅者（发件箱等主进程模块用）。与 deps 里的回调同一时机触发，
 * 区别是可在 SessionManager 创建之后再挂接，且可挂多个。
 */
export interface SessionListener {
  /** 状态机事件与 SessionStart / UserPromptSubmit 旁路事件 */
  onEvent?(sessionId: string, event: PanelEvent): void;
  /** pty 原始输出（约 16ms 合并一次的数据块），只含当前进程的输出 */
  onOutput?(sessionId: string, chunk: string): void;
  /** 会话的 pty 被面板结束（结束会话或重启前），之后不会再有该进程的输出与事件 */
  onDetach?(sessionId: string, reason: 'killed' | 'restarted'): void;
  /** 会话生命周期：新建、重启、认领、被面板结束 */
  onLifecycle?(kind: SessionLifecycle, session: Session): void;
}

interface Runtime {
  pty: PtyProcess;
  outputBuffer: RingBuffer;
  /** 粘贴模式检测保留的上一块输出尾巴 */
  pasteTail: string;
  /** 进程退出时 resolve：删除工作区前必须等进程真正退出，否则目录仍被占用 */
  exited: Promise<void>;
  /** 进程是否仍存活（onExit 后置 false；runtime 在退出后仍保留，供回放输出） */
  alive: boolean;
  /** 续接确认期：带 --resume 拉起后等待 SessionStart，期间非 0 退出判为续接失败 */
  resumeWatch?: { claudeId: string; timer: NodeJS.Timeout };
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private runtimes = new Map<string, Runtime>();
  private lastResize = new Map<string, string>();   // sessionId → "cols x rows"（日志去重）
  /** 最近一次 PreToolUse 的工具名与参数摘要：真实 claude 的权限 Notification 不带 tool_input，靠它补全命令文本 */
  private lastToolUse = new Map<string, PendingAction>();
  /** 认领的孤儿会话 → 其进程 pid（进程死亡后移除） */
  private orphanPids = new Map<string, number>();
  /** 面板正在退出：退出前的记录已写好，之后 kill 引发的退出、迟到的 hook 都不再写记录 */
  private closing = false;
  private readonly now: () => number;
  private readonly listeners = new Set<SessionListener>();

  constructor(private readonly deps: SessionManagerDeps) {
    this.now = deps.now ?  deps.now  : () => Date.now();
  }

  /** 订阅会话运行信号，返回取消订阅函数 */
  addListener(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 事件同时交给 deps.onEvent 与全部订阅者；单个订阅者抛错不影响其余 */
  private emitEvent(sessionId: string, event: PanelEvent): void {
    this.deps.onEvent?.(sessionId, event);
    for (const l of this.listeners) {
      try { l.onEvent?.(sessionId, event); } catch (err) { log('session', `事件订阅者出错：${String(err)}`); }
    }
  }

  /** 生命周期同时交给 deps.onLifecycle 与全部订阅者；订阅者抛错只记日志 */
  private emitLifecycle(kind: SessionLifecycle, session: Session): void {
    try { this.deps.onLifecycle?.(kind, session); } catch (err) { log('session', `生命周期回调出错：${String(err)}`); }
    for (const l of this.listeners) {
      try { l.onLifecycle?.(kind, session); } catch (err) { log('session', `生命周期订阅者出错：${String(err)}`); }
    }
  }

  /**
   * 会话是否可能正忙：busy 为真，或 hooks 配置早于当前版本（忙碌判断不可靠）。
   * 会话不存在返回 false。
   */
  isBusy(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    return !!s && maybeBusy(s);
  }

  /** 会话是否有仍存活的托管 pty（可以写入） */
  hasLivePty(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.alive === true;
  }

  /** 可写的记录存储；退出流程开始后返回 undefined */
  private get records(): SessionRecordStore | undefined {
    return this.closing ? undefined : this.deps.records;
  }

  getSessions(): Session[] {
    const all = [...this.sessions.values()];
    if (this.deps.subagentTracker) {
      for (const s of all) {
        const subs = this.deps.subagentTracker.getSubagents(s.id);
        if (subs.length > 0 || s.subagents) s.subagents = subs;
      }
    }
    if (this.deps.changeSummary) {
      for (const s of all) {
        const c = this.deps.changeSummary(s.id);
        if (c) s.changes = c; else delete s.changes;
      }
    }
    if (this.deps.sessionChangeSummary) {
      for (const s of all) {
        const c = this.deps.sessionChangeSummary(s.id);
        if (c) s.sessionChanges = c; else delete s.sessionChanges;
      }
    }
    if (this.deps.usageSummary) {
      for (const s of all) {
        const u = this.deps.usageSummary(s.id);
        if (u) s.usage = u; else delete s.usage;
      }
    }
    if (this.deps.annotationSummary) {
      for (const s of all) {
        const a = this.deps.annotationSummary(s.id);
        if (a) s.annotations = a; else delete s.annotations;
      }
    }
    if (this.deps.pendingPrompt) {
      for (const s of all) {
        const p = this.deps.pendingPrompt(s.id);
        if (p) s.pendingPrompt = p; else delete s.pendingPrompt;
      }
    }
    if (this.deps.verifySummary) {
      for (const s of all) {
        const v = this.deps.verifySummary(s.id);
        if (v) s.verify = v; else delete s.verify;
      }
    }
    return all.sort(compareByAttention);
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** 改动摘要更新后推一次会话列表（改动角标随之刷新） */
  notifyChanged(): void {
    this.emitChange();
  }

  /**
   * id 可由调用方预先生成：独立工作区要先以会话 id 命名目录与分支，再创建会话。
   * CLI 支持 --session-id 时预分配 Claude 会话 id，创建后立即可用（不必等 hook 回填）。
   * 带 resumeFrom 时为分叉：以 --resume <原 id> --fork-session 拉起，不预分配 id，新 id 由 SessionStart 回填；
   * 记录里写 forkedFrom 指向来源。
   */
  createSession(input: {
    label: string; cwd: string; id?: string; worktree?: WorktreeInfo; launch?: LaunchOptions; resumeFrom?: ForkSource;
    batchId?: string;
  }): Session {
    const id = input.id ?? this.uuid();
    const dir = path.join(panelHome(), 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'),
      JSON.stringify(buildHookSettings(this.deps.hookClientPath), null, 2));
    // metadata 在 spawnPty 之后写（要带 pid）

    const launch = sanitizeLaunch(input.launch);
    const session: Session = {
      id, label: input.label, cwd: input.cwd,
      status: 'running', statusSince: this.now(), createdAt: this.now(),
      escalated: false, busy: false, hooksVersion: HOOKS_VERSION,
      ...(input.worktree ? { worktree: input.worktree } : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...(launch ? { launch } : {}),
    };
    const plan: SpawnPlan = {};
    const fork = input.resumeFrom;
    if (fork) {
      plan.resumeId = fork.claudeSessionId;
      plan.forkSession = true;
    } else if (this.caps().sessionId) {
      plan.sessionId = this.uuid();
      session.claudeSessionId = plan.sessionId;
      session.claudeSessionIds = [plan.sessionId];
    }
    this.sessions.set(id, session);
    try {
      this.spawnPty(session, plan);
    } catch (err) {
      this.sessions.delete(id);
      throw err;
    }
    const rt = this.runtimes.get(id);
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(this.metadataOf(session, rt?.pty.pid)));
    const rec = newRecord(session, this.now());
    if (fork) rec.forkedFrom = { recordId: fork.recordId, claudeSessionId: fork.claudeSessionId };
    this.records?.upsert(rec);
    const wt = input.worktree ? ` 工作区分支=${input.worktree.branch}` : '';
    const cid = session.claudeSessionId ? ` claude=${session.claudeSessionId.slice(0, 8)}` : '';
    const from = fork ? ` 分叉自 claude=${fork.claudeSessionId.slice(0, 8)}` : '';
    log('session', `创建会话 ${id.slice(0, 8)}（${input.label}）cwd=${input.cwd} pid=${rt?.pty.pid ?? '未知'}${wt}${cid}${from}`);
    this.emitLifecycle('created', session);
    this.emitChange();
    return session;
  }

  /**
   * 面板内部发起的会话（如解决冲突的会话）：不建工作区，走与普通会话相同的拉起流程。
   * 初始提示词不经命令行传入，由调用方交给发件箱等 Claude 就绪后粘贴。
   */
  createInternal(label: string, cwd: string, opts: { launch?: LaunchOptions } = {}): Session {
    return this.createSession({ label, cwd, ...(opts.launch ? { launch: opts.launch } : {}) });
  }

  private caps(): CliCapabilities {
    return (this.deps.caps ?? currentCaps)();
  }

  private uuid(): string {
    return (this.deps.newUuid ?? randomUUID)();
  }

  /** 对话记录根目录（续接检查用） */
  protected projectsRoot(): string {
    return (this.deps.projectsRoot ?? claudeProjectsRoot)();
  }

  private metadataOf(s: Session, pid?: number): SessionMetadata {
    const meta: SessionMetadata = { id: s.id, label: s.label, cwd: s.cwd, createdAt: s.createdAt };
    if (typeof pid === 'number') meta.pid = pid;
    if (s.claudeSessionId) meta.sessionId = s.claudeSessionId;
    if (s.claudeSessionIds?.length) meta.sessionIds = s.claudeSessionIds;
    if (s.claudeTranscriptPath) meta.transcriptPath = s.claudeTranscriptPath;
    if (s.launch) meta.launch = s.launch;
    if (s.worktree) meta.worktree = s.worktree;
    if (s.batchId) meta.batchId = s.batchId;
    if (typeof s.hooksVersion === 'number') meta.hooksVersion = s.hooksVersion;
    return meta;
  }

  /**
   * 拉起 claude 进程。参数由 buildClaudeArgs 统一构建（Windows 再包一层 cmd.exe /c claude.cmd），
   * 环境变量剥离父进程带来的 Claude Code 标记后注入本会话 id。
   */
  private spawnPty(session: Session, plan: SpawnPlan = {}): void {
    const useMock = !!process.env.CLAUDE_PANEL_MOCK_CLAUDE;
    // Windows 上 node-pty 走 CreateProcessW，不认 .cmd/.bat，必须用 cmd.exe 包装
    const isWin = process.platform === 'win32';
    // 会话专属 hooks 配置必须通过 --settings 传给 claude，否则事件永远不上报
    const settingsPath = path.join(panelHome(), 'sessions', session.id, 'settings.json');
    const claudeArgs = buildClaudeArgs({
      settingsPath, caps: this.caps(), ...plan,
      name: session.label, model: session.launch?.model, permissionMode: session.launch?.permissionMode,
    });
    // mock 模式：必须用系统 node.exe 跑 mock-claude.js；不能用 process.execPath（electron.exe）
    // —— electron.exe 在 node-pty 子进程里要么 attach console 失败（PTY 收不到 stdout），
    // 要么直接 exit 0 不执行脚本；ELECTRON_RUN_AS_NODE 也不行。node-pty 也不查 PATH，
    // 所以 'node' 也无效，必须传绝对路径。fallback 用 'node' 在 PATH 已配好的开发机也能用。
    const mockNode = useMock ? (this.deps.nodePath ?? findNodePath()) : null;
    const file = useMock
      ? mockNode!
      : (isWin ? 'cmd.exe' : 'claude');
    const args = useMock
      ? [this.deps.mockClaudePath, ...claudeArgs]
      : (isWin ? ['/c', 'claude.cmd', ...claudeArgs] : claudeArgs);
    const env = sanitizeChildEnv(process.env, session.id);
    const pty = this.deps.ptyFactory.spawn(
      file, args,
      { cwd: session.cwd, env },
    );
    log('pty', `spawn 会话 ${session.id.slice(0, 8)}：${file} ${args.join(' ')}（cwd=${session.cwd} pid=${pty.pid}）`);
    if (!useMock) log('hook', `会话 ${session.id.slice(0, 8)} 已注入 hooks 配置：${settingsPath}`);
    const outputBuffer = new RingBuffer(OUTPUT_BUFFER_LINES);
    let markExited: () => void = () => {};
    const exited = new Promise<void>(resolve => { markExited = resolve; });
    // 重启/结束后旧 PTY 的迟到输出与退出回调必须丢弃，否则会污染新终端、把新会话误判为已退出
    const isCurrent = (): boolean => this.runtimes.get(session.id)?.pty === pty;
    // xterm.js 需要原始字节流（不按行切分），否则会破坏光标定位/清屏等 TUI 控制序列
    let pending = '';
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = (): void => {
      if (!pending) return;
      const chunk = pending;
      pending = '';
      if (!isCurrent()) return;
      for (const line of chunk.split(/\r?\n/)) {
        if (line) outputBuffer.push(line);
      }
      this.trackPasteMode(session.id, chunk);
      this.deps.onOutput?.(session.id, chunk);
      for (const l of this.listeners) {
        try { l.onOutput?.(session.id, chunk); } catch (err) { log('session', `输出订阅者出错：${String(err)}`); }
      }
    };
    pty.onData(chunk => {
      pending += chunk;
      outputBuffer.pushRaw(chunk);
      if (flushTimer) return;
      flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 16);
    });
    pty.onExit(code => {
      markExited();
      if (!isCurrent()) {
        log('pty', `会话 ${session.id.slice(0, 8)} 旧进程退出（exitCode=${code}），已被重启或结束，忽略`);
        return;
      }
      flush();
      const rt = this.runtimes.get(session.id)!;
      rt.alive = false;
      log('pty', `会话 ${session.id.slice(0, 8)} 进程退出，exitCode=${code}`);
      this.settleResumeOnExit(session.id, rt, code);
      // 父会话退出：其 running 子代理统一转 aborted（已完成的不动）
      this.deps.subagentTracker?.abortChildren(session.id);
      // 进程已退出，输入框不复存在
      const s = this.sessions.get(session.id);
      if (s?.pasteMode) this.sessions.set(session.id, { ...s, pasteMode: false });
      this.handleEvent(session.id, { type: 'process_exit', code });
    });
    this.runtimes.set(session.id, { pty, outputBuffer, pasteTail: '', exited, alive: true });
  }

  /** 扫描输出里的粘贴模式序列，模式变化时更新会话并推送 */
  private trackPasteMode(sessionId: string, chunk: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    const scan = scanPasteMode(rt.pasteTail, chunk);
    rt.pasteTail = scan.tail;
    if (scan.mode === undefined) return;
    const s = this.sessions.get(sessionId);
    if (!s || (s.pasteMode ?? false) === scan.mode) return;
    this.sessions.set(sessionId, { ...s, pasteMode: scan.mode });
    log('pty', `会话 ${sessionId.slice(0, 8)} 粘贴模式${scan.mode ? '开启' : '关闭'}`);
    this.emitChange();
  }

  /** 续接确认期内退出：非 0 判为续接失败，按终端输出归类原因并挂到会话上（随后的 process_exit 会把状态转为 error） */
  private settleResumeOnExit(sessionId: string, rt: Runtime, code: number | null): void {
    const watch = rt.resumeWatch;
    if (!watch) return;
    clearTimeout(watch.timer);
    delete rt.resumeWatch;
    if (code === 0) {
      log('session', `会话 ${sessionId.slice(0, 8)} 续接确认前正常退出（exitCode=0），不判为失败`);
      return;
    }
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const failure = classifyResumeFailure(rt.outputBuffer.getRaw(), code, this.now());
    s.resumeFailure = failure;
    log('session', `会话 ${sessionId.slice(0, 8)} 续接失败（${failure.reason}，exitCode=${code}）：${failure.detail ?? ''}`);
  }

  /** 带 --resume 拉起后进入确认期：收到 SessionStart 即成功，超时也视为成功 */
  private watchResume(sessionId: string, claudeId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    const timer = setTimeout(() => {
      if (rt.resumeWatch?.timer !== timer) return;
      delete rt.resumeWatch;
      log('session', `会话 ${sessionId.slice(0, 8)} 续接确认超时（未收到 SessionStart），视为续接成功`);
      this.countResume(sessionId);
    }, this.deps.resumeConfirmMs ?? RESUME_CONFIRM_MS);
    timer.unref?.();
    rt.resumeWatch = { claudeId, timer };
  }

  /** 结束续接确认期（收到 SessionStart、重启或结束时） */
  private clearResumeWatch(rt: Runtime | undefined): void {
    if (!rt?.resumeWatch) return;
    clearTimeout(rt.resumeWatch.timer);
    delete rt.resumeWatch;
  }

  /** 把会话当前字段与额外改动合并写入记录；defer 时延迟落盘（高频的小改动） */
  private syncRecord(s: Session, extra: Partial<SessionRecord> = {}, defer = false): void {
    this.records?.patch(s.id, { ...recordFieldsFromSession(s), ...extra }, { defer });
  }

  /** 续接确认成功：记录里的成功续接次数加一 */
  private countResume(sessionId: string): void {
    const records = this.records;
    const rec = records?.get(sessionId);
    if (!records || !rec) return;
    records.patch(sessionId, { resumeCount: rec.resumeCount + 1 });
  }

  handleHookMessage(msg: HookMessage): void {
    if (!this.sessions.has(msg.sessionId)) return;
    // 任一 hook 都刷新最近活动时间（延迟落盘，避免每个事件都写文件）
    this.records?.patch(msg.sessionId, { lastActiveAt: this.now() }, { defer: true });
    // 任何 hook（含子代理事件）带来的 Claude sessionId 都记下并持久化，重启后据此重建子代理、续接对话
    const idChanged = this.attachClaudeSessionId(msg.sessionId, msg.claudeSessionId, msg.transcriptPath);
    this.deps.onHookMessage?.(msg);
    const event = msg.event;
    // 子代理事件不走状态机：原始 payload 直接交给 tracker
    if (event.type === 'subagent_start' || event.type === 'subagent_stop') {
      this.deps.subagentTracker?.handleHook(msg.sessionId, event.raw);
      this.emitChange();
      return;
    }
    // 启动不改变会话状态，只做旁路通知（续接确认在这里接入）；提交提示词走状态机（推到运行中、置忙碌）
    if (event.type === 'session_started') {
      this.handleSideEvent(msg.sessionId, event, msg.claudeSessionId);
      this.emitEvent(msg.sessionId, event);
      if (idChanged) this.emitChange();
      return;
    }
    this.handleEvent(msg.sessionId, event);
  }

  /** 不进状态机的事件：SessionStart（结束续接确认期） */
  private handleSideEvent(sessionId: string, event: Extract<PanelEvent, { type: 'session_started' }>, claudeId?: string): void {
    log('session', `会话 ${sessionId.slice(0, 8)} SessionStart（source=${event.source}）`);
    const rt = this.runtimes.get(sessionId);
    const watch = rt?.resumeWatch;
    if (!watch) return;
    this.clearResumeWatch(rt);
    if (event.source !== 'resume') {
      log('session', `会话 ${sessionId.slice(0, 8)} 续接后收到 source=${event.source} 的 SessionStart，CLI 可能以新对话启动`);
    } else if (claudeId && claudeId.toLowerCase() !== watch.claudeId.toLowerCase()) {
      log('session', `会话 ${sessionId.slice(0, 8)} 续接后 CLI 换了新 id ${claudeId.slice(0, 8)}（原 ${watch.claudeId.slice(0, 8)}）`);
    } else {
      log('session', `会话 ${sessionId.slice(0, 8)} 续接成功（claude=${watch.claudeId.slice(0, 8)}）`);
    }
    if (event.source === 'resume') this.countResume(sessionId);
  }

  private handleEvent(sessionId: string, event: PanelEvent): void {
    const prev = this.sessions.get(sessionId);
    if (!prev) {
      log('state', `事件 ${event.type} 指向未知会话 ${sessionId.slice(0, 8)}，已忽略`);
      return;
    }
    event = this.trackToolUse(sessionId, event);
    const curr = transition(prev, event, this.now());
    this.sessions.set(sessionId, curr);
    if (prev.status !== curr.status) {
      log('state', `会话 ${sessionId.slice(0, 8)}（${curr.label}）${prev.status} → ${curr.status}（事件 ${event.type}）`);
      this.deps.onTransition?.(prev, curr, event);
    }
    this.recordEvent(prev, curr, event);
    this.emitEvent(sessionId, event);
    this.emitChange();
  }

  /** 状态机事件写记录：进程退出转 exited，回合结束轮数加一，其余状态变化延迟落盘 */
  private recordEvent(prev: Session, curr: Session, event: PanelEvent): void {
    const records = this.records;
    if (!records) return;
    if (event.type === 'process_exit') {
      this.syncRecord(curr, { state: 'exited' });
    } else if (event.type === 'turn_completed') {
      const turns = (records.get(curr.id)?.turns ?? 0) + 1;
      this.syncRecord(curr, { turns });
    } else if (event.type === 'prompt_submitted' && event.prompt) {
      // 首条提示词立即落盘，之后只更新最近一条，随状态变化延迟合并
      const prev = records.get(curr.id);
      this.syncRecord(curr, promptFields(prev, event.prompt), !!prev?.firstPrompt);
    } else if (prev.status !== curr.status) {
      this.syncRecord(curr, {}, true);
    }
  }

  /**
   * 记录 PreToolUse 的工具参数，并为缺命令文本的权限请求补全：
   * claude 的顺序是 PreToolUse → 权限检查 → Notification，后者只有一句提示文本。
   * 仅当工具名一致（或提示里抠不出工具名）时才借用，避免张冠李戴；工具结束/回合结束/进程退出即作废。
   */
  private trackToolUse(sessionId: string, event: PanelEvent): PanelEvent {
    switch (event.type) {
      case 'tool_started':
        if (event.toolName) {
          this.lastToolUse.set(sessionId, { toolName: event.toolName, commandText: event.commandText ?? '' });
        }
        return event;
      case 'permission_request': {
        const last = this.lastToolUse.get(sessionId);
        if (event.commandText || !last) return event;
        if (event.toolName !== last.toolName && event.toolName !== '未知工具') return event;
        return { ...event, toolName: last.toolName, commandText: last.commandText };
      }
      case 'tool_finished':
      case 'turn_completed':
      case 'process_exit':
        this.lastToolUse.delete(sessionId);
        return event;
      default:
        return event;
    }
  }

  /**
   * 记录 Claude sessionId 与对话记录路径并持久化到 metadata.json（孤儿认领时读回，供子代理重建定位 transcript）。
   * 值变化才写盘：会话内 /clear 等操作会换新 sessionId，以最新为准，旧 id 留在 claudeSessionIds 里。
   * 返回 id 是否变化。
   */
  private attachClaudeSessionId(sessionId: string, claudeId: string | undefined, transcriptPath: string | undefined): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const idChanged = !!claudeId && s.claudeSessionId !== claudeId;
    // 只认与当前 id 对应的记录路径：/clear 后旧路径不应覆盖新 id
    const effectiveId = claudeId ?? s.claudeSessionId;
    const pathMatches = !!transcriptPath && !!effectiveId
      && path.basename(transcriptPath).toLowerCase() === `${effectiveId}.jsonl`.toLowerCase();
    const pathChanged = pathMatches && s.claudeTranscriptPath !== transcriptPath;
    if (!idChanged && !pathChanged) return false;
    if (idChanged) {
      s.claudeSessionId = claudeId;
      s.claudeSessionIds = appendClaudeId(s.claudeSessionIds, claudeId!);
      if (!pathMatches) delete s.claudeTranscriptPath;
      log('session', `会话 ${sessionId.slice(0, 8)} 关联 claudeSessionId=${claudeId!.slice(0, 8)}`);
    }
    if (pathChanged) s.claudeTranscriptPath = transcriptPath;
    this.persistMetadata(s);
    this.syncRecord(s);
    return idChanged;
  }

  /** 把会话核心字段写回 metadata.json；可同时回写 pid（restart 后 pid 会变）。文件不存在时按当前字段新建 */
  private persistMetadata(s: Session, pid?: number): void {
    try {
      const metaPath = path.join(panelHome(), 'sessions', s.id, 'metadata.json');
      let prev: Partial<SessionMetadata> = {};
      try { prev = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as SessionMetadata; } catch { /* 缺失或损坏：按当前字段重写 */ }
      const meta = { ...prev, ...this.metadataOf(s, typeof pid === 'number' ? pid : prev.pid) };
      if (!s.claudeTranscriptPath) delete meta.transcriptPath;
      if (!s.claudeSessionId) delete meta.sessionId;
      fs.mkdirSync(path.dirname(metaPath), { recursive: true });
      fs.writeFileSync(metaPath, JSON.stringify(meta));
    } catch (err) {
      log('session', `metadata 持久化失败（${s.id.slice(0, 8)}）：${String(err)}`);
    }
  }

  /**
   * 拉起前按当前版本重写会话的 hooks 配置：跨重启恢复的行目录已被清掉需要补写，
   * 升级前创建的会话配置缺少新 hook，重写后新进程即可上报
   */
  private writeSessionSettings(sessionId: string): void {
    const file = path.join(panelHome(), 'sessions', sessionId, 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(buildHookSettings(this.deps.hookClientPath), null, 2));
  }

  writeInput(sessionId: string, data: string): boolean {
    const rt = this.runtimes.get(sessionId);
    const s = this.sessions.get(sessionId);
    if (!rt || !s || s.readOnly) {
      log('input', `写入被拒 会话 ${sessionId.slice(0, 8)}：${!rt ? 'PTY 不存在' : s?.readOnly ? '只读会话' : '会话不存在'}`);
      return false;
    }
    rt.pty.write(data);
    return true;
  }

  resizeSession(sessionId: string, cols: number, rows: number): boolean {
    const rt = this.runtimes.get(sessionId);
    if (!rt?.pty.resize) {
      log('pty', `resize 失败 会话 ${sessionId.slice(0, 8)}：${!rt ? 'PTY 不存在' : 'PTY 不支持 resize'}`);
      return false;
    }
    const size = `${cols}x${rows}`;
    // 进程刚退出、运行时尚未清理时 node-pty 会抛错，按失败处理，不让渲染层收到异常
    try {
      rt.pty.resize(cols, rows);
    } catch (err) {
      log('pty', `resize 失败 会话 ${sessionId.slice(0, 8)}：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    if (this.lastResize.get(sessionId) !== size) {
      log('pty', `resize 会话 ${sessionId.slice(0, 8)} → ${size}`);
      this.lastResize.set(sessionId, size);
    }
    return true;
  }

  approvePermission(sessionId: string, choice: 'yes' | 'no' | 'always'): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || s.status !== 'waiting_permission') return false;
    // 回车必须发 CR：xterm 的 Enter 键发的就是 \r，LF 在控制台行规程里不提交一行，
    // 只会把字符并进缓冲，下次回车才一起交出去（表现为「点了一次批准却没反应」）
    const key = { yes: 'y\r', no: 'n\r', always: 'a\r' }[choice];
    return this.writeInput(sessionId, key);
  }

  /** 本会话进程是否仍存活：托管 PTY 未退出，或认领的孤儿 pid 仍在 */
  isProcessAlive(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.alive === true || this.orphanPids.has(sessionId);
  }

  /**
   * 续接检查的对象：列表里的会话；不在列表里时按记录构造一个无进程的会话（历史里的已结束记录）。
   * 都没有返回 undefined。
   */
  resumeSubject(sessionId: string): Session | undefined {
    const s = this.sessions.get(sessionId);
    if (s) return s;
    const rec = this.deps.records?.get(sessionId);
    return rec ? dormantSession(rec, { id: rec.id, state: 'exited' }) : undefined;
  }

  /** 续接前检查（每次都查一次文件系统，不缓存）；会话与记录都不存在返回 undefined */
  checkResume(sessionId: string): ResumeCheck | undefined {
    const session = this.resumeSubject(sessionId);
    return session ? this.evaluateFor(session, this.isProcessAlive(sessionId)) : undefined;
  }

  /**
   * 接管认领会话前的续接检查：按已解除只读、原进程仍存活评估，
   * 除了要先结束原进程外都满足时 reason 为 busy。不在列表里返回 undefined。
   */
  checkTakeover(sessionId: string): ResumeCheck | undefined {
    const s = this.sessions.get(sessionId);
    return s ? this.evaluateFor({ ...s, readOnly: false }, true) : undefined;
  }

  private evaluateFor(session: Session, alive: boolean): ResumeCheck {
    const root = this.projectsRoot();
    return evaluateResume({
      session,
      alive,
      liveOthers: [...this.sessions.values()].filter(o => o.id !== session.id && this.isProcessAlive(o.id)),
      caps: this.caps(),
      exists: p => fs.existsSync(p),
      locate: (id, hint) => locateTranscript(root, id, hint),
    });
  }

  /**
   * 把历史里的记录放回列表，成为一个无进程的行（之后由 restartSession 拉起）。
   * 已在列表里返回现有会话；没有记录返回 undefined。
   */
  reviveRecord(sessionId: string): Session | undefined {
    const cur = this.sessions.get(sessionId);
    if (cur) return cur;
    const rec = this.deps.records?.get(sessionId);
    if (!rec) return undefined;
    return this.addDormant(rec, { id: rec.id, state: 'exited' });
  }

  /**
   * 撤回从历史放回列表的行（拉起失败时）：只移除没有进程、记录仍为已结束的行，不写记录。
   */
  removeDormant(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || this.runtimes.has(sessionId) || this.deps.records?.get(sessionId)?.state !== 'ended') return false;
    this.sessions.delete(sessionId);
    this.emitChange();
    return true;
  }

  /** 改会话标签：同步 metadata 与记录；不在列表里返回 false */
  renameSession(sessionId: string, label: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const next = { ...s, label };
    this.sessions.set(sessionId, next);
    // 无进程行的会话目录已被清理，不为改名重建
    if (fs.existsSync(path.join(panelHome(), 'sessions', sessionId))) this.persistMetadata(next);
    this.syncRecord(next);
    log('session', `会话 ${sessionId.slice(0, 8)} 改名为「${label}」`);
    this.emitChange();
    return true;
  }

  /**
   * 重启会话，缺省为续接原对话。
   * - 续接：先 checkResume，不可续接直接返回失败、不拉起；进程仍存活时需 force。保留 Claude 会话 id
   *   与已完成的子代理（只把未完成的转为中止），以 --resume 拉起并进入续接确认期。
   * - 全新开始：换新 id、清空子代理与对话记录路径；进程仍存活时同样需要 force。
   * 面板会话 id、标签、cwd、工作区信息始终不变。
   */
  restartSession(sessionId: string, opts: RestartOptions = { mode: 'resume' }): RestartResult {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, reason: 'not_found', message: '会话不存在' };
    const mode = opts.mode === 'fresh' ? 'fresh' : 'resume';
    const check = this.checkResume(sessionId)!;
    const fail = (reason: RestartResult['reason'], message: string): RestartResult => {
      log('session', `重启被拒 会话 ${sessionId.slice(0, 8)}（${mode}）：${message}`);
      return { ok: false, mode, reason, message };
    };
    if (mode === 'fresh') {
      if (!check.canFresh) return fail(check.reason, check.message);
      if (this.isProcessAlive(sessionId) && !opts.force) return fail('busy', '会话进程仍在运行，需要先结束');
    } else if (!check.resumable && !(check.reason === 'busy' && opts.force)) {
      return fail(check.reason, check.message);
    }

    this.dropRuntime(sessionId, 'restarted');
    this.lastToolUse.delete(sessionId);
    // 新进程从输入框开始：忙碌与粘贴模式归零；hooks 配置在拉起前按当前版本重写
    const next: Session = {
      ...s, status: 'running', statusSince: this.now(), exitCode: undefined, pendingAction: undefined, escalated: false,
      busy: false, hooksVersion: HOOKS_VERSION,
    };
    delete next.resumeFailure; delete next.pasteMode;
    let notice: string | undefined;
    if (check.cwdFallback) {
      notice = `原目录 ${s.cwd} 已不存在，改在工作区根目录启动`;
      log('session', `会话 ${sessionId.slice(0, 8)} ${notice}`);
      next.cwd = check.cwdFallback;
    }
    // 跨重启恢复的行重新拉起后就是普通的托管会话
    delete next.dormant; delete next.dormantSince; delete next.restoreReason; delete next.turns;
    const plan: SpawnPlan = {};
    if (mode === 'resume') {
      // 续接沿用原对话：已完成的子代理条目保留，只把还在跑的转为中止
      this.deps.subagentTracker?.abortChildren(sessionId);
      plan.resumeId = s.claudeSessionId;
    } else {
      // 全新开始与原对话脱钩：子代理、对话记录路径一并清掉，等新 id
      this.deps.subagentTracker?.clearSession(sessionId);
      delete next.claudeSessionId; delete next.subagents; delete next.claudeTranscriptPath;
      if (this.caps().sessionId) {
        plan.sessionId = this.uuid();
        next.claudeSessionId = plan.sessionId;
        next.claudeSessionIds = appendClaudeId(next.claudeSessionIds, plan.sessionId);
      }
    }
    this.sessions.set(sessionId, next);
    try {
      this.writeSessionSettings(sessionId);
      this.spawnPty(next, plan);
    } catch (err) {
      const message = `启动 claude 失败：${err instanceof Error ? err.message : String(err)}`;
      log('session', `会话 ${sessionId.slice(0, 8)} ${message}`);
      this.handleEvent(sessionId, { type: 'process_exit', code: null });
      return { ok: false, mode, reason: 'spawn_failed', message };
    }
    if (plan.resumeId) this.watchResume(sessionId, plan.resumeId);
    // 重启后 pid 变了，必须把新 pid 回写 metadata，否则孤儿扫描会按旧 pid 判死
    const rt = this.runtimes.get(sessionId);
    this.persistMetadata(next, rt?.pty.pid);
    this.syncRecord(next, { state: 'live', endReason: undefined, endedAt: undefined, restoreReason: undefined });
    log('session', `会话 ${sessionId.slice(0, 8)} ${mode === 'resume' ? `续接对话 claude=${plan.resumeId!.slice(0, 8)}` : '全新开始'}${opts.force ? '（先结束了仍在运行的进程）' : ''}`);
    this.emitLifecycle('restarted', next);
    this.emitChange();
    return notice ? { ok: true, mode, message: notice } : { ok: true, mode };
  }

  /** 结束并移除会话的 PTY（若有），同时结束续接确认期，并通知订阅者该进程已脱离 */
  private dropRuntime(sessionId: string, reason: 'killed' | 'restarted'): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    this.clearResumeWatch(rt);
    try { rt.pty.kill(); } catch { /* 已退出：忽略 */ }
    this.runtimes.delete(sessionId);
    this.notifyDetach(sessionId, reason);
  }

  private notifyDetach(sessionId: string, reason: 'killed' | 'restarted'): void {
    for (const l of this.listeners) {
      try { l.onDetach?.(sessionId, reason); } catch (err) { log('session', `订阅者出错：${String(err)}`); }
    }
  }

  /**
   * 结束会话并等待进程退出（最多 timeoutMs），返回是否确认已退出。
   * 没有 PTY 的会话（已退出或认领的孤儿）直接视为已退出。
   */
  async killSessionAndWait(sessionId: string, timeoutMs = 3000): Promise<boolean> {
    const rt = this.runtimes.get(sessionId);
    this.killSession(sessionId);
    if (!rt) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const ok = await Promise.race([rt.exited.then(() => true), timeout]);
    if (timer) clearTimeout(timer);
    if (!ok) log('session', `会话 ${sessionId.slice(0, 8)} 结束后 ${timeoutMs}ms 内进程未退出`);
    return ok;
  }

  killSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    const hadRuntime = this.runtimes.has(sessionId);
    this.dropRuntime(sessionId, 'killed');
    // 没有 pty 的行（待续接、认领的孤儿）同样要让订阅者丢掉该会话的状态
    if (!hadRuntime) this.notifyDetach(sessionId, 'killed');
    this.lastToolUse.delete(sessionId);
    this.orphanPids.delete(sessionId);
    this.deps.subagentTracker?.clearSession(sessionId);
    this.sessions.delete(sessionId);
    if (s && this.records) {
      this.syncRecord(s, { state: 'ended', endReason: 'killed', endedAt: this.now() });
      this.records.prune(this.historyLimits());
    }
    if (s) this.emitLifecycle('killed', s);
    this.emitChange();
  }

  private historyLimits(): HistoryLimits {
    return this.deps.historyLimits?.() ?? DEFAULT_HISTORY_LIMITS;
  }

  /** 面板托管、进程仍存活的会话 id（不含只读认领的孤儿：它们的进程不归面板管，退出时也不杀） */
  liveManagedIds(): string[] {
    return [...this.sessions.values()]
      .filter(s => !s.readOnly && this.runtimes.get(s.id)?.alive === true)
      .map(s => s.id);
  }

  /**
   * 退出前保留：托管中的存活会话记录转 suspended 并写明原因，然后进入关闭状态，
   * 之后 kill 引发的退出不再覆盖记录。返回涉及的 id。
   */
  suspendAll(reason: RestoreReason): string[] {
    const ids = this.liveManagedIds();
    for (const id of ids) {
      const s = this.sessions.get(id)!;
      this.syncRecord(s, { state: 'suspended', restoreReason: reason, endReason: undefined, endedAt: undefined });
    }
    this.closing = true;
    this.deps.records?.flush();
    if (ids.length > 0) log('session', `退出前保留 ${ids.length} 个会话（原因 ${reason}）`);
    return ids;
  }

  /** 退出前结束：托管中的存活会话记录转 ended(quit_end)，然后进入关闭状态。返回涉及的 id */
  endAll(): string[] {
    const ids = this.liveManagedIds();
    const now = this.now();
    for (const id of ids) {
      const s = this.sessions.get(id)!;
      this.syncRecord(s, { state: 'ended', endReason: 'quit_end', endedAt: now, restoreReason: undefined });
    }
    if (ids.length > 0) this.records?.prune(this.historyLimits());
    this.closing = true;
    this.deps.records?.flush();
    if (ids.length > 0) log('session', `退出前结束 ${ids.length} 个会话`);
    return ids;
  }

  /**
   * 按记录恢复一个无进程的会话行（待续接或跨重启保留的已退出行），不拉起 PTY、不写记录。
   * 已在列表里的 id 不重复添加。
   */
  addDormant(rec: SessionRecord, plan: DormantPlan): Session | undefined {
    if (this.sessions.has(rec.id)) return undefined;
    const s = dormantSession(rec, plan);
    this.sessions.set(s.id, s);
    this.emitChange();
    return s;
  }

  /**
   * 批量续接待续接的会话：ids 为 'all' 时取当前全部 suspended 行。逐个续接，两次拉起之间间隔 intervalMs，
   * 避免同时拉起一批 CLI 抢资源。单次最多 RESTORE_BATCH_LIMIT 个，超出的留在待续接分组。
   * 失败的不重试、不改为全新开始，原因随结果返回。
   */
  async restoreSessions(
    ids: string[] | 'all', intervalMs = RESTORE_INTERVAL_MS,
    onProgress?: (done: number, total: number) => void,
  ): Promise<RestoreBatchResult> {
    const targets = (ids === 'all'
      ? [...this.sessions.values()].filter(s => s.status === 'suspended').sort((a, b) => a.createdAt - b.createdAt).map(s => s.id)
      : ids.filter(id => this.sessions.get(id)?.status === 'suspended')).slice(0, RESTORE_BATCH_LIMIT);
    const result: RestoreBatchResult = { started: [], failed: [] };
    for (let i = 0; i < targets.length; i++) {
      if (i > 0 && intervalMs > 0) await new Promise(r => setTimeout(r, intervalMs));
      // 等待期间面板可能开始退出：之后不再拉起新进程
      if (this.closing) break;
      const id = targets[i];
      if (this.sessions.get(id)?.status !== 'suspended') continue;
      const r = this.restartSession(id, { mode: 'resume' });
      if (r.ok) result.started.push(id);
      else result.failed.push({ id, reason: r.message ?? '续接失败' });
      onProgress?.(i + 1, targets.length);
    }
    log('session', `批量续接：成功 ${result.started.length}，失败 ${result.failed.length}`);
    return result;
  }

  /** 面板主动退出时向全部托管 PTY 发送终止，返回成功发出 kill 的数量（发出即计数，不承诺结果）；单个失败不阻断其余 */
  disposeAll(): number {
    this.closing = true;
    let sent = 0;
    for (const rt of this.runtimes.values()) {
      this.clearResumeWatch(rt);
      try { rt.pty.kill(true); sent++; } catch { /* 已退出/已杀：跳过 */ }
    }
    return sent;
  }

  getSessionOutput(sessionId: string): string {
    return this.runtimes.get(sessionId)?.outputBuffer.getRaw() ?? '';
  }

  /** 原始输出缓冲因超限丢弃的较早字符数 */
  getDroppedChars(sessionId: string): number {
    return this.runtimes.get(sessionId)?.outputBuffer.dropped ?? 0;
  }

  /** 终端最近一次的尺寸；从未 resize 过时按 PTY 初始的 120x30 */
  getTermSize(sessionId: string): { cols: number; rows: number } {
    const m = /^(\d+)x(\d+)$/.exec(this.lastResize.get(sessionId) ?? '');
    const cols = m ? Number(m[1]) : 0;
    const rows = m ? Number(m[2]) : 0;
    return { cols: cols > 0 ? cols : 120, rows: rows > 0 ? rows : 30 };
  }

  adoptSession(session: Session, pid?: number): void {
    this.sessions.set(session.id, session);
    if (typeof pid === 'number') this.orphanPids.set(session.id, pid);
    // 认领沿用已有记录（保留轮数、续接次数等），没有记录时补建一条
    const records = this.records;
    if (records) {
      if (records.get(session.id)) this.syncRecord(session, { state: 'live' });
      else records.upsert(newRecord(session, this.now()));
    }
    this.emitLifecycle('adopted', session);
    this.emitChange();
  }

  /**
   * 轮询认领会话的进程存活。认领会话没有 PTY 句柄，收不到 onExit，只能靠 pid 判活：
   * 进程已死 → 解除只读，按失联退出处理（running 子代理转 aborted），之后可重启或结束。
   * 返回本轮判定死亡的数量。
   */
  pollOrphans(isAlive: (pid: number) => boolean): number {
    let dead = 0;
    for (const [id, pid] of [...this.orphanPids]) {
      if (isAlive(pid)) continue;
      if (this.releaseOrphan(id)) dead++;
    }
    return dead;
  }

  /** 认领会话记录的进程 pid；不是认领会话或已解除时返回 undefined */
  orphanPid(sessionId: string): number | undefined {
    return this.orphanPids.get(sessionId);
  }

  /**
   * 认领会话的进程已结束（自行退出或被接管时结束）：解除只读，按失联退出处理，
   * running 子代理转 aborted，之后可续接或结束。不是认领会话返回 false。
   */
  releaseOrphan(sessionId: string): boolean {
    const pid = this.orphanPids.get(sessionId);
    if (pid === undefined) return false;
    this.orphanPids.delete(sessionId);
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    log('orphan', `认领会话 ${sessionId.slice(0, 8)}（${s.label}）进程 pid=${pid} 已退出`);
    this.sessions.set(sessionId, { ...s, readOnly: false });
    this.deps.subagentTracker?.abortChildren(sessionId);
    this.handleEvent(sessionId, { type: 'process_exit', code: null });
    return true;
  }

  markEscalated(ids: string[]): void {
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s) this.sessions.set(id, { ...s, escalated: true });
    }
    this.emitChange();
  }

  private emitChange(): void {
    this.deps.onChange?.(this.getSessions());
  }
}