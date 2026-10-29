import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { readJson, writeJsonAtomic } from './json-store';
import { log } from './logger';
import { checkAnchor, rangeFromHunk, splitFileLines } from '../shared/annotation-anchor';
import type { ChangeTracker } from './change-tracker';
import type { AnnotationSummary, DiffMode } from '../shared/types';
import type { Annotation, AnnotationCheck, AnnotationDraft } from '../shared/review-types';

/**
 * 批注存储：按会话保存在 <home>/annotations/<id>.json，内存里缓存一份。
 * 创建时用 ChangeTracker 重新取 diff，按分块与行序号截取范围，不信任渲染层传来的内容；
 * 校验只比较内容（见 annotation-anchor），每个文件只读一次。
 */

export const MAX_COMMENT_CHARS = 4000;
export const MAX_ANNOTATIONS = 500;
/** 已发送的批注保留时长 */
export const SENT_KEEP_MS = 24 * 60 * 60 * 1000;
/** 超过这个大小的文件不校验 */
const MAX_CHECK_BYTES = 2 * 1024 * 1024;

export interface AnnotationStoreDeps {
  /** 面板数据目录 */
  home: string;
  tracker: Pick<ChangeTracker, 'fileContext' | 'getFileDiff' | 'getRepoRoot'>;
  now?: () => number;
  newId?: () => string;
  /** 某会话的批注发生变化（增删改、状态流转、校验结果变化） */
  onChange?: (id: string) => void;
  maxCheckBytes?: number;
}

interface FileShape {
  version: 1;
  /** 创建批注时解析出的仓库根，校验时据此读文件 */
  root?: string;
  items: Annotation[];
}

interface Entry {
  root?: string;
  items: Annotation[];
  checks: Map<string, AnnotationCheck>;
}

function asMode(v: unknown): DiffMode | undefined {
  return v === 'base' || v === 'working' ? v : undefined;
}

function isAnnotation(v: unknown): v is Annotation {
  const a = v as Annotation;
  return !!a && typeof a.id === 'string' && typeof a.path === 'string' && Array.isArray(a.lines)
    && (a.side === 'new' || a.side === 'old' || a.side === 'file') && typeof a.comment === 'string';
}

/** 意见文本：去掉首尾空白，1..4000 字 */
export function cleanComment(v: unknown): string | { error: string } {
  if (typeof v !== 'string') return { error: '意见不能为空' };
  const t = v.replace(/\r\n?/g, '\n').trim();
  if (!t) return { error: '意见不能为空' };
  if (t.length > MAX_COMMENT_CHARS) return { error: `意见最多 ${MAX_COMMENT_CHARS} 字` };
  return t;
}

export class AnnotationStore {
  private readonly cache = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: AnnotationStoreDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => randomBytes(4).toString('hex'));
  }

  private dir(): string {
    return path.join(this.deps.home, 'annotations');
  }

  /**
   * 批注不放在 sessions/<id> 下：那个目录在进程退出后的下次启动会被孤儿扫描整体删除，
   * 而会话行（待续接、历史记录）仍在，批注要跟着会话记录走。
   */
  private file(id: string): string {
    return path.join(this.dir(), `${id}.json`);
  }

  /** 删除不再有会话也没有历史记录的批注文件；返回删除的个数 */
  prune(keep: (id: string) => boolean): number {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir()); } catch { return 0; }
    let n = 0;
    for (const name of names) {
      const m = /^(.+)\.json$/.exec(name);
      if (!m || keep(m[1])) continue;
      try { fs.rmSync(path.join(this.dir(), name), { force: true }); n++; } catch { /* 删不掉下次再试 */ }
      this.cache.delete(m[1]);
    }
    return n;
  }

  /** 读入缓存；已发送超过保留时长的批注顺带清掉 */
  private entry(id: string): Entry {
    let e = this.cache.get(id);
    if (!e) {
      const raw = readJson<FileShape>(this.file(id), { tag: 'annotations' });
      const items = Array.isArray(raw?.items) ? raw!.items.filter(isAnnotation) : [];
      e = { root: typeof raw?.root === 'string' ? raw.root : undefined, items, checks: new Map() };
      this.cache.set(id, e);
    }
    const cutoff = this.now() - SENT_KEEP_MS;
    const kept = e.items.filter(a => a.status !== 'sent' || (a.sentAt ?? a.updatedAt) >= cutoff);
    if (kept.length !== e.items.length) {
      e.items = kept;
      this.save(id, e);
    }
    return e;
  }

  private save(id: string, e: Entry): void {
    // 从没有批注的会话不落盘
    if (e.items.length === 0 && !fs.existsSync(this.file(id))) return;
    const data: FileShape = { version: 1, items: e.items };
    if (e.root) data.root = e.root;
    writeJsonAtomic(this.file(id), data, { tag: 'annotations', indent: 0 });
  }

  private changed(id: string, e: Entry): void {
    this.save(id, e);
    try { this.deps.onChange?.(id); } catch (err) { log('annotations', `变化回调异常：${String(err)}`); }
  }

  list(id: string): Annotation[] {
    return this.entry(id).items.map(a => ({ ...a, lines: [...a.lines] }));
  }

  /** 最近一次校验结果（只含待发送与排队中的条目） */
  checks(id: string): AnnotationCheck[] {
    const e = this.entry(id);
    return e.items.filter(a => a.status !== 'sent').map(a => e.checks.get(a.id) ?? { id: a.id, validity: 'unchecked' as const });
  }

  /** 批注所在仓库根；没有记录时退回 ChangeTracker 已解析的根 */
  root(id: string): string | undefined {
    return this.entry(id).root ?? this.deps.tracker.getRepoRoot(id);
  }

  pending(id: string): Annotation[] {
    return this.list(id).filter(a => a.status === 'pending');
  }

  /** 会话行上的摘要；没有待发送与排队中的批注时为 undefined */
  summary(id: string): AnnotationSummary | undefined {
    const items = this.entry(id).items;
    const pending = items.filter(a => a.status === 'pending').length;
    const queued = items.some(a => a.status === 'queued');
    return pending || queued ? { pending, queued } : undefined;
  }

  /** 新增批注：路径必须在改动列表里；行范围按主进程重新取的 diff 截取 */
  async add(id: string, draft: AnnotationDraft): Promise<Annotation | { error: string }> {
    if (!draft || typeof draft !== 'object' || typeof draft.path !== 'string') return { error: '参数无效' };
    const comment = cleanComment(draft.comment);
    if (typeof comment !== 'string') return comment;
    const e = this.entry(id);
    if (e.items.length >= MAX_ANNOTATIONS) return { error: `每个会话最多 ${MAX_ANNOTATIONS} 条批注` };
    const ctx = await this.deps.tracker.fileContext(id, draft.path, asMode(draft.mode));
    if ('error' in ctx) return { error: ctx.error };

    const t = this.now();
    const base = {
      id: this.newId(), path: ctx.rel, mode: ctx.mode, refSha: ctx.refSha, comment,
      status: 'pending' as const, createdAt: t, updatedAt: t,
      ...(ctx.file.oldPath ? { oldPath: ctx.file.oldPath } : {}),
    };
    let ann: Annotation;
    if (draft.side === 'file') {
      ann = { ...base, side: 'file', start: 0, end: 0, lines: [] };
    } else {
      if (!Number.isInteger(draft.hunkIndex)) return { error: '缺少分块序号' };
      const diff = await this.deps.tracker.getFileDiff(id, ctx.rel, ctx.mode);
      if (diff.error) return { error: diff.error };
      const hunk = diff.hunks[draft.hunkIndex!];
      if (!hunk) return { error: '分块不存在，改动可能已更新，请刷新后重试' };
      const r = rangeFromHunk(hunk, Number(draft.fromLine), Number(draft.toLine ?? draft.fromLine));
      if ('error' in r) return r;
      ann = { ...base, side: r.side, start: r.start, end: r.end, lines: r.lines, hunkHeader: hunk.header };
    }
    e.root = ctx.root;
    e.items.push(ann);
    e.checks.set(ann.id, { id: ann.id, validity: 'valid' });
    this.changed(id, e);
    return { ...ann, lines: [...ann.lines] };
  }

  /** 只能改意见文本；排队中的不能改（预览与实际发出的内容要一致）；已发送的改后退回待发送 */
  update(id: string, annId: string, comment: unknown): boolean {
    const text = cleanComment(comment);
    if (typeof text !== 'string') return false;
    const e = this.entry(id);
    const a = e.items.find(x => x.id === annId);
    if (!a || a.status === 'queued') return false;
    a.comment = text;
    a.updatedAt = this.now();
    if (a.status === 'sent') {
      a.status = 'pending';
      delete a.sentAt;
    }
    this.changed(id, e);
    return true;
  }

  /** 删除一条（排队中的不能删），或 'all-sent' 清除全部已发送 */
  remove(id: string, annId: string): boolean {
    const e = this.entry(id);
    const before = e.items.length;
    if (annId === 'all-sent') e.items = e.items.filter(a => a.status !== 'sent');
    else e.items = e.items.filter(a => a.id !== annId || a.status === 'queued');
    if (e.items.length === before) return false;
    for (const k of [...e.checks.keys()]) if (!e.items.some(a => a.id === k)) e.checks.delete(k);
    this.changed(id, e);
    return true;
  }

  private setStatus(id: string, ids: string[], from: Annotation['status'][], to: Annotation['status']): number {
    const e = this.entry(id);
    const want = new Set(ids);
    const t = this.now();
    let n = 0;
    for (const a of e.items) {
      if (!want.has(a.id) || !from.includes(a.status)) continue;
      a.status = to;
      a.updatedAt = t;
      if (to === 'sent') a.sentAt = t; else delete a.sentAt;
      n++;
    }
    if (n) this.changed(id, e);
    return n;
  }

  markQueued(id: string, ids: string[]): number {
    return this.setStatus(id, ids, ['pending'], 'queued');
  }

  markSent(id: string, ids: string[]): number {
    return this.setStatus(id, ids, ['pending', 'queued'], 'sent');
  }

  /** 排队被取消或丢弃：退回待发送 */
  resetQueued(id: string, ids: string[]): number {
    return this.setStatus(id, ids, ['queued'], 'pending');
  }

  /**
   * 按工作区当前文件校验待发送与排队中的批注，结果写入缓存并返回。
   * 每个文件只读一次；超过 2MB 或读取失败标为未校验。
   */
  async verify(id: string): Promise<AnnotationCheck[]> {
    const e = this.entry(id);
    const targets = e.items.filter(a => a.status !== 'sent');
    const root = this.root(id);
    const limit = this.deps.maxCheckBytes ?? MAX_CHECK_BYTES;
    const files = new Map<string, Promise<string[] | null | { reason: string }>>();
    const read = (rel: string): Promise<string[] | null | { reason: string }> => {
      let p = files.get(rel);
      if (!p) {
        p = readLines(root, rel, limit);
        files.set(rel, p);
      }
      return p;
    };
    const next = new Map<string, AnnotationCheck>();
    for (const a of targets) {
      if (a.side !== 'new') { next.set(a.id, { id: a.id, validity: 'valid' }); continue; }
      const content = await read(a.path);
      if (content && !Array.isArray(content)) next.set(a.id, { id: a.id, validity: 'unchecked', reason: content.reason });
      else next.set(a.id, checkAnchor(content, a));
    }
    const before = JSON.stringify([...e.checks.values()]);
    e.checks = next;
    if (JSON.stringify([...next.values()]) !== before) {
      try { this.deps.onChange?.(id); } catch (err) { log('annotations', `变化回调异常：${String(err)}`); }
    }
    return this.checks(id);
  }

  /** 是否有需要校验的批注（摘要更新时用来决定要不要读文件） */
  hasOpen(id: string): boolean {
    return this.entry(id).items.some(a => a.status !== 'sent');
  }

  /** 丢掉内存缓存（会话被移除时） */
  forget(id: string): void {
    this.cache.delete(id);
  }
}

/** 读文件并拆行：不存在返回 null；过大或读取失败返回原因 */
async function readLines(root: string | undefined, rel: string, limit: number): Promise<string[] | null | { reason: string }> {
  if (!root) return { reason: '仓库根未知' };
  const abs = path.resolve(root, ...rel.split('/'));
  const back = path.relative(root, abs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return { reason: '非法路径' };
  try {
    const st = await fs.promises.stat(abs);
    if (!st.isFile()) return null;
    if (st.size > limit) return { reason: '文件超过 2MB，未校验' };
    return splitFileLines(await fs.promises.readFile(abs, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return { reason: `读取失败：${code ?? String(err)}` };
  }
}
