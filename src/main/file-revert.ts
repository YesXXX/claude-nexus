import * as fs from 'fs';
import * as path from 'path';
import { gitErrorText, gitOk, topInDirForm, GIT_WRITE_TIMEOUT_MS, type GitResult, type GitRunner } from './git-runner';
import { checkWritable, lockKey, lockMessage, type WriteGuard } from './write-guard';
import { displayCommand, type CommandLog } from './command-log';
import {
  DEFAULT_PRUNE, UndoStore, indexInfoInput, parseLsFilesStage, safeId, sameSnap, snapshot,
  type BackupFile, type PrunePolicy, type RevertManifest, type Snap,
} from './revert-backup';
import type { FileContext } from './change-tracker';
import type { DiffMode, Session } from '../shared/types';
import type { CommandRecord, GitOpResult, RevertEntry, RevertOptions, RevertPlan } from '../shared/review-types';

/**
 * 撤销改动列表里的单个文件，并能恢复最近一次撤销：
 * - 已跟踪文件用 git restore 把工作区与暂存区一起恢复到 HEAD（仅未提交）或 baseCommit（相对基线），
 *   重命名文件新旧两个路径一起恢复；未跟踪文件直接删除；
 * - 执行前先把涉及路径的当前内容与暂存区条目备份到 <home>/undo/，git 失败时备份作废、文件保持原样；
 * - 恢复时先写回暂存区再写回文件，之后逐个比对内容与撤销前一致；撤销后文件又被修改过时需要额外确认。
 */

export const DEFAULT_MAX_BACKUP_BYTES = 50 * 1024 * 1024;

export interface FileRevertDeps {
  home: string;
  git: GitRunner;
  guard: WriteGuard;
  log: CommandLog;
  tracker: {
    fileContext(id: string, rel: string, mode?: DiffMode): Promise<FileContext | { error: string }>;
    refresh(id: string): Promise<unknown>;
  };
  getSession: (id: string) => Session | undefined;
  isBusy: (id: string) => boolean;
  now?: () => number;
  /** 单个文件超过这个大小不备份，撤销后无法恢复 */
  maxBackupBytes?: number;
  prune?: PrunePolicy;
}

export type RevertResult = GitOpResult & { entry?: RevertEntry };

export interface RestoreOptions { overwrite?: boolean; force?: boolean }

/** 撤销前的完整准备结果：确认框展示的内容与真正执行所需的参数 */
interface Prepared {
  plan: RevertPlan;
  ctx?: FileContext;
  /** git restore 的实际参数；未跟踪文件为空 */
  args: string[];
}

const SUBMODULE_MODE = '160000';

function toEntry(m: RevertManifest): RevertEntry {
  return { id: m.id, sessionId: m.sessionId, paths: m.files.map(f => f.path), mode: m.mode, at: m.at, restorable: m.restorable };
}

function fail(message: string, extra: Partial<GitOpResult> = {}): RevertResult {
  return { ok: false, message, steps: [], ...extra };
}

function absOf(root: string, rel: string): string | undefined {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return undefined;
  const abs = path.resolve(root, ...rel.split('/'));
  const back = path.relative(root, abs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return undefined;
  return abs;
}

/** 是否同一目录：按真实路径比较，8.3 短路径、链接与长路径写法视为同一个 */
function sameDir(a: string, b: string): boolean {
  const real = (p: string): string => {
    try { return fs.realpathSync.native(p); } catch { return p; }
  };
  return lockKey(real(a)) === lockKey(real(b));
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

export class FileRevert {
  readonly store: UndoStore;
  private readonly now: () => number;
  private readonly maxBackup: number;

  constructor(private readonly deps: FileRevertDeps) {
    this.now = deps.now ?? Date.now;
    this.maxBackup = deps.maxBackupBytes ?? DEFAULT_MAX_BACKUP_BYTES;
    this.store = new UndoStore(path.join(deps.home, 'undo'), this.now);
  }

  /** 确认框所需的信息：将执行的命令、恢复到的提交、是否超大、是否正忙；不能撤销时给出原因 */
  async plan(id: string, rel: string, mode?: DiffMode): Promise<RevertPlan> {
    return (await this.prepare(id, rel, mode)).plan;
  }

  private async prepare(id: string, rel: string, mode?: DiffMode): Promise<Prepared> {
    const blocked = (reason: string, busy = false): Prepared => ({
      plan: { command: '', paths: [], source: '', untracked: false, largeBytes: 0, blocked: reason, busy }, args: [],
    });
    const w = checkWritable(this.deps.getSession(id), this.deps.isBusy);
    if (w.blocked) return blocked(w.blocked);
    const ctx = await this.deps.tracker.fileContext(id, rel, mode);
    if ('error' in ctx) return blocked(ctx.error, w.busy);
    const { file, root } = ctx;
    if (file.kind === 'conflicted') return blocked('冲突文件不能撤销，请先解决冲突', w.busy);
    const paths = file.oldPath && file.oldPath !== file.path ? [file.path, file.oldPath] : [file.path];

    let largeBytes = 0;
    for (const p of paths) {
      const abs = absOf(root, p);
      if (!abs) return blocked('非法路径', w.busy);
      let st: fs.Stats | undefined;
      try { st = fs.lstatSync(abs); } catch { st = undefined; }
      if (st?.isDirectory()) return blocked('这是目录或子模块，不能按文件撤销，请手动处理', w.busy);
      if (st?.isFile() && st.size > this.maxBackup) largeBytes = Math.max(largeBytes, st.size);
    }

    if (file.kind === 'untracked') {
      return {
        plan: { command: `删除 ${file.path}（未被 git 跟踪）`, paths, source: '', untracked: true, largeBytes, busy: w.busy },
        ctx, args: [],
      };
    }
    if (!ctx.refSha) return blocked('仓库还没有任何提交，无法撤销已跟踪的文件', w.busy);
    const ls = await this.deps.git.run(root, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...paths]);
    if (gitOk(ls) && parseLsFilesStage(ls.stdout).some(e => e.mode === SUBMODULE_MODE)) {
      return blocked('这是子模块，不能按文件撤销，请手动处理', w.busy);
    }
    const tree = await this.deps.git.run(root, ['--literal-pathspecs', 'ls-tree', '-z', ctx.refSha, '--', ...paths]);
    if (gitOk(tree) && tree.stdout.split('\0').some(l => l.startsWith(`${SUBMODULE_MODE} `))) {
      return blocked('这是子模块，不能按文件撤销，请手动处理', w.busy);
    }
    const args = ['--literal-pathspecs', 'restore', `--source=${ctx.refSha}`, '--staged', '--worktree', '--', ...paths];
    const command = displayCommand('git', ['restore', `--source=${ctx.refSha.slice(0, 7)}`, '--staged', '--worktree', '--', ...paths]);
    return { plan: { command, paths, source: ctx.refSha.slice(0, 7), untracked: false, largeBytes, busy: w.busy }, ctx, args };
  }

  /**
   * 撤销单个文件。force 表示用户已在忙碌警告里确认；large 表示已确认超大文件不备份。
   * 主进程在仓库锁内重新校验，会话刚变忙或文件刚变大时返回 needConfirm 让界面再确认一次。
   */
  async revert(id: string, rel: string, mode: DiffMode | undefined, opts: RevertOptions = {}): Promise<RevertResult> {
    const session = this.deps.getSession(id);
    if (!session) return fail('会话不存在');
    const first = await this.prepare(id, rel, mode);
    if (first.plan.blocked || !first.ctx) return fail(first.plan.blocked ?? '无法撤销');
    return this.deps.guard.withRepo(first.ctx.root, async () => {
      const prep = await this.prepare(id, rel, mode);
      const { plan, ctx } = prep;
      if (plan.blocked || !ctx) return fail(plan.blocked ?? '无法撤销');
      if (plan.busy && !opts.force) return fail('Claude 正在运行，可能马上又改这个文件', { needConfirm: 'busy' });
      if (plan.largeBytes > 0 && !opts.large) {
        return fail(`文件过大（${formatBytes(plan.largeBytes)}），不备份，撤销后无法恢复`, { needConfirm: 'large' });
      }
      return this.execute(id, ctx, prep);
    }).then(async r => {
      if (r.ok) {
        await this.deps.tracker.refresh(id).catch(() => undefined);
        this.prune();
      }
      return r;
    });
  }

  /** 在仓库锁内：备份、执行、记录撤销后的状态。任何一步失败都删除本次备份 */
  private async execute(id: string, ctx: FileContext, prep: Prepared): Promise<RevertResult> {
    const { root } = ctx;
    const { plan, args } = prep;
    const { id: entryId, dir } = this.store.create(id);
    const steps: CommandRecord[] = [];
    let manifest: RevertManifest;
    try {
      const files: BackupFile[] = [];
      let restorable = true;
      for (const [i, p] of plan.paths.entries()) {
        const abs = absOf(root, p) as string;
        const f: BackupFile = { path: p, before: await snapshot(abs) };
        if (f.before.exists && f.before.kind === 'file') {
          if (f.before.size > this.maxBackup) restorable = false;
          else {
            f.stored = `f${i}`;
            const copy = path.join(dir, f.stored);
            await fs.promises.copyFile(abs, copy);
            // 以备份副本为准记录撤销前的状态：复制期间文件若被改写，恢复的也是副本这一版
            f.before = await snapshot(copy);
          }
        }
        files.push(f);
      }
      const lsArgs = ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...plan.paths];
      const ls = await this.deps.git.run(root, lsArgs);
      if (!gitOk(ls)) {
        steps.push(this.deps.log.record(id, root, 'git', lsArgs, ls));
        throw new Error(gitErrorText(ls));
      }
      manifest = {
        version: 1, id: entryId, sessionId: id, root, mode: ctx.mode, source: plan.untracked ? '' : ctx.refSha,
        command: plan.command, at: this.now(), restorable, files, index: parseLsFilesStage(ls.stdout),
      };
      if (!this.store.write(manifest)) throw new Error('备份清单写入失败');
    } catch (err) {
      this.store.remove(id, entryId);
      return fail('备份失败，文件未改动', { detail: err instanceof Error ? err.message : String(err), steps });
    }

    let r: GitResult;
    if (plan.untracked) {
      const started = Date.now();
      const base = { stdout: '', notFound: false, timedOut: false };
      try {
        await fs.promises.unlink(absOf(root, ctx.file.path) as string);
        r = { ...base, code: 0, stderr: '', ms: Date.now() - started };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? String(err);
        r = { ...base, code: 1, stderr: `无法删除文件：${code}`, ms: Date.now() - started };
      }
      steps.push(this.deps.log.record(id, root, '删除', [ctx.file.path], r));
    } else {
      r = await this.deps.git.run(root, args, { timeoutMs: GIT_WRITE_TIMEOUT_MS });
      steps.push(this.deps.log.record(id, root, 'git', args, r));
    }
    if (!gitOk(r)) {
      this.store.remove(id, entryId);
      const lockFile = plan.untracked ? undefined : await this.deps.guard.findIndexLock(root);
      return fail('撤销失败，文件未改动', { detail: lockFile ? lockMessage(lockFile) : gitErrorText(r), steps, lockFile });
    }

    for (const f of manifest.files) {
      f.after = await snapshot(absOf(root, f.path) as string).catch((): Snap => ({ exists: false }));
    }
    this.store.write(manifest);
    const message = manifest.restorable ? `已撤销 ${ctx.file.path}` : `已撤销 ${ctx.file.path}（文件过大，未备份，无法恢复）`;
    return { ok: true, message, steps, entry: toEntry(manifest) };
  }

  /** 会话当前的仓库根：工作区会话为工作区根，普通会话按 cwd 解析 */
  private async sessionRoot(session: Session): Promise<string | undefined> {
    if (session.worktree) return path.resolve(session.worktree.path);
    if (!session.cwd || !fs.existsSync(session.cwd)) return undefined;
    const r = await this.deps.git.run(session.cwd, ['rev-parse', '--show-toplevel']);
    const top = r.stdout.trim();
    return gitOk(r) && top ? topInDirForm(session.cwd, top) : undefined;
  }

  /**
   * 恢复一次撤销：先用 update-index 写回暂存区条目，再写回文件，最后逐个比对内容与撤销前一致。
   * 文件在撤销之后又变过时，未带 overwrite 返回 needConfirm: 'overwrite'。
   */
  async restore(id: string, entryId: string, opts: RestoreOptions = {}): Promise<GitOpResult> {
    if (!safeId(id) || !safeId(entryId)) return fail('参数无效');
    const session = this.deps.getSession(id);
    const w = checkWritable(session, this.deps.isBusy);
    if (w.blocked || !session) return fail(w.blocked ?? '会话不存在');
    const first = this.store.read(id, entryId);
    if (!first) return fail('找不到这次撤销的备份，可能已被清理');
    const root = await this.sessionRoot(session);
    if (!root || !sameDir(root, first.root)) return fail('会话所在仓库已变化，不能恢复这次撤销');

    const r = await this.deps.guard.withRepo(root, () => this.restoreLocked(id, entryId, root, opts));
    if (r.ok || r.steps.length) await this.deps.tracker.refresh(id).catch(() => undefined);
    return r;
  }

  private async restoreLocked(id: string, entryId: string, root: string, opts: RestoreOptions): Promise<GitOpResult> {
    const m = this.store.read(id, entryId);
    const dir = this.store.dir(id, entryId);
    if (!m || !dir) return fail('找不到这次撤销的备份，可能已被清理');
    if (m.restoredAt) return fail('这次撤销已经恢复过了');
    if (!m.restorable) return fail('文件过大，撤销时未备份，无法恢复');
    if (this.deps.isBusy(id) && !opts.force) return fail('Claude 正在运行，可能马上又改这个文件', { needConfirm: 'busy' });
    const targets: Array<{ f: BackupFile; abs: string }> = [];
    for (const f of m.files) {
      const abs = absOf(root, f.path);
      if (!abs) return fail('备份清单里的路径无效');
      targets.push({ f, abs });
    }
    const changed: string[] = [];
    for (const t of targets) if (!sameSnap(await snapshot(t.abs), t.f.after)) changed.push(t.f.path);
    if (changed.length && !opts.overwrite) {
      return fail('撤销之后该文件又被修改过，恢复会覆盖这些修改', { needConfirm: 'overwrite', detail: changed.join('\n') });
    }

    const steps: CommandRecord[] = [];
    const args = ['update-index', '-z', '--index-info'];
    const input = indexInfoInput(m.files.map(f => f.path), m.index);
    const ix = await this.deps.git.run(root, args, { input, timeoutMs: GIT_WRITE_TIMEOUT_MS });
    steps.push(this.deps.log.record(id, root, 'git', args, ix));
    if (!gitOk(ix)) {
      const lockFile = await this.deps.guard.findIndexLock(root);
      return fail('恢复失败，文件未改动', { detail: lockFile ? lockMessage(lockFile) : gitErrorText(ix), steps, lockFile });
    }
    const errors: string[] = [];
    for (const t of targets) {
      try {
        await writeBack(dir, t.abs, t.f);
        if (!sameSnap(await snapshot(t.abs), t.f.before)) errors.push(`${t.f.path}：写回后内容与撤销前不一致`);
      } catch (err) {
        errors.push(`${t.f.path}：${(err as NodeJS.ErrnoException).code ?? String(err)}`);
      }
    }
    m.restoredAt = this.now();
    this.store.write(m);
    const name = m.files[0]?.path ?? '';
    if (errors.length) return { ok: false, message: `恢复 ${name} 未完全成功`, detail: errors.join('\n'), steps };
    return { ok: true, message: `已恢复 ${name}`, steps };
  }

  /** 该会话最近一次撤销；已恢复过时返回 null */
  last(id: string): RevertEntry | null {
    const m = this.store.list(id)[0];
    return m && !m.restoredAt ? toEntry(m) : null;
  }

  prune(): number {
    try {
      return this.store.prune(this.deps.prune ?? DEFAULT_PRUNE);
    } catch {
      return 0;
    }
  }
}

/** 把一个路径写回撤销前的状态：原本不存在的删除，文件从备份复制，符号链接重新创建 */
export async function writeBack(dir: string, abs: string, f: BackupFile): Promise<void> {
  let cur: fs.Stats | undefined;
  try { cur = await fs.promises.lstat(abs); } catch { cur = undefined; }
  if (cur?.isDirectory()) throw new Error('目标位置现在是目录');
  const before = f.before;
  if (!before.exists) {
    if (cur) await fs.promises.unlink(abs);
    return;
  }
  if (before.kind === 'dir') return;
  if (cur && (cur.isSymbolicLink() || before.kind === 'link')) await fs.promises.unlink(abs);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  if (before.kind === 'file') {
    if (!f.stored) throw new Error('缺少备份文件');
    await fs.promises.copyFile(path.join(dir, f.stored), abs);
  } else {
    await fs.promises.symlink(before.target, abs);
  }
}
