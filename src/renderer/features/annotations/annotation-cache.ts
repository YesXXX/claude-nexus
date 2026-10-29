import type { Annotation, AnnotationCheck, AnnotationList } from '../../../shared/review-types';
import type { AnnotationsBridge } from '../../core/api.js';

/**
 * 渲染层的批注缓存：按会话保存最近一次 annotations.list 的结果。
 * 同一会话并发加载时只采用最后一次请求的结果；结果变化后通知订阅者重画横条、抽屉与 diff 装饰。
 */
export class AnnotationCache {
  private readonly data = new Map<string, AnnotationList>();
  private readonly seq = new Map<string, number>();
  private readonly subs = new Set<(id: string) => void>();

  constructor(private readonly api: AnnotationsBridge) {}

  get(id: string | undefined): AnnotationList | undefined {
    return id ? this.data.get(id) : undefined;
  }

  has(id: string): boolean {
    return this.data.has(id);
  }

  async load(id: string): Promise<AnnotationList | undefined> {
    const n = (this.seq.get(id) ?? 0) + 1;
    this.seq.set(id, n);
    try {
      const r = await this.api.list(id);
      if (this.seq.get(id) !== n) return this.data.get(id);
      this.data.set(id, r);
      for (const cb of this.subs) cb(id);
      return r;
    } catch (err) {
      console.error('[annotations] 读取批注失败：', err);
      return this.data.get(id);
    }
  }

  subscribe(cb: (id: string) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
}

export function checkOf(list: AnnotationList | undefined, annId: string): AnnotationCheck | undefined {
  return list?.checks.find(c => c.id === annId);
}

/** 某个文件上的批注（重命名文件按新旧路径都算） */
export function itemsForFile(list: AnnotationList | undefined, path: string, oldPath?: string): Annotation[] {
  return (list?.items ?? []).filter(a => a.path === path || (!!oldPath && a.path === oldPath));
}

export function pendingCount(items: Annotation[]): number {
  return items.filter(a => a.status === 'pending').length;
}

/** 位置文本：a.ts:12、a.ts:12-14、a.ts 原第 7-8 行、a.ts（整个文件） */
export function locationText(path: string, side: Annotation['side'], start: number, end: number): string {
  if (side === 'file') return `${path}（整个文件）`;
  const range = end > start ? `${start}-${end}` : String(start);
  return side === 'old' ? `${path} 原第 ${range} 行` : `${path}:${range}`;
}

export function annotationLocation(a: Annotation): string {
  return locationText(a.path, a.side, a.start, a.end);
}

/** 当前文件中的行范围：行号已偏移时按新位置换算 */
export function currentRange(a: Annotation, c: AnnotationCheck | undefined): { start: number; end: number } {
  if (a.side === 'new' && c?.validity === 'moved' && c.movedTo !== undefined) {
    return { start: c.movedTo, end: c.movedTo + (a.end - a.start) };
  }
  return { start: a.start, end: a.end };
}

export interface Tag {
  text: string;
  cls: string;
  title: string;
}

/** 状态与校验标签：排队中 / 已发送优先，其次有效、行号已偏移、已失效；未校验不显示文字，只给说明 */
export function annotationTag(a: Annotation, c: AnnotationCheck | undefined): Tag | null {
  if (a.status === 'queued') return { text: '排队中', cls: 'queued', title: '本轮结束后随消息一起发送' };
  if (a.status === 'sent') return { text: '已发送', cls: 'sent', title: '已发送给 Claude，编辑后会退回待发送' };
  if (!c) return null;
  switch (c.validity) {
    case 'valid': return { text: '有效', cls: 'valid', title: '引用的行内容与当前文件一致' };
    case 'moved': return { text: `→ 第 ${c.movedTo} 行`, cls: 'moved', title: `行号已偏移，现为第 ${c.movedTo} 行，发送时自动采用新行号` };
    case 'stale': return { text: '已失效', cls: 'stale', title: `${c.reason ?? '找不到原内容'}；发送时注明行号可能已变化，以引用片段为准` };
    default: return c.reason ? { text: '', cls: 'unchecked', title: c.reason } : null;
  }
}
