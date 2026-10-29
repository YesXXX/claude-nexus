import { AnnotationStore } from './annotation-store';
import { AnnotationService } from './annotation-service';
import { PromptInjector } from './prompt-injector';
import { registerAnnotationIpc } from './ipc-annotations';
import type { ChangeTracker } from './change-tracker';
import type { SessionManager } from './session-manager';
import type { NotifyLevel } from '../shared/types';
import type { OutboxItem } from '../shared/review-types';
import type { DropReason } from './prompt-injector';

/**
 * 批注与发件箱的接线：存储先于 SessionManager 创建（会话行要带批注摘要），
 * 注入器与业务层在 SessionManager 之后创建（要订阅会话事件）。
 *
 * 推给渲染层的通道：
 * - panel:annotations-changed { id }：某会话的批注或排队状态变化，渲染层据此重新拉取列表；
 * - panel:outbox-notice { id, message, level }：排队丢弃、回车被跳过等需要 toast 的情况。
 */

export interface AnnotationWiringDeps {
  home: string;
  changes: ChangeTracker;
  /** 向渲染层推消息；窗口不存在或正在退出时由实现忽略 */
  push: (channel: string, payload: unknown) => void;
  /** 系统通知 */
  notify: (level: NotifyLevel, title: string, body: string, sessionId?: string) => void;
  /** 会话行需要刷新（批注摘要变化） */
  refreshSessions: () => void;
}

/** 注入器回调的额外订阅者：收尾等模块按 reason 过滤自己的消息 */
export interface OutboxSubscriber {
  onSent?: (item: OutboxItem, info: { queued: boolean }) => void;
  onDropped?: (item: OutboxItem, reason: DropReason) => void;
}

export class AnnotationWiring {
  readonly store: AnnotationStore;
  injector!: PromptInjector;
  service!: AnnotationService;
  private readonly subscribers = new Set<OutboxSubscriber>();
  private lastKey = new Map<string, string>();

  constructor(private readonly deps: AnnotationWiringDeps) {
    this.store = new AnnotationStore({
      home: deps.home,
      tracker: deps.changes,
      onChange: id => this.changed(id),
    });
  }

  /** 批注或排队状态变化：通知渲染层；摘要变了再刷新会话行 */
  private changed(id: string): void {
    this.deps.push('panel:annotations-changed', { id });
    const s = this.store.summary(id);
    const key = s ? `${s.pending}|${s.queued}` : '';
    if (this.lastKey.get(id) === key) return;
    this.lastKey.set(id, key);
    this.deps.refreshSessions();
  }

  /** SessionManager 创建之后调用：创建注入器与业务层并注册 IPC */
  attach(manager: SessionManager): void {
    const notice = (id: string, message: string, level: 'info' | 'warning'): void =>
      this.deps.push('panel:outbox-notice', { id, message, level });
    this.injector = new PromptInjector({
      host: manager,
      onSent: (item, info) => {
        this.service.onSent(item, info);
        for (const s of this.subscribers) s.onSent?.(item, info);
      },
      onDropped: (item, reason) => {
        this.service.onDropped(item, reason);
        for (const s of this.subscribers) s.onDropped?.(item, reason);
      },
      onNotice: notice,
      onChange: id => this.changed(id),
    });
    this.service = new AnnotationService({
      store: this.store,
      injector: this.injector,
      getSession: id => manager.getSession(id),
      isBusy: id => manager.isBusy(id),
      onQueuedSent: (session, count) => {
        if (!session || count <= 0) return;
        this.deps.notify('info', `已把批注发送给 ${session.label}`, `${count} 条批注已在本轮结束后发出`, session.id);
      },
      onNotice: notice,
    });
    registerAnnotationIpc(this.service);
  }

  subscribe(s: OutboxSubscriber): () => void {
    this.subscribers.add(s);
    return () => { this.subscribers.delete(s); };
  }

  /** 改动摘要更新（每次统计都调，不受去重影响） */
  onSummary(id: string): void {
    this.service?.onSummary(id);
  }

  dispose(): void {
    this.injector?.dispose();
  }
}
