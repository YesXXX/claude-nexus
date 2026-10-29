import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import { readJson, writeJsonAtomic } from './json-store';
import type { RecordPage, RecordQuery, SessionRecord } from '../shared/types';
import {
  canTransitionRecord, HistoryLimits, normalizeRecord, pruneCandidates, queryRecords, RECORD_VERSION, stripUndefined,
} from '../shared/session-records';
import { metaWorktree, OrphanMetadata } from './orphan-reclaimer';

/**
 * 会话记录存储：一会话一文件（<dir>/<id>.json），启动时整目录读进内存，查询走内存。
 * 写入是原子替换；高频的小改动（最近活动时间、状态）可延迟合并落盘，生命周期节点立即落盘。
 * 写盘失败只记日志，不影响会话运行。
 */

export interface RecordStoreOptions {
  now?: () => number;
  /** 记录增删改后防抖合并通知（推给渲染层） */
  onChange?: (ids: string[]) => void;
  /** 记录被删除（删除、清空、按上限清理）后同步调用，用于清理该会话的残留目录 */
  onRemoved?: (ids: string[]) => void;
  /** 变化通知的防抖时长，缺省 200ms */
  debounceMs?: number;
  /** 延迟写入的合并时长，缺省 3 秒 */
  deferMs?: number;
}

export interface PatchOptions {
  /** 延迟落盘：用于每个 hook 都会触发的最近活动时间等字段 */
  defer?: boolean;
}

/** 面板会话 id 直接做文件名，只接受安全字符 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

function errText(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string') return code;
  return err instanceof Error ? err.message : String(err);
}

/**
 * 删掉已删除记录对应的会话目录（sessionsDir/<id>）。结束的会话目录要到下次启动才被孤儿扫描清理，
 * 扫描会把没有记录的目录当作旧版遗留迁移成历史；不先删掉，删除的历史重启后会以「旧版迁移」回来。
 */
export function dropSessionDirs(sessionsDir: string, ids: readonly string[]): void {
  for (const id of ids) {
    if (!SAFE_ID.test(id)) continue;
    try { fs.rmSync(path.join(sessionsDir, id), { recursive: true, force: true }); } catch { /* 下次启动的扫描再清理 */ }
  }
}

/**
 * 把旧版遗留的会话元数据（进程已死、目录即将删除）转成一条已结束的历史记录。
 * 缺 id 或 cwd 的元数据无法续接，返回 null。
 */
export function recordFromOrphanMeta(meta: OrphanMetadata, now: number): SessionRecord | null {
  if (typeof meta.id !== 'string' || !SAFE_ID.test(meta.id)) return null;
  if (typeof meta.cwd !== 'string' || !meta.cwd) return null;
  const createdAt = typeof meta.createdAt === 'number' && Number.isFinite(meta.createdAt) ? meta.createdAt : now;
  const current = typeof meta.sessionId === 'string' && meta.sessionId ? meta.sessionId : undefined;
  const ids = Array.isArray(meta.sessionIds) ? meta.sessionIds.filter((x): x is string => typeof x === 'string' && !!x) : [];
  if (current && !ids.includes(current)) ids.push(current);
  const worktree = metaWorktree(meta);
  return stripUndefined({
    version: RECORD_VERSION,
    id: meta.id,
    label: typeof meta.label === 'string' && meta.label ? meta.label : '未命名会话',
    cwd: meta.cwd,
    createdAt,
    updatedAt: now,
    lastActiveAt: createdAt,
    endedAt: now,
    state: 'ended',
    endReason: 'migrated',
    lastStatus: 'disconnected',
    claudeSessionId: current,
    claudeSessionIds: ids,
    transcriptPath: typeof meta.transcriptPath === 'string' && meta.transcriptPath ? meta.transcriptPath : undefined,
    launch: meta.launch && typeof meta.launch === 'object' ? meta.launch : undefined,
    worktree,
    turns: 0,
    resumeCount: 0,
  }) as SessionRecord;
}

export class SessionRecordStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly pendingWrites = new Set<string>();
  private readonly pendingNotify = new Set<string>();
  private writeTimer: NodeJS.Timeout | null = null;
  private notifyTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private loadError: string | null = null;
  private skipped = 0;

  constructor(private readonly dir: string, private readonly opts: RecordStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** 读入整个目录：损坏或不认识的文件改名为 .bad，遗留的 .tmp 删除 */
  load(): { loaded: number; skipped: number } {
    let loaded = 0;
    let skipped = 0;
    this.loadError = null;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.statSync(this.dir).isDirectory()) throw new Error('路径不是目录');
    } catch (err) {
      log('records', `创建记录目录失败 ${this.dir}：${String(err)}`);
      this.loadError = `记录目录不可用（${errText(err)}）`;
      return { loaded, skipped };
    }
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      log('records', `读取记录目录失败 ${this.dir}：${String(err)}`);
      this.loadError = `读取记录目录失败（${errText(err)}）`;
      return { loaded, skipped };
    }
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (name.endsWith('.tmp')) {
        try { fs.rmSync(file, { force: true }); } catch { /* 删不掉下次再试 */ }
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const rec = normalizeRecord(readJson(file, { tag: 'records' }));
      if (!rec || `${rec.id}.json` !== name) {
        skipped++;
        this.quarantine(file);
        continue;
      }
      this.records.set(rec.id, rec);
      loaded++;
    }
    log('records', `读入会话记录 ${loaded} 条${skipped ? `，跳过损坏 ${skipped} 条` : ''}`);
    this.skipped = skipped;
    return { loaded, skipped };
  }

  /** 记录模块是否可用：目录建不了或读不了时不可用；skipped 是启动时跳过的损坏文件数 */
  status(): { ok: boolean; reason?: string; skipped: number } {
    return this.loadError ? { ok: false, reason: this.loadError, skipped: this.skipped } : { ok: true, skipped: this.skipped };
  }

  /** 固定或取消固定；记录不存在返回 false */
  setPinned(id: string, pinned: boolean): boolean {
    return this.patch(id, { pinned: pinned ? true : undefined }) !== undefined;
  }

  /** 清空已结束的记录（keepPinned 时保留固定的），exclude 里的 id 跳过；返回删除的 id */
  clear(keepPinned: boolean, exclude: (id: string) => boolean = () => false): string[] {
    const ids = [...this.records.values()]
      .filter(r => r.state === 'ended' && !(keepPinned && r.pinned === true) && !exclude(r.id))
      .map(r => r.id);
    const removed = this.remove(ids);
    if (removed.length > 0) log('records', `清空历史记录 ${removed.length} 条`);
    return removed;
  }

  private quarantine(file: string): void {
    try {
      fs.renameSync(file, `${file}.bad`);
      log('records', `记录文件无法识别，已改名为 ${path.basename(file)}.bad`);
    } catch (err) {
      log('records', `记录文件改名失败 ${file}：${String(err)}`);
    }
  }

  get(id: string): SessionRecord | undefined {
    const r = this.records.get(id);
    return r ? { ...r } : undefined;
  }

  all(): SessionRecord[] {
    return [...this.records.values()].map(r => ({ ...r }));
  }

  /** 整条写入（新建或覆盖），立即落盘 */
  upsert(rec: SessionRecord): void {
    if (!SAFE_ID.test(rec.id)) {
      log('records', `记录 id 不合法，未写入：${rec.id}`);
      return;
    }
    const prev = this.records.get(rec.id);
    const next = stripUndefined({ ...prev, ...rec, updatedAt: this.now() }) as SessionRecord;
    this.records.set(rec.id, next);
    this.commit(rec.id, false);
  }

  /**
   * 合并更新：在缓存对象上合并，不认识的字段保留；值为 undefined 的键会被删除。
   * 状态迁移不合法时丢弃状态改动、其余字段照常合并。没有任何变化时不写盘。
   */
  patch(id: string, delta: Partial<SessionRecord>, opts: PatchOptions = {}): SessionRecord | undefined {
    const prev = this.records.get(id);
    if (!prev) return undefined;
    const d: Partial<SessionRecord> = { ...delta };
    if (d.state && !canTransitionRecord(prev.state, d.state)) {
      log('records', `记录 ${id.slice(0, 8)} 不允许 ${prev.state} → ${d.state}，忽略状态改动`);
      delete d.state;
    }
    const merged = { ...prev } as Record<string, unknown>;
    let changed = false;
    for (const [k, v] of Object.entries(d)) {
      if (v === undefined) {
        if (k in merged) { delete merged[k]; changed = true; }
      } else if (JSON.stringify(merged[k]) !== JSON.stringify(v)) {
        merged[k] = v;
        changed = true;
      }
    }
    if (!changed) return { ...prev };
    merged.updatedAt = this.now();
    const next = merged as unknown as SessionRecord;
    this.records.set(id, next);
    this.commit(id, opts.defer === true);
    return { ...next };
  }

  /** 删除记录，只删 ended；返回实际删除的 id。只删记录文件，不碰对话记录与工作区 */
  remove(ids: string[]): string[] {
    const out: string[] = [];
    for (const id of ids) {
      const r = this.records.get(id);
      if (!r || r.state !== 'ended') continue;
      this.records.delete(id);
      this.pendingWrites.delete(id);
      try { fs.rmSync(this.fileOf(id), { force: true }); } catch (err) {
        log('records', `删除记录文件失败 ${id.slice(0, 8)}：${String(err)}`);
      }
      out.push(id);
    }
    if (out.length > 0) {
      try { this.opts.onRemoved?.(out); } catch (err) { log('records', `删除后清理失败：${String(err)}`); }
      this.notify(out);
    }
    return out;
  }

  query(q: RecordQuery = {}): RecordPage {
    const page = queryRecords([...this.records.values()], q);
    return { items: page.items.map(r => ({ ...r })), total: page.total };
  }

  /** 按历史上限清理 ended 记录，返回删除的 id */
  prune(limits: HistoryLimits): string[] {
    const ids = pruneCandidates([...this.records.values()], limits, this.now());
    if (ids.length === 0) return [];
    const removed = this.remove(ids);
    log('records', `清理历史记录 ${removed.length} 条`);
    return removed;
  }

  /** 立即写出全部延迟中的改动，并发出待发的变化通知 */
  flush(): void {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    const ids = [...this.pendingWrites];
    this.pendingWrites.clear();
    for (const id of ids) this.writeFile(id);
    if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null; }
    this.emitNotify();
  }

  /** 退出前调用：落盘延迟改动，之后不再发通知 */
  dispose(): void {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null; }
    const ids = [...this.pendingWrites];
    this.pendingWrites.clear();
    for (const id of ids) this.writeFile(id);
    this.pendingNotify.clear();
  }

  private fileOf(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private commit(id: string, defer: boolean): void {
    if (defer) {
      this.pendingWrites.add(id);
      if (!this.writeTimer) {
        this.writeTimer = setTimeout(() => { this.writeTimer = null; this.flushDeferred(); }, this.opts.deferMs ?? 3000);
        this.writeTimer.unref?.();
      }
    } else {
      this.pendingWrites.delete(id);
      this.writeFile(id);
    }
    this.notify([id]);
  }

  private flushDeferred(): void {
    const ids = [...this.pendingWrites];
    this.pendingWrites.clear();
    for (const id of ids) this.writeFile(id);
  }

  private writeFile(id: string): void {
    const rec = this.records.get(id);
    if (!rec) return;
    writeJsonAtomic(this.fileOf(id), stripUndefined(rec), { tag: 'records' });
  }

  private notify(ids: string[]): void {
    if (!this.opts.onChange) return;
    for (const id of ids) this.pendingNotify.add(id);
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => { this.notifyTimer = null; this.emitNotify(); }, this.opts.debounceMs ?? 200);
    this.notifyTimer.unref?.();
  }

  private emitNotify(): void {
    if (this.pendingNotify.size === 0) return;
    const ids = [...this.pendingNotify];
    this.pendingNotify.clear();
    try { this.opts.onChange?.(ids); } catch (err) { log('records', `变化通知失败：${String(err)}`); }
  }
}
