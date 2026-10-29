import { NotificationPayload, NotifyKind, NotifyMeta, PanelEvent, Session } from '../shared/types';
import type { ActivityEvent, ActivityReporter } from '../shared/activity';
import { cwdBaseName } from '../shared/session-view';
import { randomUUID } from 'crypto';

export type NotifySubscriber = (n: NotificationPayload) => void;

export interface NotificationOptions {
  escalateAfterMs?: number;  // 默认 5 分钟
  /** 等待超时的同时上报活动日志 */
  activity?: ActivityReporter;
}

/**
 * 通知决策逻辑：状态变化 / 周期超时 / 活动总线上的可通知事件 → 推送给订阅者（系统通知、webhook）。
 * 每条通知除标题与正文外带 kind 与 meta，远程推送据此按类过滤并拼结构化消息。
 */
export class NotificationService {
  private readonly escalateAfterMs: number;
  private readonly activity?: ActivityReporter;
  private readonly subscribers = new Set<NotifySubscriber>();
  /** 最近一次「等待输入」的提示文本，等待超时通知沿用 */
  private readonly inputMessages = new Map<string, string>();

  constructor(opts: NotificationOptions = {}) {
    this.escalateAfterMs = opts.escalateAfterMs ?? 5 * 60_000;
    this.activity = opts.activity;
  }

  subscribe(cb: NotifySubscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private emit(session: Session, level: NotificationPayload['level'], title: string, body: string,
    kind: NotifyKind, meta: NotifyMeta): void {
    console.log(`[notify] 会话 ${session.id.slice(0, 8)}（${session.label}）[${level}] ${title} | ${body}`);
    this.dispatch({
      id: randomUUID(), sessionId: session.id, level, title, body, createdAt: Date.now(),
      kind, meta: { label: session.label, cwdTail: cwdBaseName(session.cwd), ...meta },
    });
  }

  /**
   * 不依附会话状态变化的通知（如上下文告警、批注提示）。sessionId 缺省为全局通知，
   * 点击只唤起面板；带 sessionId 时点击直达该会话。不带 kind，不参与远程推送。
   */
  notifyGlobal(level: NotificationPayload['level'], title: string, body: string, sessionId?: string): void {
    console.log(`[notify] ${sessionId ? `会话 ${sessionId.slice(0, 8)}` : '全局'} [${level}] ${title} | ${body}`);
    this.dispatch({ id: randomUUID(), sessionId, level, title, body, createdAt: Date.now() });
  }

  /** 活动总线上的事件：只认上下文告警（事件类型沿用旧名 budget.alert），其余类型忽略（状态类通知由 onTransition 产出，避免重复） */
  onActivity(e: ActivityEvent): void {
    if (e.type !== 'budget.alert') return;
    const level = e.level === 'error' ? 'error' : 'warning';
    const body = e.detail ?? '';
    console.log(`[notify] ${e.sessionId ? `会话 ${e.sessionId.slice(0, 8)}` : '全局'} [${level}] ${e.title} | ${body}`);
    const meta: NotifyMeta = { status: '上下文告警', summary: body || e.title };
    if (e.sessionLabel) meta.label = e.sessionLabel;
    if (e.cwdTail) meta.cwdTail = e.cwdTail;
    this.dispatch({
      id: randomUUID(), sessionId: e.sessionId, level, title: e.title, body, createdAt: Date.now(), kind: 'budget', meta,
    });
  }

  private dispatch(n: NotificationPayload): void {
    for (const cb of this.subscribers) {
      try { cb(n); } catch (err) { console.error('[notify] subscriber threw:', err); }
    }
  }

  onTransition(prev: Session, curr: Session, event?: PanelEvent): void {
    if (prev.status === curr.status) return;
    if (curr.status !== 'waiting_input') this.inputMessages.delete(curr.id);
    switch (curr.status) {
      case 'waiting_permission': {
        const tool = curr.pendingAction?.toolName ?? '工具';
        const cmd = curr.pendingAction?.commandText ?? '';
        this.emit(curr, 'warning',
          `🔐 「${curr.label}」请求授权`,
          `${tool}${cmd ? `：${cmd}` : ''}，需要你点头才能继续`,
          'permission', { status: `等待批准（${tool}）`, toolName: tool, ...(cmd ? { summary: cmd } : {}) });
        break;
      }
      case 'waiting_input': {
        const msg = event?.type === 'idle_prompt' ? event.message : undefined;
        if (msg) this.inputMessages.set(curr.id, msg);
        this.emit(curr, 'info',
          `✋ 「${curr.label}」喊你决策`,
          '它已经休息了一会儿，需要你接着指挥下一步动作',
          'input', { status: '等待输入', ...(msg ? { summary: msg } : {}) });
        break;
      }
      case 'completed': {
        const ended = event?.type === 'process_exit';
        this.emit(curr, 'success',
          `✅ 「${curr.label}」已搞定`,
          '本轮任务圆满收工，点击卡片查看最终结果',
          ended ? 'ended' : 'turn', { status: ended ? '会话已退出' : '本轮结束' });
        break;
      }
      case 'error':
        if (curr.resumeFailure) {
          const code = curr.resumeFailure.exitCode ?? '未知';
          this.emit(curr, 'error',
            `❌ 「${curr.label}」续接失败`,
            curr.resumeFailure.reason === 'no_transcript'
              ? 'CLI 找不到这段对话，可以改为全新开始'
              : `续接后进程立即退出（退出码 ${code}），点我查看原因`,
            'error', { status: `续接失败（退出码 ${code}）` });
          break;
        }
        this.emit(curr, 'error',
          `❌ 「${curr.label}」异常退出`,
          `退出码 ${curr.exitCode ?? '未知'}，点我尝试复活`,
          'error', { status: `异常退出（退出码 ${curr.exitCode ?? '未知'}）` });
        break;
      case 'disconnected':
        this.emit(curr, 'error',
          `🔌 「${curr.label}」失联了`,
          '进程已不在，退出码未知，点我尝试复活',
          'lost', { status: '失联' });
        break;
      default:
        break;
    }
  }

  /** 每分钟由主进程调用一次；返回需标记 escalated 的会话 id */
  tick(sessions: Session[], now: number): string[] {
    const escalateIds: string[] = [];
    for (const s of sessions) {
      const waiting = s.status === 'waiting_permission' || s.status === 'waiting_input';
      if (waiting && !s.escalated && now - s.statusSince >= this.escalateAfterMs) {
        const minutes = Math.max(1, Math.round((now - s.statusSince) / 60_000));
        const meta: NotifyMeta = { status: `仍在等待（${minutes} 分钟）` };
        if (s.status === 'waiting_permission') {
          if (s.pendingAction?.toolName) meta.toolName = s.pendingAction.toolName;
          if (s.pendingAction?.commandText) meta.summary = s.pendingAction.commandText;
        } else {
          const msg = this.inputMessages.get(s.id);
          if (msg) meta.summary = msg;
        }
        this.emit(s, 'warning',
          `⏰ 「${s.label}」仍在等待`,
          `已经 ${minutes} 分钟没动静了，优先处理一下这个会话`,
          'overdue', meta);
        this.activity?.report({
          type: 'wait.overdue', source: 'notify', sessionId: s.id,
          detail: `${s.status === 'waiting_permission' ? '等待批准' : '等待输入'}已 ${minutes} 分钟`,
          dedupeKey: `overdue-${s.statusSince}`,
        });
        escalateIds.push(s.id);
      }
    }
    return escalateIds;
  }
}
