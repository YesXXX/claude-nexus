import { log } from './logger';
import type { DropReason, PromptInjector } from './prompt-injector';
import type { SessionListener } from './session-manager';
import type { LaunchOptions, PendingPromptState, PromptSendResult, Session } from '../shared/types';
import type { OutboxItem, OutboxReason, OutboxWhen, SendResult } from '../shared/review-types';

/**
 * 带初始提示词的会话：先按普通流程拉起会话（或接手刚创建好的用户会话），再把提示词交给发件箱的就绪模式，
 * 等收到 SessionStart、粘贴模式开启且输出静默后一次粘贴发出。
 * 就绪超时的提示词保留为待发送，用户可手动发送、插入到输入框或放弃；会话被结束或重启时一并丢弃。
 * 等待中与待发送两种状态通过 promptState 合并进会话行，变化时调用 changed 刷新列表。
 */

export interface InternalSessionDeps {
  manager: {
    createInternal(label: string, cwd: string, opts?: { launch?: LaunchOptions }): Session;
    addListener(l: SessionListener): () => void;
  };
  injector: () => PromptInjector | undefined;
  /** 给渲染层的 toast */
  notice: (sessionId: string, message: string, level: 'info' | 'warning') => void;
  /** 等待或待发送状态变化，会话列表需要重新推送 */
  changed?: () => void;
  /** 就绪等待上限，缺省 30 秒 */
  readyTimeoutMs?: number;
}

export interface StartOptions {
  reason?: OutboxReason;
  launch?: LaunchOptions;
}

export const NOT_READY_TEXT = 'Claude 尚未就绪，提示词已准备好，可在改动页手动发送';
export const INITIAL_NOT_READY_TEXT = '首条提示词未发送：Claude 在 30 秒内没有就绪，可重新发送或插入到输入框';
export const FAILED_REASON = 'Claude 在 30 秒内没有就绪（可能停在目录信任确认或启动报错）';
const READY_TIMEOUT_MS = 30_000;

interface Pending {
  text: string;
  reason: OutboxReason;
}

export class InternalSessions {
  private readonly pending = new Map<string, Pending>();
  /** 已交给发件箱、等待就绪的会话 */
  private readonly waiting = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: InternalSessionDeps) {
    this.unsubscribe = deps.manager.addListener({
      onDetach: id => {
        const a = this.pending.delete(id);
        const b = this.waiting.delete(id);
        if (a || b) this.changed();
      },
    });
  }

  private changed(): void {
    try { this.deps.changed?.(); } catch (err) { log('outbox', `刷新会话列表失败：${String(err)}`); }
  }

  /**
   * 创建会话并排一条就绪后发送的提示词；没有提示词时只创建会话。
   * 拉起失败返回 error，不留下排队状态。
   */
  start(label: string, cwd: string, prompt?: string, opts: StartOptions = {}): Session | { error: string } {
    let s: Session;
    try {
      s = this.deps.manager.createInternal(label, cwd, opts.launch ? { launch: opts.launch } : {});
    } catch (err) {
      return { error: `创建会话失败：${err instanceof Error ? err.message : String(err)}` };
    }
    this.deliver(s.id, prompt, opts.reason ?? 'prompt');
    return s;
  }

  /**
   * 给已创建的会话排一条就绪后发送的提示词（新建表单的首条提示词）。
   * 提示词为空时什么都不做；发件箱不可用时直接转为待发送并提示。
   */
  deliver(id: string, prompt: string | undefined, reason: OutboxReason = 'prompt'): void {
    const text = prompt?.trim();
    if (!text) return;
    const injector = this.deps.injector();
    const item = injector?.enqueueReady(id, text, { reason, timeoutMs: this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS });
    if (item) {
      this.waiting.add(id);
    } else {
      this.pending.set(id, { text, reason });
      this.deps.notice(id, reason === 'prompt' ? INITIAL_NOT_READY_TEXT : NOT_READY_TEXT, 'warning');
    }
    this.changed();
  }

  /** 注入器回调：就绪模式的消息离开队列；超时的转为待发送 */
  onDropped(item: OutboxItem, reason: DropReason): void {
    if (item.waitFor !== 'ready') return;
    const was = this.waiting.delete(item.sessionId);
    if (reason !== 'timeout') {
      if (was) this.changed();
      return;
    }
    this.pending.set(item.sessionId, { text: item.text, reason: item.reason });
    log('outbox', `会话 ${item.sessionId.slice(0, 8)} 未在时限内就绪，提示词保留为待发送`);
    this.deps.notice(item.sessionId, item.reason === 'prompt' ? INITIAL_NOT_READY_TEXT : NOT_READY_TEXT, 'warning');
    this.changed();
  }

  onSent(item: OutboxItem): void {
    let had = false;
    if (item.waitFor === 'ready') had = this.waiting.delete(item.sessionId);
    if (this.pending.get(item.sessionId)?.reason === item.reason) had = this.pending.delete(item.sessionId) || had;
    if (had) this.changed();
  }

  /** 待发送的提示词种类；没有时返回 undefined */
  pendingOf(id: string): OutboxReason | undefined {
    return this.pending.get(id)?.reason;
  }

  /** 合并进会话行的投递状态 */
  promptState(id: string): PendingPromptState | undefined {
    if (this.pending.has(id)) return { state: 'failed', reason: FAILED_REASON };
    if (this.waiting.has(id)) return { state: 'waiting' };
    return undefined;
  }

  /** 手动发送待发送的提示词 */
  sendPending(id: string, when: OutboxWhen): SendResult {
    const p = this.pending.get(id);
    const injector = this.deps.injector();
    if (!p || !injector) return { ok: false, sent: false, queued: false, message: '没有待发送的提示词' };
    const r = injector.send(id, p.text, { when, reason: p.reason });
    if (r.ok) {
      this.pending.delete(id);
      this.changed();
    }
    return r;
  }

  /** 把待发送的提示词写进输入框但不提交，由用户检查后自己回车 */
  insertPending(id: string): PromptSendResult {
    const p = this.pending.get(id);
    const injector = this.deps.injector();
    if (!p || !injector) return { ok: false, reason: '没有待发送的提示词' };
    const r = injector.insert(id, p.text, false);
    if (r.ok) {
      this.pending.delete(id);
      this.changed();
    }
    return r;
  }

  discardPending(id: string): boolean {
    const had = this.pending.delete(id);
    if (had) this.changed();
    return had;
  }

  dispose(): void {
    this.unsubscribe();
    this.pending.clear();
    this.waiting.clear();
  }
}
