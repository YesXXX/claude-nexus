import * as fs from 'fs';
import * as path from 'path';
import { RawHookPayload, Session, SubagentEntry } from '../shared/types';
import {
  extractTaskDescription, isAcompactAgent, judgeAlive, parseJsonlLine, renderSubagentLine, renderSubagentLines,
} from '../shared/subagent-log';
import { log } from './logger';

/** 单个 agent 文本缓冲上限（字符）：超出丢头，防长跑代理内存无限增长 */
export const SUBAGENT_BUFFER_MAX_CHARS = 400_000;

/** 单个会话下已结束（completed/aborted）子代理条目保留上限：超出自动淘汰最旧的，
 *  防止长会话反复派生子代理后列表无限增长。运行中的条目永不淘汰。 */
export const SUBAGENT_ENTRY_MAX = 30;

/** 轮询周期：全部 running 条目共用一个定时器 */
export const POLL_INTERVAL_MS = 1000;

export type SubagentPhase = 'start' | 'stop' | 'abort';

export interface SubagentTrackerDeps {
  now?: () => number;
  /** fs 注入点（单测 mock）；readFileSync 抛错带 code（ENOENT/EBUSY） */
  readFileSync?: (p: string) => Buffer;
  existsSync?: (p: string) => boolean;
  readdirSync?: (dir: string) => string[];
  /** 条目增删/状态变化 → 触发 panel:sessions 全量推送 */
  onChange?: () => void;
  /** 增量文本 → panel:subagent-output；end = 该块追加后缓冲的累计字符数（渲染层据此去重） */
  onOutput?: (sessionId: string, agentId: string, chunk: string, end: number) => void;
  /** 子代理生命周期：启动、完成、中止（父进程退出或 transcript 消失）各回调一次，活动日志据此记事件 */
  onLifecycle?: (sessionId: string, entry: SubagentEntry, phase: SubagentPhase) => void;
}

/** 回放快照：text 为缓冲尾部（可能已丢头），end 为截至快照的累计字符数 */
export interface SubagentLogSnapshot {
  text: string;
  end: number;
}

interface PollState {
  /** 已消费到的字节偏移（永远停在最后一个完整换行后） */
  offset: number;
  /** 是否成功读过至少一次：Start 时 transcript 常尚未建盘，未读过前 ENOENT 不判死 */
  everRead: boolean;
}

/**
 * 子代理生命周期 + transcript 轮询。
 * 条目归属：Map<panelSessionId, Map<agentId, {entry, poll}>>，
 * SessionManager 在 getSessions() 时拉平合并进 Session.subagents。
 */
export class SubagentTracker {
  private readonly groups = new Map<string, Map<string, { entry: SubagentEntry; poll?: PollState }>>();
  private readonly buffers = new Map<string, string>();   // key = sessionId + '\0' + agentId
  private readonly totals = new Map<string, number>();    // 同 key：累计追加字符数（不因丢头回退）
  private readonly now: () => number;
  private readonly readFileSync: (p: string) => Buffer;
  private readonly existsSync: (p: string) => boolean;
  private readonly readdirSync: (dir: string) => string[];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SubagentTrackerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.readFileSync = deps.readFileSync ?? ((p: string) => fs.readFileSync(p));
    this.existsSync = deps.existsSync ?? ((p: string) => fs.existsSync(p));
    this.readdirSync = deps.readdirSync ?? ((d: string) => fs.readdirSync(d));
  }

  /** 启动共享轮询定时器（幂等；单测直接调 tick() 不必 start） */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** hook 分流入口：SubagentStart 建条目入轮询；SubagentStop 完成并停轮询 */
  handleHook(sessionId: string, payload: RawHookPayload): void {
    const name = payload.hook_event_name;
    const agentId = normalizeAgentId(payload.agent_id ?? agentIdFromTranscript(payload.agent_transcript_path) ?? '');
    if (!agentId) {
      log('subagent', `忽略无 agent_id 的事件 ${name}（会话 ${sessionId.slice(0, 8)}）`);
      return;
    }
    if (isAcompactAgent(agentId)) return;   // 内部压缩代理：不建条目

    if (name === 'SubagentStart') {
      if (this.find(sessionId, agentId)) return;   // 重复 Start（重启窗口）幂等
      // SubagentStart 不带子 transcript 路径（文件尚未创建）：由父会话 transcript 推导
      // <root>/<proj>/<claudeId>.jsonl → <root>/<proj>/<claudeId>/subagents/agent-<id>.jsonl
      const transcriptPath = payload.agent_transcript_path
        ?? deriveTranscriptFromParent(payload.transcript_path, agentId)
        ?? '';
      const entry: SubagentEntry = {
        agentId,
        agentType: payload.agent_type ?? 'unknown',
        description: this.readDescription(transcriptPath),
        transcriptPath,
        status: 'running',
        statusSince: this.now(),
        startedAt: this.now(),
      };
      this.group(sessionId).set(agentId, { entry, poll: transcriptPath ? { offset: 0, everRead: false } : undefined });
      log('subagent', `会话 ${sessionId.slice(0, 8)} 子代理启动：${entry.agentType} ${agentId.slice(0, 8)}（${entry.description ?? '无描述'}）`);
      this.lifecycle(sessionId, entry, 'start');
      this.deps.onChange?.();
      return;
    }

    if (name === 'SubagentStop') {
      const found = this.find(sessionId, agentId);
      if (!found) return;   // 面板重启窗口丢了 Start：忽略迟到的 Stop
      found.poll = undefined;   // 停轮询（缓冲保留供回看）
      found.entry = {
        ...found.entry,
        status: 'completed',
        statusSince: this.now(),
        lastMessage: payload.last_assistant_message,
        description: found.entry.description ?? this.readDescription(found.entry.transcriptPath),
      };
      this.evictOverflow(sessionId);
      log('subagent', `会话 ${sessionId.slice(0, 8)} 子代理完成：${agentId.slice(0, 8)}`);
      this.lifecycle(sessionId, found.entry, 'stop');
      this.deps.onChange?.();
    }
  }

  /** 生命周期回调：订阅方抛错只记日志，不影响条目状态 */
  private lifecycle(sessionId: string, entry: SubagentEntry, phase: SubagentPhase): void {
    try { this.deps.onLifecycle?.(sessionId, entry, phase); } catch (err) {
      log('subagent', `生命周期订阅者出错：${String(err)}`);
    }
  }

  /** 父会话 PTY 退出（自然退出或 kill）：running 子代理统一转 aborted；已完成的不动 */
  abortChildren(sessionId: string): void {
    const group = this.groups.get(sessionId);
    if (!group) return;
    const aborted: SubagentEntry[] = [];
    for (const { entry } of group.values()) {
      if (entry.status !== 'running') continue;
      entry.status = 'aborted';
      entry.statusSince = this.now();
      aborted.push(entry);
    }
    if (aborted.length > 0) {
      // running 条目的 poll 状态一并作废
      for (const state of group.values()) state.poll = undefined;
      this.evictOverflow(sessionId);
      log('subagent', `会话 ${sessionId.slice(0, 8)} 父进程退出：running 子代理转 aborted`);
      for (const entry of aborted) this.lifecycle(sessionId, entry, 'abort');
      this.deps.onChange?.();
    }
  }

  /** 父会话从列表移除（kill/restart）：条目与缓冲全清 */
  clearSession(sessionId: string): void {
    const group = this.groups.get(sessionId);
    if (!group) return;
    for (const agentId of group.keys()) {
      this.buffers.delete(bufKey(sessionId, agentId));
      this.totals.delete(bufKey(sessionId, agentId));
    }
    this.groups.delete(sessionId);
    this.deps.onChange?.();
  }

  /** 手动关闭单个已结束（completed/aborted）子代理条目：从列表移除并清缓冲。
   *  运行中的条目拒绝关闭（避免关掉还在追踪的进程留下的孤儿轮询状态）。
   *  返回是否实际移除，供渲染层判断是否需要回退视图。 */
  dismissSubagent(sessionId: string, agentId: string): boolean {
    const group = this.groups.get(sessionId);
    const found = group?.get(agentId);
    if (!group || !found || found.entry.status === 'running') return false;
    group.delete(agentId);
    this.buffers.delete(bufKey(sessionId, agentId));
    this.totals.delete(bufKey(sessionId, agentId));
    log('subagent', `会话 ${sessionId.slice(0, 8)} 手动关闭子代理：${agentId.slice(0, 8)}`);
    this.deps.onChange?.();
    return true;
  }

  /** 供 SessionManager 合并进 Session.subagents（无条目返回空数组，序列化干净） */
  getSubagents(sessionId: string): SubagentEntry[] {
    return [...(this.groups.get(sessionId)?.values() ?? [])].map(s => s.entry);
  }

  /** 渲染层切换视图时回放全量缓冲 */
  getLog(sessionId: string, agentId: string): string {
    return this.buffers.get(bufKey(sessionId, agentId)) ?? '';
  }

  /** 回放快照：附带累计偏移，渲染层与随后到达的增量对齐去重 */
  getLogSnapshot(sessionId: string, agentId: string): SubagentLogSnapshot {
    const key = bufKey(sessionId, agentId);
    return { text: this.buffers.get(key) ?? '', end: this.totals.get(key) ?? 0 };
  }

  /** 单轮轮询：遍历全部 running 条目，按字节偏移增量读取 transcript，
   *  只消费到最后一个完整换行（半行偏移回退，下轮重读），渲染后追加缓冲并推送。 */
  tick(): void {
    for (const [sessionId, group] of this.groups) {
      for (const [agentId, state] of group) {
        if (!state.poll || !state.entry.transcriptPath) continue;
        let buf: Buffer;
        try {
          buf = this.readFileSync(state.entry.transcriptPath);
          state.poll.everRead = true;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' && state.poll.everRead) {
            // 读过之后文件消失：条目转 aborted、停轮询。未读过（Start 时尚未建盘）
            // 与 EBUSY 等占用错误：静默等下一轮，轮询天然重试。
            state.poll = undefined;
            state.entry = { ...state.entry, status: 'aborted', statusSince: this.now() };
            log('subagent', `transcript 消失，子代理转 aborted：${agentId.slice(0, 8)}`);
            this.lifecycle(sessionId, state.entry, 'abort');
            this.deps.onChange?.();
          }
          continue;
        }
        if (buf.length < state.poll.offset) state.poll.offset = 0;   // 文件被截断重写：从头再来
        if (buf.length <= state.poll.offset) continue;
        const whole = buf.slice(state.poll.offset).toString('utf8');
        const nl = whole.lastIndexOf('\n');
        if (nl < 0) continue;   // 尚无完整行
        state.poll.offset += nl + 1;
        const rendered: string[] = [];
        for (const line of whole.slice(0, nl).split('\n')) {
          if (!line.trim()) continue;
          const text = renderSubagentLine(parseJsonlLine(line));
          if (text !== null) rendered.push(text);
        }
        if (rendered.length === 0) continue;
        // 首批输出到达时补齐任务标题（Start 时 meta/jsonl 常尚未就绪）
        if (!state.entry.description) {
          const desc = extractTaskDescription(whole.slice(0, nl));
          if (desc) {
            state.entry = { ...state.entry, description: desc };
            this.deps.onChange?.();
          }
        }
        const chunk = rendered.join('\n') + '\n';
        const end = this.appendBuffer(sessionId, agentId, chunk);
        this.deps.onOutput?.(sessionId, agentId, chunk, end);
      }
    }
  }

  /**
   * 重启重建：扫 claudeProjectsRoot 下所有项目目录，找到该 claudeSessionId 的 subagents/ 目录，
   * 末段活性判定为 running 的建条目并续 poll（offset 置文件末尾，只追增量）；
   * 已完成的不重建。返回重建数量。
   */
  reconstruct(session: Session, claudeProjectsRoot: string): number {
    const claudeId = session.claudeSessionId;
    if (!claudeId) return 0;
    let built = 0;
    let projects: string[] = [];
    try {
      projects = this.readdirSync(claudeProjectsRoot);
    } catch {
      return 0;   // ~/.claude/projects 不存在：无面板外数据可重建
    }
    for (const proj of projects) {
      const dir = path.join(claudeProjectsRoot, proj, claudeId, 'subagents');
      if (!this.existsSync(dir)) continue;
      let files: string[] = [];
      try {
        files = this.readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.startsWith('agent-') || !file.endsWith('.jsonl')) continue;
        const agentId = file.slice('agent-'.length, -'.jsonl'.length);
        if (isAcompactAgent(agentId)) continue;
        if (this.find(session.id, agentId)) continue;   // 已有条目不重复建
        const transcriptPath = path.join(dir, file);
        let text = '';
        let size = 0;
        try {
          const raw = this.readFileSync(transcriptPath);
          text = raw.toString('utf8');
          size = raw.length;
        } catch {
          continue;
        }
        if (!judgeAlive(text)) continue;   // 末行闭合：已完成，不重建
        const entry: SubagentEntry = {
          agentId,
          agentType: this.readMeta(transcriptPath)?.agentType ?? 'unknown',
          description: this.readDescription(transcriptPath) ?? extractTaskDescription(text),
          transcriptPath,
          status: 'running',
          statusSince: this.now(),
          startedAt: this.now(),
        };
        this.group(session.id).set(agentId, { entry, poll: { offset: size, everRead: true } });
        this.appendBuffer(session.id, agentId, renderSubagentLines(text) + '\n');
        built++;
        log('subagent', `重建运行中子代理：${entry.agentType} ${agentId.slice(0, 8)}（${entry.description ?? '无描述'}）`);
      }
    }
    if (built > 0) this.deps.onChange?.();
    return built;
  }

  private find(sessionId: string, agentId: string): { entry: SubagentEntry; poll?: PollState } | undefined {
    return this.groups.get(sessionId)?.get(agentId);
  }

  private group(sessionId: string): Map<string, { entry: SubagentEntry; poll?: PollState }> {
    let g = this.groups.get(sessionId);
    if (!g) { g = new Map(); this.groups.set(sessionId, g); }
    return g;
  }

  /** 已结束条目数超过 SUBAGENT_ENTRY_MAX 时，按 statusSince 从旧到新淘汰多出的部分
   *  （运行中的永不参与淘汰）。调用方负责在淘汰后统一 onChange。 */
  private evictOverflow(sessionId: string): void {
    const group = this.groups.get(sessionId);
    if (!group) return;
    const done = [...group.entries()].filter(([, v]) => v.entry.status !== 'running');
    const overflow = done.length - SUBAGENT_ENTRY_MAX;
    if (overflow <= 0) return;
    done.sort((a, b) => a[1].entry.statusSince - b[1].entry.statusSince);
    for (let i = 0; i < overflow; i++) {
      const [agentId] = done[i];
      group.delete(agentId);
      this.buffers.delete(bufKey(sessionId, agentId));
      this.totals.delete(bufKey(sessionId, agentId));
    }
    log('subagent', `会话 ${sessionId.slice(0, 8)} 已结束子代理超过上限（${SUBAGENT_ENTRY_MAX}），自动淘汰 ${overflow} 条最旧的`);
  }

  /** 追加到缓冲（超上限丢头），返回追加后的累计字符数 */
  private appendBuffer(sessionId: string, agentId: string, chunk: string): number {
    const key = bufKey(sessionId, agentId);
    const merged = (this.buffers.get(key) ?? '') + chunk;
    this.buffers.set(key, merged.length > SUBAGENT_BUFFER_MAX_CHARS
      ? merged.slice(-SUBAGENT_BUFFER_MAX_CHARS)
      : merged);
    const end = (this.totals.get(key) ?? 0) + chunk.length;
    this.totals.set(key, end);
    return end;
  }

  /** meta.json（与 jsonl 同名 + .meta.json）：description 优先、agentType 次之 */
  private readMeta(transcriptPath: string): { agentType?: string; description?: string } | undefined {
    if (!transcriptPath) return undefined;
    const metaPath = transcriptPath.replace(/\.jsonl$/, '.meta.json');
    if (!metaPath.endsWith('.meta.json') || !this.existsSync(metaPath)) return undefined;
    try {
      return JSON.parse(this.readFileSync(metaPath).toString('utf8'));
    } catch {
      return undefined;
    }
  }

  /** description 来源：meta.json.description 优先，降级 jsonl 首行 prompt 截断 */
  private readDescription(transcriptPath: string): string | undefined {
    const fromMeta = this.readMeta(transcriptPath)?.description;
    if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta;
    if (!transcriptPath || !this.existsSync(transcriptPath)) return undefined;
    try {
      return extractTaskDescription(this.readFileSync(transcriptPath).toString('utf8'));
    } catch {
      return undefined;
    }
  }
}

function bufKey(sessionId: string, agentId: string): string {
  return sessionId + '\0' + agentId;
}

/** 从 transcript 路径抠 agentId：…/subagents/agent-<id>.jsonl → <id> */
function agentIdFromTranscript(transcriptPath?: string): string | undefined {
  if (!transcriptPath) return undefined;
  const base = path.basename(transcriptPath);
  const m = base.match(/^agent-(.+)\.jsonl$/);
  return m ? m[1] : undefined;
}

/** hook 实测 agent_id 可能带 agent- 前缀（与文件名口径不一致），统一剥掉前缀对齐文件名 */
function normalizeAgentId(agentId: string): string {
  return agentId.replace(/^agent-/, '');
}

function deriveTranscriptFromParent(parentTranscriptPath?: string, agentId?: string): string | undefined {
  if (!parentTranscriptPath || !agentId) return undefined;
  if (!parentTranscriptPath.endsWith('.jsonl')) return undefined;
  return `${parentTranscriptPath.slice(0, -'.jsonl'.length)}/subagents/agent-${agentId}.jsonl`;
}
