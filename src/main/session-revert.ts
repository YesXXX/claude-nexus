import * as fs from 'fs';
import * as path from 'path';
import { checkWritable, type WriteGuard } from './write-guard';
import { DEFAULT_PRUNE, UndoStore, safeId, sameSnap, snapshot, type BackupFile, type RevertManifest, type Snap } from './revert-backup';
import { DEFAULT_MAX_BACKUP_BYTES, writeBack, type RestoreOptions, type RevertResult } from './file-revert';
import type { ChangeEntry, SessionChanges } from './session-changes';
import type { Session } from '../shared/types';
import type { GitOpResult, RevertEntry, RevertOptions, RevertPlan } from '../shared/review-types';

/**
 * 撤销「本会话改动」里的单个文件：把文件写回本会话第一次改它之前的内容（改前不存在的直接删除），
 * 与仓库无关，普通目录与跨仓库的文件同样适用。执行前把当前内容备份到 <home>/undo-session/，可以恢复最近一次撤销。
 * 没有改前内容、改前内容未保存、改前已有未提交改动（只能按 HEAD 近似）的文件不能撤销。
 */

export interface SessionRevertDeps {
  home: string;
  guard: WriteGuard;
  changes: Pick<SessionChanges, 'entry' | 'baselinePath' | 'current' | 'refresh'>;
  getSession: (id: string) => Session | undefined;
  isBusy: (id: string) => boolean;
  now?: () => number;
  maxBackupBytes?: number;
}

interface Prepared {
  plan: RevertPlan;
  entry?: ChangeEntry;
  /** 改前内容副本；改前不存在时缺省 */
  blob?: string;
}

function fail(message: string, extra: Partial<GitOpResult> = {}): RevertResult {
  return { ok: false, message, steps: [], ...extra };
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

function toEntry(m: RevertManifest): RevertEntry {
  return {
    id: m.id, sessionId: m.sessionId, paths: m.files.map(f => path.join(m.root, f.path)), mode: m.mode,
    at: m.at, restorable: m.restorable, scope: 'session',
  };
}

export class SessionRevert {
  readonly store: UndoStore;
  private readonly now: () => number;
  private readonly maxBackup: number;

  constructor(private readonly deps: SessionRevertDeps) {
    this.now = deps.now ?? Date.now;
    this.maxBackup = deps.maxBackupBytes ?? DEFAULT_MAX_BACKUP_BYTES;
    this.store = new UndoStore(path.join(deps.home, 'undo-session'), this.now);
  }

  async plan(id: string, p: unknown): Promise<RevertPlan> {
    return (await this.prepare(id, p)).plan;
  }

  private async prepare(id: string, p: unknown): Promise<Prepared> {
    const blocked = (reason: string, busy = false): Prepared => ({
      plan: { command: '', paths: [], source: '', untracked: false, largeBytes: 0, blocked: reason, busy },
    });
    const w = checkWritable(this.deps.getSession(id), this.deps.isBusy);
    if (w.blocked) return blocked(w.blocked);
    const e = this.deps.changes.entry(id, p);
    if (!e) return blocked('文件不在本会话改动中', w.busy);
    const b = e.base;
    if (b.kind === 'none') return blocked('没有改前内容，不能撤销', w.busy);
    if (b.approx) return blocked('改前已有未提交改动，只能按 HEAD 版本对比，不能撤销', w.busy);
    let blob: string | undefined;
    if (b.kind === 'blob') {
      blob = this.deps.changes.baselinePath(id, e);
      if (!blob) return blocked('改前内容超过备份上限，未保存，不能撤销', w.busy);
    }
    let st: fs.Stats | undefined;
    try { st = await fs.promises.lstat(e.abs); } catch { st = undefined; }
    if (st?.isDirectory()) return blocked('这个位置现在是目录，不能按文件撤销', w.busy);
    if (st?.isSymbolicLink()) return blocked('这个位置现在是符号链接，请手动处理', w.busy);
    const cur = await this.deps.changes.current(id, e);
    if (cur === undefined) return blocked('无法读取文件', w.busy);
    if (b.kind === 'absent' ? cur === null : cur === b.sha256) return blocked('文件已是改前内容', w.busy);
    const largeBytes = st?.isFile() && st.size > this.maxBackup ? st.size : 0;
    const command = b.kind === 'absent' ? `删除 ${e.abs}（本会话新建）` : `恢复 ${e.abs} 为本会话首次修改前的内容`;
    return {
      plan: { command, paths: [e.abs], source: '', untracked: b.kind === 'absent', largeBytes, busy: w.busy },
      entry: e, blob,
    };
  }

  /** 撤销单个文件；force 为已确认忙碌警告，large 为已确认超大文件不备份 */
  async revert(id: string, p: unknown, opts: RevertOptions = {}): Promise<RevertResult> {
    if (!safeId(id)) return fail('参数无效');
    const first = await this.prepare(id, p);
    if (first.plan.blocked || !first.entry) return fail(first.plan.blocked ?? '无法撤销');
    const r = await this.deps.guard.withRepoLock(first.entry.abs, async () => {
      const prep = await this.prepare(id, p);
      if (prep.plan.blocked || !prep.entry) return fail(prep.plan.blocked ?? '无法撤销');
      if (prep.plan.busy && !opts.force) return fail('Claude 正在运行，可能马上又改这个文件', { needConfirm: 'busy' });
      if (prep.plan.largeBytes > 0 && !opts.large) {
        return fail(`文件过大（${formatBytes(prep.plan.largeBytes)}），不备份，撤销后无法恢复`, { needConfirm: 'large' });
      }
      return this.execute(id, prep);
    });
    if (r.ok) {
      await this.deps.changes.refresh(id).catch(() => undefined);
      this.prune();
    }
    return r;
  }

  private async execute(id: string, prep: Prepared): Promise<RevertResult> {
    const e = prep.entry as ChangeEntry;
    const abs = e.abs;
    const { id: entryId, dir } = this.store.create(id);
    let manifest: RevertManifest;
    try {
      const f: BackupFile = { path: path.basename(abs), before: await snapshot(abs) };
      let restorable = true;
      if (f.before.exists && f.before.kind === 'file') {
        if (f.before.size > this.maxBackup) restorable = false;
        else {
          f.stored = 'f0';
          const copy = path.join(dir, f.stored);
          await fs.promises.copyFile(abs, copy);
          f.before = await snapshot(copy);
        }
      }
      manifest = {
        version: 1, id: entryId, sessionId: id, root: path.dirname(abs), mode: 'working', source: '',
        command: prep.plan.command, at: this.now(), restorable, files: [f], index: [],
      };
      if (!this.store.write(manifest)) throw new Error('备份清单写入失败');
    } catch (err) {
      this.store.remove(id, entryId);
      return fail('备份失败，文件未改动', { detail: err instanceof Error ? err.message : String(err) });
    }

    try {
      if (e.base.kind === 'absent') {
        await fs.promises.unlink(abs).catch(err => {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        });
      } else {
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.copyFile(prep.blob as string, abs);
      }
    } catch (err) {
      // 复制中途失败时文件可能已被截断：从刚才的备份写回
      const f = manifest.files[0];
      if (f.stored) await writeBack(dir, abs, f).catch(() => undefined);
      this.store.remove(id, entryId);
      return fail('撤销失败，文件未改动', { detail: (err as NodeJS.ErrnoException).code ?? String(err) });
    }

    const f = manifest.files[0];
    f.after = await snapshot(abs).catch((): Snap => ({ exists: false }));
    this.store.write(manifest);
    if (e.base.kind === 'blob' && !(f.after.exists && f.after.kind === 'file' && f.after.sha256 === e.base.sha256)) {
      return { ok: false, message: `撤销 ${abs} 后内容与改前不一致`, steps: [], entry: toEntry(manifest) };
    }
    const message = manifest.restorable ? `已撤销 ${abs}` : `已撤销 ${abs}（文件过大，未备份，无法恢复）`;
    return { ok: true, message, steps: [], entry: toEntry(manifest) };
  }

  /** 恢复最近一次撤销；撤销后文件又变过时未带 overwrite 返回 needConfirm: 'overwrite' */
  async restore(id: string, entryId: string, opts: RestoreOptions = {}): Promise<GitOpResult> {
    if (!safeId(id) || !safeId(entryId)) return fail('参数无效');
    const w = checkWritable(this.deps.getSession(id), this.deps.isBusy);
    if (w.blocked) return fail(w.blocked);
    const first = this.store.read(id, entryId);
    const f0 = first?.files[0];
    if (!first || !f0) return fail('找不到这次撤销的备份，可能已被清理');
    const abs = path.join(first.root, f0.path);
    if (path.basename(f0.path) !== f0.path || !path.isAbsolute(first.root)) return fail('备份清单里的路径无效');
    const r = await this.deps.guard.withRepoLock(abs, async () => {
      const m = this.store.read(id, entryId);
      const dir = this.store.dir(id, entryId);
      const f = m?.files[0];
      if (!m || !dir || !f) return fail('找不到这次撤销的备份，可能已被清理');
      if (m.restoredAt) return fail('这次撤销已经恢复过了');
      if (!m.restorable) return fail('文件过大，撤销时未备份，无法恢复');
      if (this.deps.isBusy(id) && !opts.force) return fail('Claude 正在运行，可能马上又改这个文件', { needConfirm: 'busy' });
      if (!sameSnap(await snapshot(abs).catch((): Snap => ({ exists: false })), f.after) && !opts.overwrite) {
        return fail('撤销之后该文件又被修改过，恢复会覆盖这些修改', { needConfirm: 'overwrite', detail: abs });
      }
      try {
        await writeBack(dir, abs, f);
      } catch (err) {
        return fail(`恢复 ${abs} 失败`, { detail: err instanceof Error ? err.message : String(err) });
      }
      m.restoredAt = this.now();
      this.store.write(m);
      if (!sameSnap(await snapshot(abs), f.before)) return fail(`恢复 ${abs} 未完全成功`, { detail: '写回后内容与撤销前不一致' });
      return { ok: true, message: `已恢复 ${abs}`, steps: [] };
    });
    await this.deps.changes.refresh(id).catch(() => undefined);
    return r;
  }

  /** 该会话最近一次撤销；已恢复过时返回 null */
  last(id: string): RevertEntry | null {
    const m = this.store.list(id)[0];
    return m && !m.restoredAt ? toEntry(m) : null;
  }

  prune(): number {
    try {
      return this.store.prune(DEFAULT_PRUNE);
    } catch {
      return 0;
    }
  }
}
