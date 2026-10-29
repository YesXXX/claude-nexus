import { randomBytes } from 'crypto';
import { log } from './logger';
import { checkWritable } from './write-guard';
import { pasteBlock, sanitizeForPaste } from '../shared/paste-mode';
import { busyAfter, HOOKS_VERSION } from '../shared/status-engine';
import type { SessionListener } from './session-manager';
import type { PanelEvent, PromptSendResult, Session } from '../shared/types';
import type { OutboxItem, OutboxReason, OutboxWhen, SendResult } from '../shared/review-types';

/**
 * 提示词注入器（发件箱）：把多行消息以一次 bracketed paste 加一次独立回车写入会话的 pty。
 *
 * 写入方式：先写 ESC[200~ + 清洗后的正文 + ESC[201~，间隔 enterDelayMs 后单独写 \r；
 * 间隔内若收到权限请求，就不写回车（回车会被当成权限选择），并提示用户检查输入框。
 *
 * 每个会话最多一条排队消息，两种等待方式：
 * - idle：等本轮结束。会话存在、有 pty、非只读、busy 为假、不在等待权限，且距最后一个让 busy 变假的事件
 *   已过 settleMs 时发出。hooks 配置早于当前版本的会话收不到提交提示词事件，还要求排队后见过一次空闲事件。
 * - ready：新建的会话等 Claude 就绪。除上面的条件外，还要收到过 SessionStart、粘贴模式已开启、
 *   终端输出已静默 quietMs；超过 deadline 仍未就绪则以 timeout 原因丢弃，由调用方保留提示词并提示。
 * 会话退出、被结束或重启时排队消息丢弃，由 onDropped 回调退回业务状态；只读期间保持排队。
 */

export interface InjectorHost {
  getSession(id: string): Session | undefined;
  /** 保守的忙碌判断（老会话视为可能正忙） */
  isBusy(id: string): boolean;
  hasLivePty(id: string): boolean;
  writeInput(id: string, data: string): boolean;
  addListener(l: SessionListener): () => void;
}

export type DropReason = 'cancelled' | 'exited' | 'killed' | 'restarted' | 'timeout';

export interface PromptInjectorDeps {
  host: InjectorHost;
  now?: () => number;
  /** 消息已写入 pty；queued 表示是排队后自动发出的 */
  onSent?: (item: OutboxItem, info: { queued: boolean }) => void;
  /** 排队消息被取消或丢弃 */
  onDropped?: (item: OutboxItem, reason: DropReason) => void;
  /** 需要告诉用户的情况（回车被跳过、排队过久等） */
  onNotice?: (sessionId: string, message: string, level: 'info' | 'warning') => void;
  /** 某会话的排队状态变化 */
  onChange?: (sessionId: string) => void;
  settleMs?: number;
  enterDelayMs?: number;
  quietMs?: number;
  readyTimeoutMs?: number;
  /** 排队超过这个时长提醒一次 */
  remindAfterMs?: number;
}

export interface SendOptions {
  when: OutboxWhen;
  reason?: OutboxReason;
  annotationIds?: string[];
}

export interface ReadyOptions {
  reason?: OutboxReason;
  annotationIds?: string[];
  timeoutMs?: number;
}

interface Track {
  /** 收到过 SessionStart */
  started: boolean;
  /** 最后一个让 busy 变假的事件时间 */
  idleAt: number;
  /** 最后一次终端输出时间 */
  outputAt: number;
  item?: OutboxItem;
  /** 排队后见过空闲事件 */
  sawIdle: boolean;
  timer?: ReturnType<typeof setTimeout>;
  remind?: ReturnType<typeof setTimeout>;
  /** 粘贴已写、回车尚未写的窗口期内收到了权限请求 */
  permissionDuringEnter: boolean;
  enterPending: boolean;
}

export const DEFAULT_SETTLE_MS = 500;
export const DEFAULT_ENTER_DELAY_MS = 30;
export const DEFAULT_QUIET_MS = 800;
export const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_REMIND_MS = 30 * 60_000;

export class PromptInjector {
  private readonly tracks = new Map<string, Track>();
  private readonly now: () => number;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: PromptInjectorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.unsubscribe = deps.host.addListener({
      onEvent: (id, ev) => this.onEvent(id, ev),
      onOutput: id => this.onOutput(id),
      onDetach: (id, reason) => this.drop(id, reason, true),
    });
  }

  private track(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = { started: false, idleAt: 0, outputAt: 0, sawIdle: false, permissionDuringEnter: false, enterPending: false };
      this.tracks.set(id, t);
    }
    return t;
  }

  /**
   * 把一段文本写进会话输入框，submit 为真时随后回车提交（插入模板、手动发送首条提示词用）。
   * 拒绝：只读、进程已退出、等待权限审批，以及粘贴模式未开启时的多行文本（每个换行都会被当成一次提交）。
   * 粘贴模式开启时整段包在粘贴标记里写入；未开启时单行文本去掉控制字符后按键入写入。
   * 正忙时照常写入，由 Claude Code 自己排在本轮之后。
   */
  insert(id: string, text: string, submit: boolean): PromptSendResult {
    const blocked = this.blockedReason(id);
    if (blocked) return { ok: false, reason: blocked };
    const s = this.deps.host.getSession(id)!;
    if (s.status === 'waiting_permission') return { ok: false, reason: 'Claude 正在等你确认权限，先处理权限再插入' };
    const body = text.replace(/\r\n?/g, '\n');
    if (!body.trim()) return { ok: false, reason: '提示词为空' };
    const paste = s.pasteMode === true;
    if (!paste && body.includes('\n')) return { ok: false, reason: '终端未开启粘贴模式，多行文本会被拆成多条提交，请等 Claude 输入框就绪后再试' };
    const data = paste ? pasteBlock(body) : sanitizeForPaste(body);
    if (!submit) {
      if (!this.deps.host.writeInput(id, data)) return { ok: false, reason: '写入终端失败' };
      log('outbox', `会话 ${id.slice(0, 8)} 插入提示词（${body.length} 字，未提交）`);
      return { ok: true };
    }
    if (!this.writeThenEnter(id, this.track(id), data)) return { ok: false, reason: '写入终端失败' };
    log('outbox', `会话 ${id.slice(0, 8)} 插入并提交提示词（${body.length} 字）`);
    return { ok: true };
  }

  /** 本会话正在排队的消息 */
  get(id: string): OutboxItem | undefined {
    const item = this.tracks.get(id)?.item;
    return item ? { ...item, annotationIds: [...item.annotationIds] } : undefined;
  }

  /** 不能写入的原因；可写时返回 undefined */
  blockedReason(id: string): string | undefined {
    const w = checkWritable(this.deps.host.getSession(id), () => false);
    if (w.blocked) return w.blocked;
    if (!this.deps.host.hasLivePty(id)) return '会话进程已退出';
    return undefined;
  }

  /**
   * 发送一条消息。
   * auto：空闲即发；正忙或等待权限时不发，返回 needChoice 让用户选。
   * now：立即发（正忙也发，由 Claude Code 自己排队）；等待权限时一律拒绝。
   * queue：排队，本轮结束后发出；当前已空闲则按发出条件尽快发出。
   */
  send(id: string, text: string, opts: SendOptions): SendResult {
    const blocked = this.blockedReason(id);
    if (blocked) return { ok: false, sent: false, queued: false, message: blocked };
    const t = this.track(id);
    if (t.item) return { ok: false, sent: false, queued: false, message: '已有排队中的消息，先取消排队再发送' };
    const s = this.deps.host.getSession(id)!;
    const warnPasteMode = s.pasteMode !== true;
    const waitingPermission = s.status === 'waiting_permission';
    const busy = this.deps.host.isBusy(id);
    const extra = warnPasteMode ? { warnPasteMode } : {};

    if (opts.when === 'queue') {
      const item = this.newItem(id, text, opts.reason, opts.annotationIds, 'idle');
      t.item = item;
      t.sawIdle = false;
      this.armRemind(id, t);
      log('outbox', `会话 ${id.slice(0, 8)} 排队一条消息（${item.reason}，${text.length} 字）`);
      this.changed(id);
      const sent = this.pump(id);
      return sent
        ? { ok: true, sent: true, queued: false, message: '已发送', ...extra }
        : { ok: true, sent: false, queued: true, message: '已排队，本轮结束后发送', ...extra };
    }
    if (waitingPermission) {
      return {
        ok: false, sent: false, queued: false, needChoice: 'permission',
        message: 'Claude 正在等你确认权限，先处理权限再发送', ...extra,
      };
    }
    if (opts.when === 'auto' && busy) {
      return { ok: false, sent: false, queued: false, needChoice: 'busy', message: 'Claude 正在处理本轮任务', ...extra };
    }
    const item = this.newItem(id, text, opts.reason, opts.annotationIds, 'idle');
    if (!this.write(id, t, item)) return { ok: false, sent: false, queued: false, message: '写入终端失败' };
    this.deps.onSent?.(item, { queued: false });
    return { ok: true, sent: true, queued: false, message: '已发送', ...extra };
  }

  /**
   * 新建会话后排一条提示词，等 Claude 就绪（SessionStart、粘贴模式开启、输出静默）后自动发出。
   * 已有排队消息时覆盖前一条（前一条按取消处理）。
   */
  enqueueReady(id: string, text: string, opts: ReadyOptions = {}): OutboxItem | undefined {
    const s = this.deps.host.getSession(id);
    if (!s || s.readOnly) return undefined;
    const t = this.track(id);
    if (t.item) this.drop(id, 'cancelled', false);
    const timeout = opts.timeoutMs ?? this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const item = this.newItem(id, text, opts.reason, opts.annotationIds, 'ready');
    item.deadline = this.now() + timeout;
    t.item = item;
    t.sawIdle = false;
    log('outbox', `会话 ${id.slice(0, 8)} 等待就绪后发送提示词（${item.reason}，${text.length} 字）`);
    this.changed(id);
    this.pump(id);
    return this.get(id);
  }

  /** 取消排队；返回被取消的消息 */
  cancel(id: string): OutboxItem | undefined {
    return this.drop(id, 'cancelled', false);
  }

  dispose(): void {
    this.unsubscribe();
    for (const t of this.tracks.values()) this.clearTimers(t);
    this.tracks.clear();
  }

  private newItem(id: string, text: string, reason: OutboxReason | undefined, ids: string[] | undefined, waitFor: OutboxItem['waitFor']): OutboxItem {
    return {
      id: randomBytes(4).toString('hex'), sessionId: id, reason: reason ?? 'prompt', text,
      annotationIds: [...(ids ?? [])], createdAt: this.now(), waitFor,
    };
  }

  private changed(id: string): void {
    try { this.deps.onChange?.(id); } catch (err) { log('outbox', `变化回调异常：${String(err)}`); }
  }

  private clearTimers(t: Track): void {
    if (t.timer) clearTimeout(t.timer);
    if (t.remind) clearTimeout(t.remind);
    t.timer = undefined;
    t.remind = undefined;
  }

  private armRemind(id: string, t: Track): void {
    const ms = this.deps.remindAfterMs ?? DEFAULT_REMIND_MS;
    t.remind = setTimeout(() => {
      t.remind = undefined;
      if (t.item) this.deps.onNotice?.(id, '排队的消息已等待超过 30 分钟，可在批注区取消排队或立即发送', 'info');
    }, ms);
    t.remind.unref?.();
  }

  private drop(id: string, reason: DropReason, detach: boolean): OutboxItem | undefined {
    const t = this.tracks.get(id);
    if (!t) return undefined;
    const item = t.item;
    this.clearTimers(t);
    t.item = undefined;
    if (detach) {
      // 进程换了：就绪状态与时间点都要重新计算
      t.started = false;
      t.idleAt = 0;
      t.outputAt = 0;
    }
    if (!item) return undefined;
    log('outbox', `会话 ${id.slice(0, 8)} 排队消息丢弃（${reason}）`);
    this.deps.onDropped?.(item, reason);
    this.changed(id);
    return item;
  }

  private onEvent(id: string, ev: PanelEvent): void {
    const t = this.track(id);
    if (ev.type === 'session_started') t.started = true;
    if (ev.type === 'permission_request' && t.enterPending) t.permissionDuringEnter = true;
    if (busyAfter(ev) === false) {
      t.idleAt = this.now();
      if (t.item) t.sawIdle = true;
    }
    if (ev.type === 'process_exit') {
      this.drop(id, 'exited', false);
      t.started = false;
      return;
    }
    if (t.item) this.pump(id);
  }

  private onOutput(id: string): void {
    const t = this.tracks.get(id);
    if (!t) return;
    t.outputAt = this.now();
    if (t.item?.waitFor === 'ready') this.pump(id);
  }

  /** 满足发出条件就写入并返回 true；只差时间条件时定时重试 */
  private pump(id: string): boolean {
    const t = this.tracks.get(id);
    const item = t?.item;
    if (!t || !item) return false;
    const now = this.now();
    if (item.waitFor === 'ready' && item.deadline !== undefined && now >= item.deadline) {
      // 超时由调用方在 onDropped 里决定如何保留提示词并提示用户
      this.drop(id, 'timeout', false);
      return false;
    }
    const s = this.deps.host.getSession(id);
    if (!s || s.readOnly || !this.deps.host.hasLivePty(id)) return this.schedule(id, t, item);
    if (s.busy === true || s.status === 'waiting_permission') return this.schedule(id, t, item);
    const legacy = (s.hooksVersion ?? 0) < HOOKS_VERSION;
    if (item.waitFor === 'idle' && legacy && !t.sawIdle) return false;
    if (item.waitFor === 'ready' && (!t.started || s.pasteMode !== true)) return this.schedule(id, t, item);
    const settle = this.deps.settleMs ?? DEFAULT_SETTLE_MS;
    const wait = Math.max(
      t.idleAt ? t.idleAt + settle - now : 0,
      item.waitFor === 'ready' ? t.outputAt + (this.deps.quietMs ?? DEFAULT_QUIET_MS) - now : 0,
    );
    if (wait > 0) return this.schedule(id, t, item, wait);
    this.clearTimers(t);
    t.item = undefined;
    if (!this.write(id, t, item)) {
      log('outbox', `会话 ${id.slice(0, 8)} 排队消息写入失败，丢弃`);
      this.deps.onDropped?.(item, 'exited');
      this.changed(id);
      return false;
    }
    log('outbox', `会话 ${id.slice(0, 8)} 排队消息已发出（${item.reason}）`);
    this.deps.onSent?.(item, { queued: true });
    this.changed(id);
    return true;
  }

  /** 定时重试：给了等待时长就按时长，否则只在 ready 模式下按截止时间兜底 */
  private schedule(id: string, t: Track, item: OutboxItem, wait?: number): false {
    if (t.timer) clearTimeout(t.timer);
    t.timer = undefined;
    const ms = wait ?? (item.waitFor === 'ready' && item.deadline !== undefined ? item.deadline - this.now() : undefined);
    if (ms === undefined) return false;
    t.timer = setTimeout(() => { t.timer = undefined; this.pump(id); }, Math.max(1, ms));
    t.timer.unref?.();
    return false;
  }

  /** 粘贴与回车分两次写；回车前收到权限请求就不写回车 */
  private write(id: string, t: Track, item: OutboxItem): boolean {
    return this.writeThenEnter(id, t, pasteBlock(item.text));
  }

  private writeThenEnter(id: string, t: Track, data: string): boolean {
    if (!this.deps.host.writeInput(id, data)) return false;
    t.enterPending = true;
    t.permissionDuringEnter = false;
    const enter = setTimeout(() => {
      t.enterPending = false;
      if (t.permissionDuringEnter) {
        t.permissionDuringEnter = false;
        log('outbox', `会话 ${id.slice(0, 8)} 粘贴后收到权限请求，未发送回车`);
        this.deps.onNotice?.(id, '消息已粘贴到输入框，但 Claude 随即请求权限，未自动提交，请检查输入框', 'warning');
        return;
      }
      this.deps.host.writeInput(id, '\r');
    }, this.deps.enterDelayMs ?? DEFAULT_ENTER_DELAY_MS);
    enter.unref?.();
    return true;
  }
}
