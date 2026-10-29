import * as fs from 'fs';
import * as path from 'path';
import { GitResult, GitRunner, gitErrorText, gitOk, topInDirForm } from './git-runner';
import {
  addedFileDiff, countLines, looksBinary, parseNameStatusZ, parseNumstatZ, parsePorcelainV2, parseUnifiedDiff,
} from '../shared/git-parse';
import { LOCAL_CONFIG_FILES } from './worktree-manager';
import { log } from './logger';
import type {
  ChangedFile, ChangeList, ChangeSummary, DiffMode, FileDiff, PanelEvent, WorktreeInfo,
} from '../shared/types';

/** git 的空树对象：仓库还没有任何提交时，「仅未提交」口径以它为比较起点 */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const DEFAULT_DEBOUNCE_MS = 800;
const SLOW_REFRESH_MS = 1500;          // 上次统计超过这个耗时，改为只在一轮结束时刷新
const DEFAULT_MAX_FILES = 500;
const MAX_DIFF_LINES = 5000;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_COUNT_BYTES = 1024 * 1024;   // 未跟踪文件超过这个大小不统计行数
const BINARY_SNIFF_BYTES = 8000;
const READ_CONCURRENCY = 16;           // 统计未跟踪文件行数时的并发读取数

/** 改动统计只需要会话的这两项信息 */
export interface TrackedSession {
  cwd: string;
  worktree?: WorktreeInfo;
}

/** 改动列表里单个文件的上下文 */
export interface FileContext {
  rel: string;
  /** 仓库根（工作区会话为工作区根） */
  root: string;
  abs: string;
  mode: DiffMode;
  file: ChangedFile;
  /** 旧侧对应的完整提交 sha；仅未提交口径且仓库没有提交时为空串 */
  refSha: string;
}

export interface ChangeTrackerDeps {
  git: GitRunner;
  getSession: (id: string) => TrackedSession | undefined;
  /** 摘要重新计算并写入缓存后回调（后台刷新与按需拉取都会触发） */
  onSummary?: (id: string, s: ChangeSummary) => void;
  /** 同一仓库根下其他存活的普通会话数，用于提示改动来源可能混杂；缺省为 0 */
  countSharedCwd?: (id: string) => number;
  debounceMs?: number;
  /** 文件列表上限，超过截断；缺省 500 */
  maxFiles?: number;
  now?: () => number;
}

interface SessionState {
  root?: string;                       // 解析成功的仓库根（工作区会话为工作区根）
  rootCwd?: string;                    // 解析仓库根时所用的目录，会话 cwd 变化时重新解析
  summary?: ChangeSummary;
  mode?: DiffMode;                     // 最近一次按需拉取指定的口径，后台刷新沿用
  files: Map<string, ChangedFile>;     // 最近一次文件列表，单文件 diff 的白名单
  filesMode?: DiffMode;
  storedSeq: number;                   // 已写入缓存的计算序号，防止较早开始的计算覆盖较新的结果
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
  dirty: boolean;
  lastMs: number;                      // 上次统计耗时
}

interface Collected {
  summary: ChangeSummary;
  files: ChangedFile[];
  truncated: boolean;
}

type RootResult = { root: string } | { error: string };
type RefResult = { ref: string } | { error: string };

/** 列表附带的仓库根：统计成功才给，渲染层用它把相对路径拼成完整地址 */
function rootOf(st: SessionState, summary: ChangeSummary): { root?: string } {
  return st.root && !summary.error ? { root: st.root } : {};
}

/**
 * 忽略空白口径下的空结果说明：能进改动列表说明内容确有变化（列表统计不忽略空白），
 * 忽略后差异消失即只剩空白差异；纯重命名维持原有说明，它本来就没有文本差异。
 */
function withWsNotice(diff: FileDiff, file: ChangedFile, ws: boolean): FileDiff {
  if (ws && !diff.binary && diff.hunks.length === 0 && file.kind !== 'renamed') {
    diff.emptyText = '忽略空白后没有差异（可能仅空白变化），关闭「忽略空白」可查看';
  }
  return diff;
}

/**
 * 按会话维护 git 改动摘要：事件驱动的合并刷新、慢仓库降频、文件列表与单文件 diff。
 * 只执行只读 git 命令，且由 GitRunner 统一关闭可选锁，不与 Claude 自己的 git 操作抢 index.lock。
 */
export class ChangeTracker {
  private readonly states = new Map<string, SessionState>();
  private readonly debounceMs: number;
  private readonly maxFiles: number;
  private readonly now: () => number;
  private seq = 0;

  constructor(private readonly deps: ChangeTrackerDeps) {
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxFiles = deps.maxFiles ?? DEFAULT_MAX_FILES;
    this.now = deps.now ?? (() => Date.now());
  }

  /** 缓存的摘要；尚未统计过返回 undefined */
  getSummary(id: string): ChangeSummary | undefined {
    return this.states.get(id)?.summary;
  }

  /** 已解析出的仓库根（未统计过或非仓库时为 undefined），供调用方计算共用目录的会话数 */
  getRepoRoot(id: string): string | undefined {
    return this.states.get(id)?.root;
  }

  /**
   * 完整文件列表，同时刷新摘要缓存；指定的口径会被记住，后台刷新沿用。
   * remember 为 false 时只计算不写缓存：不改变会话当前口径与摘要，也不触发摘要回调（批次对比用）。
   */
  async getChanges(id: string, mode?: DiffMode, opts: { remember?: boolean } = {}): Promise<ChangeList> {
    const sess = this.deps.getSession(id);
    const sharedWith = sess && !sess.worktree ? this.deps.countSharedCwd?.(id) ?? 0 : 0;
    if (opts.remember === false) {
      const st: SessionState = this.states.get(id) ?? { files: new Map(), storedSeq: 0, dirty: false, lastMs: 0 };
      const c = sess
        ? await this.collect(sess, st, mode ?? st.mode)
        : errorCollected(mode ?? 'working', '会话不存在', this.now());
      return { summary: c.summary, files: c.files, truncated: c.truncated, sharedWith, ...rootOf(st, c.summary) };
    }
    const st = this.state(id);
    if (mode) st.mode = mode;
    const c = await this.computeAndStore(id, st, mode ?? st.mode);
    return { summary: c.summary, files: c.files, truncated: c.truncated, sharedWith, ...rootOf(st, c.summary) };
  }

  /**
   * 单文件 diff。路径必须在该会话最近一次文件列表里，且解析后不能跑出仓库根，
   * 防止渲染层借此读取任意文件。ignoreWs 为真时忽略空白差异（git diff -w），
   * 忽略后没有差异的文件给出「仅空白变化」的说明而不是空白内容。
   */
  async getFileDiff(id: string, relPath: string, mode?: DiffMode, opts: { ignoreWs?: boolean } = {}): Promise<FileDiff> {
    const fail = (error: string, p = relPath): FileDiff => ({ path: p, binary: false, truncated: false, hunks: [], error });
    const w = await this.whitelisted(id, relPath, mode);
    if ('error' in w) return fail(w.error, w.rel);
    const { rel, sess, m, file, root, abs } = w;

    if (file.kind === 'untracked') return this.untrackedDiff(rel, abs);

    const refRes = await this.resolveRef(root, sess, m);
    if ('error' in refRes) return fail(refRes.error, rel);
    const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
    const ws = opts.ignoreWs === true;
    const r = await this.deps.git.run(root, [
      'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', ...(ws ? ['-w'] : []), refRes.ref, '--', ...paths,
    ]);
    if (!gitOk(r)) return fail(gitErrorText(r), rel);
    let out = r.stdout;
    let cut = false;
    if (out.length > MAX_DIFF_BYTES) {
      out = out.slice(0, out.lastIndexOf('\n', MAX_DIFF_BYTES) + 1);
      cut = true;
    }
    const parsed = parseUnifiedDiff(out, MAX_DIFF_LINES);
    const diff: FileDiff = { path: rel, binary: parsed.binary, truncated: parsed.truncated || cut, hunks: parsed.hunks };
    if (out.includes('\uFFFD')) diff.notUtf8 = true;
    return withWsNotice(diff, file, ws);
  }

  /** 改动列表里某个文件的绝对路径（打开 / 定位用），校验规则与单文件 diff 相同 */
  async resolveChangedPath(id: string, relPath: string, mode?: DiffMode): Promise<{ abs: string } | { error: string }> {
    const w = await this.whitelisted(id, relPath, mode);
    return 'error' in w ? { error: w.error } : { abs: w.abs };
  }

  /**
   * 改动列表里某个文件的上下文（批注、撤销用）：校验规则与单文件 diff 相同，
   * 另外给出旧侧对应的提交（相对基线为 baseCommit，仅未提交为当前 HEAD 的 sha，空仓库为空串）。
   */
  async fileContext(id: string, relPath: string, mode?: DiffMode): Promise<FileContext | { error: string }> {
    const w = await this.whitelisted(id, relPath, mode);
    if ('error' in w) return { error: w.error };
    let refSha = '';
    if (w.m === 'base' && w.sess.worktree) refSha = w.sess.worktree.baseCommit;
    else {
      const r = await this.deps.git.run(w.root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      if (r.notFound || r.timedOut) return { error: gitErrorText(r) };
      if (gitOk(r)) refSha = r.stdout.trim();
    }
    return { rel: w.rel, root: w.root, abs: w.abs, mode: w.m, file: w.file, refSha };
  }

  /**
   * 路径白名单：必须在该会话最近一次文件列表里，且解析后不能跑出仓库根，
   * 防止渲染层借此读取或打开任意文件。
   */
  private async whitelisted(id: string, relPath: string, mode?: DiffMode): Promise<
    { rel: string; sess: TrackedSession; m: DiffMode; file: ChangedFile; root: string; abs: string }
    | { error: string; rel?: string }
  > {
    const rel = normalizeRelPath(relPath);
    if (!rel) return { error: '非法路径' };
    const sess = this.deps.getSession(id);
    if (!sess) return { error: '会话不存在', rel };
    const st = this.state(id);
    const m = effectiveMode(sess, mode ?? st.mode);

    let file = st.filesMode === m ? st.files.get(rel) : undefined;
    if (!file) {
      // 缓存列表可能已过时或口径不同：按请求口径重新取一次列表再校验（不写缓存，不改变摘要口径）
      const fresh = await this.collect(sess, st, m);
      file = fresh.files.find(f => f.path === rel);
    }
    if (!file) return { error: '文件不在改动列表中', rel };

    const rootRes = await this.resolveRoot(st, sess);
    if ('error' in rootRes) return { error: rootRes.error, rel };
    const root = rootRes.root;
    const abs = path.resolve(root, ...rel.split('/'));
    const back = path.relative(root, abs);
    if (!back || back.startsWith('..') || path.isAbsolute(back)) return { error: '非法路径', rel };
    return { rel, sess, m, file, root, abs };
  }

  /** 重新统计摘要并写入缓存、回调。同一会话不会并发统计：进行中再次请求只标记，结束后补跑一次 */
  async refresh(id: string): Promise<ChangeSummary | undefined> {
    const st = this.state(id);
    if (st.running) {
      st.dirty = true;
      await st.running;
      return this.states.get(id)?.summary;
    }
    st.running = this.refreshLoop(id, st);
    await st.running;
    return this.states.get(id)?.summary;
  }

  /** 会话事件入口：工具执行完与一轮结束时合并刷新；慢仓库只在一轮结束时刷新 */
  onEvent(id: string, event: PanelEvent): void {
    if (event.type !== 'tool_finished' && event.type !== 'turn_completed') return;
    const st = this.state(id);
    if (event.type === 'tool_finished' && st.lastMs > SLOW_REFRESH_MS) return;
    // 已有待执行的刷新时直接并入它：从第一个事件起最多等待 debounceMs，连续事件不会无限推迟刷新
    if (st.timer) return;
    st.timer = setTimeout(() => {
      st.timer = undefined;
      void this.refresh(id);
    }, this.debounceMs);
    st.timer.unref?.();
  }

  /** 会话被移除：清掉定时器与缓存，进行中的统计结果也不再写回 */
  forget(id: string): void {
    const st = this.states.get(id);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    st.dirty = false;
    this.states.delete(id);
  }

  dispose(): void {
    for (const st of this.states.values()) {
      if (st.timer) clearTimeout(st.timer);
      st.timer = undefined;
      st.dirty = false;
    }
  }

  private state(id: string): SessionState {
    let st = this.states.get(id);
    if (!st) {
      st = { files: new Map(), storedSeq: 0, dirty: false, lastMs: 0 };
      this.states.set(id, st);
    }
    return st;
  }

  private async refreshLoop(id: string, st: SessionState): Promise<void> {
    try {
      do {
        st.dirty = false;
        await this.computeAndStore(id, st, st.mode);
      } while (st.dirty && this.states.get(id) === st);
    } catch (err) {
      log('changes', `刷新改动失败 ${id}：${String(err)}`);
    } finally {
      // 与循环退出处于同一同步段，避免新请求看到即将结束的 running 而丢失补跑标记
      st.running = undefined;
    }
  }

  /** 统计并写入缓存；被 forget 的会话或已有更新结果时不写回 */
  private async computeAndStore(id: string, st: SessionState, mode: DiffMode | undefined): Promise<Collected> {
    const seq = ++this.seq;
    const started = this.now();
    const sess = this.deps.getSession(id);
    const c = sess ? await this.collect(sess, st, mode) : errorCollected(mode ?? 'working', '会话不存在', this.now());
    st.lastMs = this.now() - started;
    if (this.states.get(id) !== st || seq < st.storedSeq) return c;
    st.storedSeq = seq;
    st.summary = c.summary;
    st.files = new Map(c.files.map(f => [f.path, f]));
    st.filesMode = c.summary.mode;
    if (c.summary.error) log('changes', `改动统计失败 ${id}：${c.summary.error}`);
    try {
      this.deps.onSummary?.(id, c.summary);
    } catch (err) {
      log('changes', `摘要回调异常：${String(err)}`);
    }
    return c;
  }

  /** 实际统计：tracked 文件用 diff 对比 ref，未跟踪与冲突文件来自 status */
  private async collect(sess: TrackedSession, st: SessionState, requested: DiffMode | undefined): Promise<Collected> {
    const mode = effectiveMode(sess, requested);
    const fail = (error: string) => errorCollected(mode, error, this.now());
    try {
      const rootRes = await this.resolveRoot(st, sess);
      if ('error' in rootRes) return fail(rootRes.error);
      const root = rootRes.root;
      const refRes = await this.resolveRef(root, sess, mode);
      if ('error' in refRes) return fail(refRes.error);
      const ref = refRes.ref;

      const { git } = this.deps;
      const diffBase = ['diff', '--no-ext-diff', '--no-textconv', '-z', '-M'];
      const [ns, num, status] = await Promise.all([
        git.run(root, [...diffBase, '--name-status', ref, '--']),
        git.run(root, [...diffBase, '--numstat', ref, '--']),
        git.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
      ]);
      const bad = [ns, num, status].find(r => !gitOk(r));
      if (bad) return fail(gitErrorText(bad));

      const map = new Map<string, ChangedFile>();
      for (const e of parseNameStatusZ(ns.stdout)) {
        const p = toSlash(e.path);
        if (!p) continue;
        const prev = map.get(p);
        const f: ChangedFile = {
          path: p, kind: prev?.kind === 'conflicted' ? 'conflicted' : e.kind,
          additions: null, deletions: null, binary: false,
        };
        if (e.oldPath) f.oldPath = toSlash(e.oldPath);
        map.set(p, f);
      }
      for (const n of parseNumstatZ(num.stdout)) {
        const f = map.get(toSlash(n.path));
        if (!f) continue;
        f.additions = n.additions;
        f.deletions = n.deletions;
        f.binary = n.additions === null && n.deletions === null;
      }
      const skipLocalConfig = !!sess.worktree;
      for (const e of parsePorcelainV2(status.stdout)) {
        const p = toSlash(e.path);
        if (!p) continue;
        if (e.type === 'unmerged') {
          const f = map.get(p);
          if (f) f.kind = 'conflicted';
          else map.set(p, { path: p, kind: 'conflicted', additions: null, deletions: null, binary: false });
        } else if (e.type === 'untracked' && !map.has(p)) {
          // 面板复制进工作区的本地配置不是 Claude 的改动，不计入
          if (skipLocalConfig && LOCAL_CONFIG_FILES.includes(p)) continue;
          map.set(p, { path: p, kind: 'untracked', additions: null, deletions: 0, binary: false });
        }
      }

      const all = [...map.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const truncated = all.length > this.maxFiles;
      const files = truncated ? all.slice(0, this.maxFiles) : all;
      // 只为列表内的未跟踪文件读盘统计行数，超大列表不做无谓的文件读取
      await this.fillUntracked(root, files.filter(f => f.kind === 'untracked'));

      let additions = 0;
      let deletions = 0;
      for (const f of all) {
        additions += f.additions ?? 0;
        deletions += f.deletions ?? 0;
      }
      return { summary: { mode, files: all.length, additions, deletions, updatedAt: this.now() }, files, truncated };
    } catch (err) {
      return fail(String(err));
    }
  }

  /** 仓库根：工作区会话直接用工作区根；普通会话用 git 解析 cwd 所在仓库的顶层目录，成功后缓存 */
  private async resolveRoot(st: SessionState, sess: TrackedSession): Promise<RootResult> {
    if (sess.worktree) {
      if (!fs.existsSync(sess.worktree.path)) return { error: '工作区目录不存在' };
      return { root: (st.root = path.resolve(sess.worktree.path)) };
    }
    if (st.root && st.rootCwd === sess.cwd) return { root: st.root };
    if (!sess.cwd || !fs.existsSync(sess.cwd)) return { error: '会话目录不存在' };
    const r = await this.deps.git.run(sess.cwd, ['rev-parse', '--show-toplevel']);
    if (r.notFound || r.timedOut) return { error: gitErrorText(r) };
    const top = r.stdout.trim();
    if (!gitOk(r) || !top) return { error: '不是 git 仓库' };
    // 与本会话视角同一写法，两种视角里同一文件的地址一致
    st.root = topInDirForm(sess.cwd, top);
    st.rootCwd = sess.cwd;
    return { root: st.root };
  }

  /** 比较起点：相对基线用创建时的基线提交；仅未提交用 HEAD，仓库无提交时用空树 */
  private async resolveRef(root: string, sess: TrackedSession, mode: DiffMode): Promise<RefResult> {
    if (mode === 'base' && sess.worktree) return { ref: sess.worktree.baseCommit };
    const r: GitResult = await this.deps.git.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (r.notFound || r.timedOut) return { error: gitErrorText(r) };
    return { ref: gitOk(r) ? 'HEAD' : EMPTY_TREE_SHA };
  }

  /** 未跟踪文件的新增行数：二进制、目录、超过 1MB 或读取失败时记为 null */
  private async fillUntracked(root: string, files: ChangedFile[]): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const f = files[next++];
        const abs = path.join(root, ...f.path.split('/'));
        try {
          const stat = await fs.promises.stat(abs);
          if (!stat.isFile()) continue;
          if (stat.size > MAX_COUNT_BYTES) {
            f.binary = looksBinary(await readHead(abs, BINARY_SNIFF_BYTES));
            if (f.binary) f.deletions = null;
            continue;
          }
          const buf = await fs.promises.readFile(abs);
          if (looksBinary(buf)) {
            f.binary = true;
            f.deletions = null;
          } else {
            f.additions = countLines(buf.toString('utf8'));
          }
        } catch {
          // 统计期间文件被删除或无权限，保持 null
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker));
  }

  /** 未跟踪文件没有 git diff：读文件内容作为全新增，超过 512KB 截断到最后一个完整行 */
  private async untrackedDiff(rel: string, abs: string): Promise<FileDiff> {
    const fail = (error: string): FileDiff => ({ path: rel, binary: false, truncated: false, hunks: [], error });
    let buf: Buffer;
    let cut = false;
    try {
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) return fail('无法读取文件');
      buf = await readHead(abs, MAX_DIFF_BYTES + 1);
      if (buf.length > MAX_DIFF_BYTES) {
        cut = true;
        const nl = buf.lastIndexOf(0x0a, MAX_DIFF_BYTES - 1);
        buf = buf.subarray(0, nl >= 0 ? nl + 1 : MAX_DIFF_BYTES);
      }
    } catch (err) {
      return fail(`无法读取文件：${(err as NodeJS.ErrnoException).code ?? String(err)}`);
    }
    if (looksBinary(buf)) return { path: rel, binary: true, truncated: false, hunks: [] };
    const text = buf.toString('utf8');
    const parsed = addedFileDiff(text, MAX_DIFF_LINES);
    const diff: FileDiff = { path: rel, binary: false, truncated: parsed.truncated || cut, hunks: parsed.hunks };
    if (text.includes('\uFFFD')) diff.notUtf8 = true;
    return diff;
  }
}

/** 实际生效的口径：相对基线只对工作区会话有效，其余一律仅未提交 */
function effectiveMode(sess: TrackedSession | undefined, requested: DiffMode | undefined): DiffMode {
  if (!sess?.worktree) return 'working';
  return requested ?? 'base';
}

function errorCollected(mode: DiffMode, error: string, now: number): Collected {
  return { summary: { mode, files: 0, additions: 0, deletions: 0, updatedAt: now, error }, files: [], truncated: false };
}

function toSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 规范化渲染层传来的相对路径；绝对路径、盘符、上跳、空段一律拒绝 */
function normalizeRelPath(p: string): string | undefined {
  if (typeof p !== 'string' || !p || p.includes('\0')) return undefined;
  const s = toSlash(p);
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s) || path.isAbsolute(p)) return undefined;
  const segs = s.split('/');
  if (segs.some(seg => seg === '..' || seg === '')) return undefined;
  return segs.filter(seg => seg !== '.').join('/') || undefined;
}

/** 只读文件开头的若干字节 */
async function readHead(file: string, bytes: number): Promise<Buffer> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
