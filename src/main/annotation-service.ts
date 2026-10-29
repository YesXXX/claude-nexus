import { formatAnnotations, type FormatResult } from '../shared/annotation-format';
import { log } from './logger';
import type { AnnotationStore } from './annotation-store';
import type { DropReason, PromptInjector } from './prompt-injector';
import type { Session } from '../shared/types';
import type {
  Annotation, AnnotationDraft, AnnotationList, AnnotationPreview, OutboxItem, OutboxWhen, SendResult,
} from '../shared/review-types';

/**
 * 批注业务：把批注存储、消息格式化与提示词注入器串起来。
 * 预览与发送前都先按工作区当前文件校验一次，发出的内容与预览一致；
 * 因长度限制未包含的条目保持待发送。排队的批注在发出后转为已发送，被取消或丢弃时退回待发送。
 */

export interface AnnotationServiceDeps {
  store: AnnotationStore;
  injector: Pick<PromptInjector, 'send' | 'cancel' | 'get' | 'blockedReason'>;
  getSession: (id: string) => Session | undefined;
  isBusy: (id: string) => boolean;
  /** 排队的批注已自动发出 */
  onQueuedSent?: (session: Session | undefined, count: number) => void;
  /** 需要告诉用户的情况 */
  onNotice?: (sessionId: string, message: string, level: 'info' | 'warning') => void;
}

const DROP_TEXT: Record<DropReason, string> = {
  cancelled: '已取消排队，批注退回待发送',
  exited: '会话已退出，排队的批注未发送，已退回待发送',
  killed: '会话已结束，排队的批注未发送，已退回待发送',
  restarted: '会话已重启，排队的批注未发送，已退回待发送',
  timeout: '排队的批注未能发出，已退回待发送',
};

export class AnnotationService {
  constructor(private readonly deps: AnnotationServiceDeps) {}

  list(id: string): AnnotationList {
    const { store, injector } = this.deps;
    const outbox = injector.get(id);
    return { items: store.list(id), checks: store.checks(id), ...(outbox ? { outbox } : {}) };
  }

  add(id: string, draft: AnnotationDraft): Promise<Annotation | { error: string }> {
    return this.deps.store.add(id, draft);
  }

  update(id: string, annId: string, comment: unknown): boolean {
    return this.deps.store.update(id, annId, comment);
  }

  remove(id: string, annId: string): boolean {
    return this.deps.store.remove(id, annId);
  }

  /** 校验后拼出待发送批注的消息；没有待发送批注时返回 undefined */
  private async compose(id: string): Promise<FormatResult | undefined> {
    const { store } = this.deps;
    const pending = store.pending(id);
    if (!pending.length) return undefined;
    await store.verify(id);
    const s = this.deps.getSession(id);
    const root = store.root(id) ?? s?.cwd ?? '';
    return formatAnnotations(store.pending(id), store.checks(id), { repoRoot: root, cwd: s?.cwd ?? root });
  }

  async preview(id: string): Promise<AnnotationPreview> {
    const s = this.deps.getSession(id);
    const queued = !!this.deps.injector.get(id);
    const f = await this.compose(id);
    const blocked = this.deps.injector.blockedReason(id)
      ?? (queued ? '已有排队中的消息，先取消排队再发送' : undefined)
      ?? (f ? undefined : '没有待发送的批注');
    return {
      text: f?.text ?? '',
      truncated: f?.truncated ?? false,
      count: f?.includedIds.length ?? 0,
      omitted: f?.omittedIds.length ?? 0,
      stale: f?.stale ?? 0,
      ...(blocked ? { blocked } : {}),
      busy: this.deps.isBusy(id),
      waitingPermission: s?.status === 'waiting_permission',
      pasteMode: s?.pasteMode === true,
      queued,
    };
  }

  /** 发送全部待发送批注；when 见 PromptInjector.send */
  async send(id: string, when: OutboxWhen): Promise<SendResult> {
    const blocked = this.deps.injector.blockedReason(id);
    if (blocked) return { ok: false, sent: false, queued: false, message: blocked };
    const f = await this.compose(id);
    if (!f) return { ok: false, sent: false, queued: false, message: '没有待发送的批注' };
    const r = this.deps.injector.send(id, f.text, { when, reason: 'annotations', annotationIds: f.includedIds });
    if (r.sent) {
      this.deps.store.markSent(id, f.includedIds);
      log('annotations', `会话 ${id.slice(0, 8)} 发送 ${f.includedIds.length} 条批注`);
      return { ...r, message: `已发送 ${f.includedIds.length} 条批注${omittedNote(f)}` };
    }
    if (r.queued) {
      this.deps.store.markQueued(id, f.includedIds);
      return { ...r, message: `已排队 ${f.includedIds.length} 条批注，本轮结束后发送${omittedNote(f)}` };
    }
    return r;
  }

  /** 取消排队（批注退回待发送）；没有排队消息返回 false */
  cancel(id: string): boolean {
    return !!this.deps.injector.cancel(id);
  }

  /** 注入器回调：排队消息已发出 */
  onSent(item: OutboxItem, info: { queued: boolean }): void {
    if (item.reason !== 'annotations' || !info.queued) return;
    const n = this.deps.store.markSent(item.sessionId, item.annotationIds);
    this.deps.onQueuedSent?.(this.deps.getSession(item.sessionId), n);
  }

  /** 注入器回调：排队消息被取消或丢弃 */
  onDropped(item: OutboxItem, reason: DropReason): void {
    if (item.reason !== 'annotations') return;
    const n = this.deps.store.resetQueued(item.sessionId, item.annotationIds);
    if (n && reason !== 'cancelled') this.deps.onNotice?.(item.sessionId, DROP_TEXT[reason], 'warning');
  }

  /** 改动摘要更新：有未发送批注时重新校验 */
  onSummary(id: string): void {
    if (!this.deps.store.hasOpen(id)) return;
    this.deps.store.verify(id).catch(err => log('annotations', `校验批注失败 ${id}：${String(err)}`));
  }
}

function omittedNote(f: FormatResult): string {
  return f.omittedIds.length ? `，另有 ${f.omittedIds.length} 条因长度限制留在待发送` : '';
}
