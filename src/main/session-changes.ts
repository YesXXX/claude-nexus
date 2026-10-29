import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { gitOk, topInDirForm, type GitRunner } from './git-runner';
import {
  addedFileDiff, countLines, looksBinary, parsePorcelainV2, parseUnifiedDiff, removedFileDiff,
} from '../shared/git-parse';
import { readJson, writeJsonAtomic } from './json-store';
import { safeId, sha256File } from './revert-backup';
import { log } from './logger';
import type { ChangeKind, FileDiff, PanelEvent, RawHookPayload, WorktreeInfo } from '../shared/types';
import type {
  BaselineKind, ChangeSource, SessionChangedFile, SessionChangeList, SessionChangeRoot, SessionChangeSummary,
} from '../shared/session-change-types';

/**
 * 本会话改动：按 Claude 实际动过的文件统计，不依赖会话目录是不是 git 仓库，也不限于一个仓库。
 * - Edit / Write 等文件工具：PreToolUse 时（工具尚未执行）读取目标文件作为改前快照，每个文件只取第一次；
 * - Bash：执行前后各取一次 git status（会话目录所在仓库、已涉及文件所在仓库、普通目录下的嵌套仓库），
 *   原本干净、执行后有改动的文件以 HEAD 版本为改前内容；原本已有改动的只能按 HEAD 对比；
 *   普通目录（不在仓库里的部分）执行前后各遍历一次文件的 mtime / size，新建的文件改前即不存在，其余只记路径。
 * 快照存在 <home>/changesets/<sessionId>/：manifest.json 记录条目，blobs/<sha256> 存改前内容。
 */

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** 文件工具的改前快照最多让工具等这么久，超时放行（hook-client 自己 3 秒超时） */
const EDIT_WAIT_MS = 2000;
/** Bash 执行前的状态快照最多等这么久 */
const BASH_WAIT_MS = 1500;
const DEFAULT_DEBOUNCE_MS = 600;
const DEFAULT_MAX_BLOB_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SESSION_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_FILES = 500;
/** 单次 Bash 最多新增的条目数，防止一次构建产物把列表撑爆 */
const MAX_NEW_PER_BASH = 500;
/** 普通目录遍历的文件数上限，超过改用目录监听（只能发现执行后仍存在的文件） */
const MAX_WALK_FILES = 20000;
/** 读取 HEAD 版本的大小上限 */
const MAX_HEAD_BYTES = 64 * 1024 * 1024;
const MAX_DIFF_LINES = 5000;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_COUNT_BYTES = 1024 * 1024;
const POOL = 16;
/** 遍历与监听时跳过的目录：依赖、构建产物与版本库元数据 */
const WALK_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.next', 'out', '__pycache__', '.venv', '.idea', '.vs', '.gradle',
]);
const SHA_RE = /^[0-9a-f]{64}$/;

/** 改前内容：absent 改前不存在；blob 有内容（stored 为是否保存了副本）；none 没有改前内容 */
export type Baseline =
  | { kind: 'absent'; approx?: boolean }
  | { kind: 'blob'; sha256: string; size: number; stored: boolean; binary: boolean; approx?: boolean }
  | { kind: 'none' };

export interface ChangeEntry {
  /** 查找键：绝对路径、正斜杠，Windows 下小写 */
  key: string;
  abs: string;
  source: ChangeSource;
  tools: string[];
  at: number;
  base: Baseline;
  /** Claude 最近一次改完后的内容哈希；null 为改完后文件不存在；缺省为还没收到工具结束 */
  lastSha?: string | null;
}

interface Manifest {
  version: 1;
  sessionId: string;
  /** 已保存的改前内容总字节数 */
  bytes: number;
  entries: ChangeEntry[];
}

interface FileStat { m: number; s: number }

/** 增删行数：没有改前内容、二进制或无法统计时为 null */
interface LineStats { a: number | null; d: number | null; binary: boolean }

interface BashSnapshot {
  /** 仓库根 → 执行前有改动的路径（相对仓库根）及其 mtime / size，null 为不存在 */
  repos: Map<string, Map<string, FileStat | null>>;
  /** 普通目录执行前的文件表 */
  tree?: { root: string; files: Map<string, FileStat> };
  /** 普通目录文件过多时的监听 */
  watch?: { root: string; watcher: fs.FSWatcher; paths: Set<string> };
}

interface State {
  manifest: Manifest;
  entries: Map<string, ChangeEntry>;
  queue: Promise<unknown>;
  bashDepth: number;
  bashBefore?: Promise<BashSnapshot>;
  summary?: SessionChangeSummary;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<SessionChangeList>;
  dirty: boolean;
  hashes: Map<string, { m: number; s: number; sha: string }>;
  stats: Map<string, LineStats>;
  roots: Map<string, { root: string; repo: boolean }>;
}

export interface TrackedSession {
  cwd: string;
  worktree?: WorktreeInfo;
}

export interface SessionChangesDeps {
  home: string;
  git: GitRunner;
  getSession: (id: string) => TrackedSession | undefined;
  /** 摘要重新计算后回调 */
  onSummary?: (id: string, s: SessionChangeSummary) => void;
  /** 读 HEAD 版本（按检出时的换行与过滤规则）：null 为 HEAD 里没有，undefined 为读不了或过大 */
  readHeadBlob?: (root: string, rel: string) => Promise<Buffer | null | undefined>;
  now?: () => number;
  debounceMs?: number;
  maxBlobBytes?: number;
  maxSessionBytes?: number;
  maxFiles?: number;
  maxWalkFiles?: number;
}

/** 查找键：绝对路径、正斜杠，Windows 下不区分大小写 */
export function changeKey(p: string): string {
  const s = path.resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function toSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

function isUnder(child: string, parent: string): boolean {
  if (!parent) return false;
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sameStat(a: FileStat | null | undefined, b: FileStat | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.m === b.m && a.s === b.s;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 等 p 完成，但最多等 ms；p 失败也当作完成 */
function capped(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
    const done = () => { clearTimeout(t); resolve(); };
    p.then(done, done);
  });
}

async function pool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, worker));
}

async function statOf(abs: string): Promise<FileStat | null> {
  try {
    const s = await fs.promises.stat(abs);
    return s.isFile() ? { m: s.mtimeMs, s: s.size } : null;
  } catch {
    return null;
  }
}

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

/**
 * 遍历普通目录的文件（跳过依赖与构建目录）。遇到含 .git 的子目录不进入，作为嵌套仓库返回，改用 git status 跟踪。
 * 文件数超过 limit 返回 null。
 */
export async function walkTree(root: string, limit: number): Promise<{ files: Map<string, FileStat>; repos: string[] } | null> {
  const files = new Map<string, FileStat>();
  const repos: string[] = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop() as string;
    const dir = rel ? path.join(root, ...rel.split('/')) : root;
    let ents: fs.Dirent[];
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    if (rel && ents.some(e => e.name === '.git')) { repos.push(dir); continue; }
    const found: string[] = [];
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!WALK_IGNORE.has(e.name)) stack.push(r); } else if (e.isFile()) found.push(r);
    }
    if (files.size + found.length > limit) return null;
    await pool(found, async r => {
      const s = await statOf(path.join(root, ...r.split('/')));
      if (s) files.set(r, s);
    });
  }
  return { files, repos };
}

/** 默认的 HEAD 版本读取：先确认 HEAD 里有这个路径，再按检出规则（换行转换等）取出内容 */
export function gitHeadBlobReader(git: GitRunner, gitPath = 'git'): (root: string, rel: string) => Promise<Buffer | null | undefined> {
  return async (root, rel) => {
    const r = await git.run(root, ['rev-parse', '--verify', '--quiet', `HEAD:${rel}`]);
    if (r.notFound || r.timedOut) return undefined;
    if (!gitOk(r)) return null;
    const sha = r.stdout.trim();
    const t = await git.run(root, ['cat-file', '-t', sha]);
    if (!gitOk(t) || t.stdout.trim() !== 'blob') return undefined;
    const sz = await git.run(root, ['cat-file', '-s', sha]);
    if (!gitOk(sz) || Number(sz.stdout.trim()) > MAX_HEAD_BYTES) return undefined;
    return new Promise(resolve => {
      execFile(gitPath, ['-c', 'core.quotepath=false', 'cat-file', '--filters', `HEAD:${rel}`], {
        cwd: root, encoding: 'buffer', windowsHide: true, maxBuffer: MAX_HEAD_BYTES * 2, timeout: 15000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      }, (err, stdout) => resolve(err ? undefined : stdout));
    });
  };
}

export class SessionChanges {
  private readonly states = new Map<string, State>();
  private readonly checked = new Set<string>();
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly maxBlob: number;
  private readonly maxSession: number;
  private readonly maxFiles: number;
  private readonly maxWalk: number;
  private readonly readHeadBlob: (root: string, rel: string) => Promise<Buffer | null | undefined>;
  readonly root: string;

  constructor(private readonly deps: SessionChangesDeps) {
    this.now = deps.now ?? Date.now;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxBlob = deps.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    this.maxSession = deps.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES;
    this.maxFiles = deps.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxWalk = deps.maxWalkFiles ?? MAX_WALK_FILES;
    this.readHeadBlob = deps.readHeadBlob ?? gitHeadBlobReader(deps.git);
    this.root = path.join(deps.home, 'changesets');
  }

  // ---------------- hook 入口 ----------------

  /**
   * hook 上报的前置处理，由接收服务在回应 hook-client 之前调用：
   * 文件工具与 Bash 的 PreToolUse 返回一个需要等待的 Promise（已自带等待上限），其余事件在后台处理、返回 undefined。
   */
  preflight(id: string, raw: RawHookPayload | undefined): Promise<void> | undefined {
    if (!raw || !safeId(id) || !this.deps.getSession(id)) return undefined;
    const ev = raw.hook_event_name;
    const tool = raw.tool_name ?? '';
    try {
      if (EDIT_TOOLS.has(tool)) {
        const abs = this.toolPath(id, raw);
        if (!abs) return undefined;
        if (ev === 'PreToolUse') return capped(this.enqueue(id, () => this.capture(id, abs, tool)), EDIT_WAIT_MS);
        if (ev === 'PostToolUse') {
          void this.enqueue(id, () => this.afterTool(id, abs)).then(() => this.schedule(id));
        }
        return undefined;
      }
      if (tool === 'Bash') {
        if (ev === 'PreToolUse') return capped(this.bashStart(id), BASH_WAIT_MS);
        if (ev === 'PostToolUse') void this.bashEnd(id, false);
      }
    } catch (err) {
      log('session-changes', `处理 hook 失败 ${id}：${String(err)}`);
    }
    return undefined;
  }

  /** 会话事件旁路：一轮结束时收尾未配对的 Bash（执行失败时没有 PostToolUse）并刷新 */
  onEvent(id: string, event: PanelEvent): void {
    if (event.type !== 'turn_completed') return;
    const st = this.states.get(id);
    if (!st) return;
    if (st.bashDepth > 0) void this.bashEnd(id, true);
    else this.schedule(id);
  }

  private toolPath(id: string, raw: RawHookPayload): string | undefined {
    const input = (raw.tool_input ?? {}) as Record<string, unknown>;
    const p = typeof input.file_path === 'string' ? input.file_path : input.notebook_path;
    if (typeof p !== 'string' || !p || p.includes('\0')) return undefined;
    const sess = this.deps.getSession(id);
    const cwd = typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : sess?.cwd ?? '';
    return path.resolve(cwd, p);
  }

  // ---------------- 状态与持久化 ----------------

  private dir(id: string): string {
    return path.join(this.root, id);
  }

  private blobPath(id: string, sha: string): string | undefined {
    return SHA_RE.test(sha) ? path.join(this.dir(id), 'blobs', sha) : undefined;
  }

  private state(id: string): State {
    let st = this.states.get(id);
    if (st) return st;
    const m = readJson<Manifest>(path.join(this.dir(id), 'manifest.json'), { tag: 'session-changes' });
    const manifest: Manifest = m && m.version === 1 && m.sessionId === id && Array.isArray(m.entries)
      ? m : { version: 1, sessionId: id, bytes: 0, entries: [] };
    st = {
      manifest, entries: new Map(manifest.entries.map(e => [e.key, e])), queue: Promise.resolve(), bashDepth: 0,
      dirty: false, hashes: new Map(), stats: new Map(), roots: new Map(),
    };
    this.states.set(id, st);
    return st;
  }

  private save(id: string, st: State): void {
    st.manifest.entries = [...st.entries.values()];
    writeJsonAtomic(path.join(this.dir(id), 'manifest.json'), st.manifest, { tag: 'session-changes', indent: 0 });
  }

  /** 同一会话的快照写入串行执行，避免同一文件重复取快照、清单互相覆盖 */
  private enqueue<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const st = this.state(id);
    const r = st.queue.then(fn);
    st.queue = r.then(() => undefined, err => log('session-changes', `快照失败 ${id}：${String(err)}`));
    return r;
  }

  private baseDir(sess: TrackedSession): string {
    return path.resolve(sess.worktree ? sess.worktree.path : sess.cwd || '.');
  }

  // ---------------- 快照 ----------------

  private async capture(id: string, abs: string, tool: string): Promise<void> {
    const st = this.state(id);
    const key = changeKey(abs);
    const old = st.entries.get(key);
    if (old) {
      if (!old.tools.includes(tool)) { old.tools.push(tool); this.save(id, st); }
      return;
    }
    let stat: fs.Stats;
    let base: Baseline;
    try {
      stat = await fs.promises.stat(abs);
      if (!stat.isFile()) return;
      base = await this.storeFile(id, st, abs, stat.size);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      base = code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'absent' } : { kind: 'none' };
    }
    st.entries.set(key, { key, abs, source: 'tool', tools: [tool], at: this.now(), base });
    this.save(id, st);
  }

  /** 保存文件当前内容作为改前快照；超过单文件或会话上限只记哈希 */
  private async storeFile(id: string, st: State, abs: string, size: number): Promise<Baseline> {
    if (size <= this.maxBlob && st.manifest.bytes + size <= this.maxSession) {
      return this.storeBuffer(id, st, await fs.promises.readFile(abs));
    }
    const binary = looksBinary(await readHead(abs, 8000));
    return { kind: 'blob', sha256: await sha256File(abs), size, stored: false, binary };
  }

  private async storeBuffer(id: string, st: State, buf: Buffer): Promise<Baseline> {
    const sha = sha256(buf);
    const binary = looksBinary(buf);
    if (buf.length > this.maxBlob || st.manifest.bytes + buf.length > this.maxSession) {
      return { kind: 'blob', sha256: sha, size: buf.length, stored: false, binary };
    }
    const file = this.blobPath(id, sha) as string;
    if (!fs.existsSync(file)) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, buf);
      st.manifest.bytes += buf.length;
    }
    return { kind: 'blob', sha256: sha, size: buf.length, stored: true, binary };
  }

  private async afterTool(id: string, abs: string): Promise<void> {
    const st = this.state(id);
    const e = st.entries.get(changeKey(abs));
    if (!e) return;
    const cur = await this.currentSha(st, e.abs);
    if (cur === undefined || cur === e.lastSha) return;
    e.lastSha = cur;
    this.save(id, st);
  }

  /** 文件当前内容的哈希（按 mtime / size 缓存）：null 为不存在，undefined 为目录或读不了 */
  private async currentSha(st: State, abs: string): Promise<string | null | undefined> {
    let s: fs.Stats;
    try {
      s = await fs.promises.stat(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined;
    }
    if (!s.isFile()) return undefined;
    const key = changeKey(abs);
    const c = st.hashes.get(key);
    if (c && c.m === s.mtimeMs && c.s === s.size) return c.sha;
    try {
      const sha = await sha256File(abs);
      st.hashes.set(key, { m: s.mtimeMs, s: s.size, sha });
      return sha;
    } catch {
      return undefined;
    }
  }

  // ---------------- Bash 推断 ----------------

  private bashStart(id: string): Promise<void> {
    const st = this.state(id);
    st.bashDepth++;
    if (!st.bashBefore) {
      st.bashBefore = this.snapshotBefore(id, st);
      st.bashBefore.catch(err => log('session-changes', `Bash 执行前快照失败 ${id}：${String(err)}`));
    }
    return st.bashBefore.then(() => undefined);
  }

  private async snapshotBefore(id: string, st: State): Promise<BashSnapshot> {
    const snap: BashSnapshot = { repos: new Map() };
    const sess = this.deps.getSession(id);
    if (!sess) return snap;
    const base = this.baseDir(sess);
    const roots = new Set<string>();
    const top = await this.gitTop(base);
    if (top) roots.add(top);
    for (const e of st.entries.values()) {
      const r = await this.rootOf(st, e.abs, base);
      if (r.repo) roots.add(r.root);
    }
    if (!top && fs.existsSync(base)) {
      const tree = await walkTree(base, this.maxWalk);
      if (tree) {
        snap.tree = { root: base, files: tree.files };
        for (const r of tree.repos) roots.add(path.resolve(r));
      } else {
        snap.watch = this.watch(base);
      }
    }
    const uniq = new Map<string, string>();
    for (const r of roots) uniq.set(changeKey(r), r);
    await Promise.all([...uniq.values()].map(async r => {
      const dirty = await this.dirtyPaths(r);
      if (dirty) snap.repos.set(r, dirty);
    }));
    return snap;
  }

  private watch(root: string): BashSnapshot['watch'] {
    const paths = new Set<string>();
    try {
      const watcher = fs.watch(root, { recursive: true }, (_ev, name) => {
        if (!name || paths.size > MAX_NEW_PER_BASH * 4) return;
        const rel = toSlash(String(name));
        if (rel.split('/').some(seg => WALK_IGNORE.has(seg))) return;
        paths.add(rel);
      });
      watcher.on('error', () => undefined);
      return { root, watcher, paths };
    } catch {
      return undefined;
    }
  }

  /** git status 里有改动的路径（相对仓库根）及其 mtime / size；不是仓库或失败时返回 undefined */
  private async dirtyPaths(root: string): Promise<Map<string, FileStat | null> | undefined> {
    const r = await this.deps.git.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
    if (!gitOk(r)) return undefined;
    const rels = new Set<string>();
    for (const e of parsePorcelainV2(r.stdout)) {
      if (e.type === 'ignored') continue;
      rels.add(toSlash(e.path));
      if (e.oldPath) rels.add(toSlash(e.oldPath));
    }
    const out = new Map<string, FileStat | null>();
    await pool([...rels], async rel => { out.set(rel, await statOf(path.join(root, ...rel.split('/')))); });
    return out;
  }

  private async bashEnd(id: string, force: boolean): Promise<void> {
    const st = this.states.get(id);
    if (!st || st.bashDepth <= 0) return;
    st.bashDepth = force ? 0 : st.bashDepth - 1;
    if (st.bashDepth > 0) return;
    const before = st.bashBefore;
    st.bashBefore = undefined;
    if (!before) return;
    let snap: BashSnapshot;
    try { snap = await before; } catch { return; }
    // 留一点时间让目录监听收到最后的事件
    if (snap.watch) await new Promise(r => setTimeout(r, 150));
    await this.enqueue(id, () => this.inferBash(id, st, snap)).catch(() => undefined);
    this.schedule(id);
  }

  private async inferBash(id: string, st: State, snap: BashSnapshot): Promise<void> {
    let added = 0;
    const add = async (abs: string, make: () => Promise<Baseline | undefined>): Promise<void> => {
      if (added >= MAX_NEW_PER_BASH) return;
      const key = changeKey(abs);
      if (st.entries.has(key)) return;
      const base = await make();
      if (!base) return;
      const lastSha = await this.currentSha(st, abs);
      st.entries.set(key, {
        key, abs, source: 'bash', tools: ['Bash'], at: this.now(), base, lastSha: lastSha === undefined ? null : lastSha,
      });
      added++;
    };
    try {
      for (const [root, before] of snap.repos) {
        const after = await this.dirtyPaths(root);
        if (!after) continue;
        for (const [rel, cur] of after) {
          const abs = path.join(root, ...rel.split('/'));
          if (!before.has(rel)) await add(abs, () => this.headBase(id, st, root, rel, false));
          else if (!sameStat(before.get(rel), cur)) await add(abs, () => this.headBase(id, st, root, rel, true));
        }
        // 执行前有改动、执行后变干净：被恢复成了 HEAD，原来的内容无从得知
        for (const rel of before.keys()) {
          if (!after.has(rel)) await add(path.join(root, ...rel.split('/')), async () => ({ kind: 'none' }));
        }
      }
      if (snap.tree) {
        const { root, files: before } = snap.tree;
        const after = await walkTree(root, this.maxWalk);
        if (after) {
          for (const [rel, cur] of after.files) {
            const abs = path.join(root, ...rel.split('/'));
            const prev = before.get(rel);
            if (!prev) await add(abs, async () => ({ kind: 'absent' }));
            else if (!sameStat(prev, cur)) await add(abs, async () => ({ kind: 'none' }));
          }
          for (const rel of before.keys()) {
            if (!after.files.has(rel)) await add(path.join(root, ...rel.split('/')), async () => ({ kind: 'none' }));
          }
        }
      }
      if (snap.watch) {
        snap.watch.watcher.close();
        for (const rel of snap.watch.paths) {
          const abs = path.join(snap.watch.root, ...rel.split('/'));
          if (await statOf(abs)) await add(abs, async () => ({ kind: 'none' }));
        }
      }
    } finally {
      snap.watch?.watcher.close();
      if (added > 0) this.save(id, st);
    }
  }

  /** 以 HEAD 版本作为改前内容；approx 表示执行前已有未提交改动，HEAD 只是近似 */
  private async headBase(id: string, st: State, root: string, rel: string, approx: boolean): Promise<Baseline> {
    const blob = await this.readHeadBlob(root, rel);
    if (blob === undefined) return { kind: 'none' };
    if (blob === null) return approx ? { kind: 'absent', approx } : { kind: 'absent' };
    const b = await this.storeBuffer(id, st, blob);
    if (approx && b.kind === 'blob') b.approx = true;
    return b;
  }

  // ---------------- 列表与摘要 ----------------

  /** 缓存的摘要；有改动集但还没统计过时在后台补算一次 */
  getSummary(id: string): SessionChangeSummary | undefined {
    const st = this.states.get(id);
    if (st?.summary) return st.summary;
    if (!this.checked.has(id)) {
      this.checked.add(id);
      if (st || (safeId(id) && fs.existsSync(path.join(this.dir(id), 'manifest.json')))) this.schedule(id);
    }
    return undefined;
  }

  /** 重新统计并回调摘要；同一会话不并发统计，进行中再次请求只标记、结束后补跑一次 */
  async refresh(id: string): Promise<SessionChangeList> {
    const st = this.state(id);
    if (st.running) {
      st.dirty = true;
      return st.running;
    }
    st.running = (async () => {
      let r: SessionChangeList;
      do {
        st.dirty = false;
        r = await this.collect(id, st);
      } while (st.dirty && this.states.get(id) === st);
      return r;
    })();
    try {
      return await st.running;
    } finally {
      st.running = undefined;
    }
  }

  /** 完整列表（同时刷新摘要） */
  list(id: string): Promise<SessionChangeList> {
    return this.refresh(id);
  }

  private schedule(id: string): void {
    const st = this.state(id);
    if (st.timer) return;
    st.timer = setTimeout(() => {
      st.timer = undefined;
      if (this.states.get(id) === st) void this.refresh(id).catch(err => log('session-changes', `统计失败 ${id}：${String(err)}`));
    }, this.debounceMs);
    st.timer.unref?.();
  }

  private async collect(id: string, st: State): Promise<SessionChangeList> {
    const sess = this.deps.getSession(id);
    const base = sess ? this.baseDir(sess) : '';
    const summary: SessionChangeSummary = { files: 0, additions: 0, deletions: 0, roots: 0, updatedAt: this.now() };
    if (!sess) return { summary: { ...summary, error: '会话不存在' }, files: [], roots: [], truncated: false, cwd: '' };
    await st.queue;
    const rows: SessionChangedFile[] = [];
    await pool([...st.entries.values()], async e => {
      try {
        const row = await this.describe(st, e, base);
        if (row) rows.push(row);
      } catch (err) {
        log('session-changes', `统计文件失败 ${e.abs}：${String(err)}`);
      }
    });
    const rootOrder = (r: SessionChangedFile) => (r.outside ? 1 : 0);
    rows.sort((a, b) => rootOrder(a) - rootOrder(b)
      || cmp(changeKey(a.root), changeKey(b.root)) || cmp(a.rel.toLowerCase(), b.rel.toLowerCase()));
    const roots: SessionChangeRoot[] = [];
    for (const r of rows) {
      const last = roots[roots.length - 1];
      if (last && changeKey(last.root) === changeKey(r.root)) last.files++;
      else roots.push({ root: r.root, repo: r.repo, outside: r.outside, files: 1 });
      summary.additions += r.additions ?? 0;
      summary.deletions += r.deletions ?? 0;
    }
    summary.files = rows.length;
    summary.roots = roots.length;
    const truncated = rows.length > this.maxFiles;
    const list: SessionChangeList = {
      summary, files: truncated ? rows.slice(0, this.maxFiles) : rows, roots, truncated, cwd: base,
    };
    if (this.states.get(id) === st) {
      st.summary = summary;
      try { this.deps.onSummary?.(id, summary); } catch (err) { log('session-changes', `摘要回调异常：${String(err)}`); }
    }
    return list;
  }

  private async describe(st: State, e: ChangeEntry, base: string): Promise<SessionChangedFile | undefined> {
    const cur = await this.currentSha(st, e.abs);
    if (cur === undefined) return undefined;
    const b = e.base;
    let kind: ChangeKind;
    if (b.kind === 'none') kind = cur === null ? 'deleted' : 'modified';
    else if (b.kind === 'absent') {
      if (cur === null) return undefined;
      kind = 'added';
    } else {
      if (cur === b.sha256) return undefined;
      kind = cur === null ? 'deleted' : 'modified';
    }
    const baseline: BaselineKind = b.kind === 'none' ? 'none' : b.approx ? 'head' : 'exact';
    const s = await this.stats(st, e, cur);
    const { root, repo } = await this.rootOf(st, e.abs, base);
    const row: SessionChangedFile = {
      path: toSlash(e.abs), abs: e.abs, root, rel: toSlash(path.relative(root, e.abs)), repo,
      outside: !isUnder(e.abs, base), source: e.source, baseline, tools: [...e.tools],
      kind, additions: s.a, deletions: s.d, binary: s.binary,
    };
    if (e.lastSha !== undefined && e.lastSha !== cur) row.external = true;
    if (b.kind === 'blob' && !b.stored) row.tooLarge = true;
    return row;
  }

  /** 增删行数：按（改前哈希，当前哈希）缓存；没有改前内容或二进制为 null */
  private async stats(st: State, e: ChangeEntry, cur: string | null): Promise<LineStats> {
    const b = e.base;
    const none: LineStats = { a: null, d: null, binary: false };
    if (b.kind === 'none' || (b.kind === 'blob' && !b.stored)) return none;
    const ck = `${b.kind === 'blob' ? b.sha256 : 'absent'}|${cur ?? 'null'}`;
    const hit = st.stats.get(ck);
    if (hit) return hit;
    let r = none;
    if (b.kind === 'absent') {
      const n = await countFile(e.abs);
      r = n === 'binary' ? { a: null, d: null, binary: true } : { a: n ?? null, d: 0, binary: false };
    } else if (cur === null) {
      const n = await countFile(this.blobPath(st.manifest.sessionId, b.sha256) as string);
      r = n === 'binary' ? { a: null, d: null, binary: true } : { a: 0, d: n ?? null, binary: false };
    } else if (b.binary) {
      r = { a: null, d: null, binary: true };
    } else {
      const blob = this.blobPath(st.manifest.sessionId, b.sha256) as string;
      const g = await this.deps.git.run(this.root, ['diff', '--no-index', '--numstat', '--no-ext-diff', '--no-textconv', '--', blob, e.abs], { okCodes: [0, 1] });
      const m = gitOk(g, [0, 1]) ? /^(-|\d+)\t(-|\d+)\t/m.exec(g.stdout) : null;
      if (m) r = m[1] === '-' ? { a: null, d: null, binary: true } : { a: Number(m[1]), d: Number(m[2]), binary: false };
      else if (gitOk(g, [0, 1]) && !g.stdout.trim()) r = { a: 0, d: 0, binary: false };
    }
    st.stats.set(ck, r);
    return r;
  }

  /** 分组根目录：文件所在的 git 仓库根；不在仓库里时为会话目录（文件在其下）或文件所在目录 */
  private async rootOf(st: State, abs: string, base: string): Promise<{ root: string; repo: boolean }> {
    let dir = path.dirname(abs);
    while (!fs.existsSync(dir)) {
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    const k = changeKey(dir);
    let r = st.roots.get(k);
    if (!r) {
      const top = await this.gitTop(dir);
      if (top) r = { root: top, repo: true };
      else if (isUnder(abs, base)) r = { root: base, repo: false };
      else r = { root: path.dirname(abs), repo: false };
      st.roots.set(k, r);
    }
    return r;
  }

  /** dir 所在的 git 仓库根，按 dir 的写法给出 */
  private async gitTop(dir: string): Promise<string | undefined> {
    if (!dir || !fs.existsSync(dir)) return undefined;
    const r = await this.deps.git.run(dir, ['rev-parse', '--show-toplevel']);
    const top = r.stdout.trim();
    if (!gitOk(r) || !top) return undefined;
    return topInDirForm(dir, top);
  }

  // ---------------- 单文件 ----------------

  /** 列表里某个文件的条目：p 必须是本会话改动集里的绝对路径，渲染层借此读不到任意文件 */
  entry(id: string, p: unknown): ChangeEntry | undefined {
    if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p) || !safeId(id)) return undefined;
    if (!this.deps.getSession(id)) return undefined;
    return this.state(id).entries.get(changeKey(p));
  }

  /** 改前快照副本的路径；没有保存副本时为 undefined */
  baselinePath(id: string, e: ChangeEntry): string | undefined {
    if (e.base.kind !== 'blob' || !e.base.stored) return undefined;
    const p = this.blobPath(id, e.base.sha256);
    return p && fs.existsSync(p) ? p : undefined;
  }

  /** 文件当前内容哈希：null 为不存在，undefined 为目录或读不了 */
  async current(id: string, e: ChangeEntry): Promise<string | null | undefined> {
    return this.currentSha(this.state(id), e.abs);
  }

  /** 单文件对比；ignoreWs 为真时忽略空白差异（git diff -w），忽略后没有差异给出「仅空白变化」的说明 */
  async fileDiff(id: string, p: unknown, opts: { ignoreWs?: boolean } = {}): Promise<FileDiff> {
    const ws = opts.ignoreWs === true;
    const shown = typeof p === 'string' ? p : '';
    const res = (extra: Partial<FileDiff>): FileDiff => ({ path: shown, binary: false, truncated: false, hunks: [], ...extra });
    const e = this.entry(id, p);
    if (!e) return res({ error: '文件不在本会话改动中' });
    const st = this.state(id);
    const cur = await this.currentSha(st, e.abs);
    if (cur === undefined) return res({ error: '无法读取文件' });
    const b = e.base;
    const headNote = '改前已有未提交改动，对比基准为 HEAD 版本';
    if (b.kind === 'none') {
      if (cur === null) return res({ notice: '没有改前内容', emptyText: '文件已被删除，没有改前内容可显示' });
      return { ...(await readAsAdded(shown, e.abs)), notice: '没有改前内容，仅显示当前内容' };
    }
    if (b.kind === 'absent') {
      if (cur === null) return res({ emptyText: '文件已不存在' });
      const d = await readAsAdded(shown, e.abs);
      if (b.approx) d.notice = headNote;
      return d;
    }
    const blob = this.baselinePath(id, e);
    if (!blob) return res({ notice: '改前内容超过备份上限，未保存', emptyText: '无法显示对比' });
    const note = b.approx ? { notice: headNote } : {};
    if (cur === b.sha256) return res({ ...note, emptyText: '与改前内容相同' });
    if (b.binary) return res({ ...note, binary: true });
    if (cur === null) {
      const d = await readAsAdded(shown, blob);
      if (d.binary || d.error) return { ...d, ...note };
      const text = (await fs.promises.readFile(blob)).toString('utf8');
      const parsed = removedFileDiff(text, MAX_DIFF_LINES);
      return { ...res(note), truncated: parsed.truncated, hunks: parsed.hunks };
    }
    const g = await this.deps.git.run(this.root, [
      'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', ...(ws ? ['-w'] : []), '--', blob, e.abs,
    ], { okCodes: [0, 1] });
    if (!gitOk(g, [0, 1])) return res({ ...note, error: g.stderr.trim().split(/\r?\n/)[0] || '对比失败' });
    let out = g.stdout;
    let cut = false;
    if (out.length > MAX_DIFF_BYTES) {
      out = out.slice(0, out.lastIndexOf('\n', MAX_DIFF_BYTES) + 1);
      cut = true;
    }
    const parsed = parseUnifiedDiff(out, MAX_DIFF_LINES);
    const d: FileDiff = { ...res(note), binary: parsed.binary, truncated: parsed.truncated || cut, hunks: parsed.hunks };
    if (out.includes('�')) d.notUtf8 = true;
    if (!d.hunks.length && !d.binary) {
      // 能走到这里说明文件哈希已与改前不同，忽略空白后差异消失即只剩空白差异
      d.emptyText = ws
        ? '忽略空白后没有差异（可能仅空白变化），关闭「忽略空白」可查看'
        : '内容相同（可能只有换行或权限差异）';
    }
    return d;
  }

  /** 文件撤销或恢复后丢掉相关缓存并立即重算 */
  async changed(id: string): Promise<void> {
    await this.refresh(id).catch(() => undefined);
  }

  // ---------------- 清除 ----------------

  /** 清空本会话全部改动记录与改前内容副本；之后的改动会以那时的内容为改前重新记录 */
  async clearAll(id: string): Promise<{ removed: number }> {
    if (!safeId(id) || !this.deps.getSession(id)) return { removed: 0 };
    const st = this.state(id);
    let removed = 0;
    await this.enqueue(id, async () => {
      removed = st.entries.size;
      st.entries.clear();
      st.manifest.bytes = 0;
      this.save(id, st);
    });
    // 先落盘空清单再丢内存与磁盘目录；目录删不掉时只剩空清单与孤儿副本，无害
    this.forget(id);
    try { fs.rmSync(this.dir(id), { recursive: true, force: true }); } catch { /* 下次启动清理 */ }
    await this.refresh(id);
    return { removed };
  }

  /** 删除指定文件的改动记录；不在改动集里的路径忽略，回收失去引用的改前内容副本 */
  async dismiss(id: string, paths: string[]): Promise<{ removed: number }> {
    if (!safeId(id) || !this.deps.getSession(id) || !Array.isArray(paths)) return { removed: 0 };
    const st = this.state(id);
    const keys = new Set<string>();
    for (const p of paths) {
      if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p)) continue;
      const k = changeKey(p);
      if (st.entries.has(k)) keys.add(k);
    }
    if (!keys.size) return { removed: 0 };
    let removed = 0;
    await this.enqueue(id, async () => { removed = this.removeKeys(id, st, keys); });
    await this.refresh(id);
    return { removed };
  }

  /** 删除某个分组（根目录加是否在工作目录外）下的全部记录；按根目录匹配，能清掉列表截断之外的条目 */
  async dismissRoot(id: string, root: string, outside: boolean): Promise<{ removed: number }> {
    if (!safeId(id) || !this.deps.getSession(id) || typeof root !== 'string' || !root || root.includes('\0')) {
      return { removed: 0 };
    }
    const sess = this.deps.getSession(id) as TrackedSession;
    const base = this.baseDir(sess);
    const st = this.state(id);
    const keys = new Set<string>();
    for (const e of st.entries.values()) {
      if (isUnder(e.abs, root) && isUnder(e.abs, base) === !outside) keys.add(e.key);
    }
    if (!keys.size) return { removed: 0 };
    let removed = 0;
    await this.enqueue(id, async () => { removed = this.removeKeys(id, st, keys); });
    await this.refresh(id);
    return { removed };
  }

  /** 从清单删除一批查找键并同步清单与副本文件，返回实际删除数 */
  private removeKeys(id: string, st: State, keys: Iterable<string>): number {
    let removed = 0;
    for (const k of keys) {
      if (st.entries.delete(k)) removed++;
    }
    // 先按剩余条目重算字节数并落盘清单，再删失去引用的副本：中途失败只会留下孤儿副本，不会丢清单
    const used = new Map<string, number>();
    for (const e of st.entries.values()) {
      if (e.base.kind === 'blob' && e.base.stored) used.set(e.base.sha256, e.base.size);
    }
    let bytes = 0;
    for (const size of used.values()) bytes += size;
    st.manifest.bytes = bytes;
    this.save(id, st);
    const dir = path.join(this.dir(id), 'blobs');
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return removed; }
    for (const name of names) {
      if (!used.has(name)) {
        try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* 删不掉留作孤儿，下次清除或删除会话时再清 */ }
      }
    }
    return removed;
  }

  // ---------------- 生命周期 ----------------

  /** 会话移出列表：丢掉内存状态，磁盘上的改动集保留（续接后继续累计） */
  forget(id: string): void {
    const st = this.states.get(id);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    st.bashBefore?.then(s => s.watch?.watcher.close(), () => undefined);
    this.states.delete(id);
    this.checked.delete(id);
  }

  /** 会话记录被删除：连同磁盘上的改动集一起删 */
  drop(ids: string[]): void {
    for (const id of ids) {
      this.forget(id);
      if (!safeId(id)) continue;
      try { fs.rmSync(this.dir(id), { recursive: true, force: true }); } catch { /* 下次启动清理 */ }
    }
  }

  /** 启动时清理既不在列表也没有记录的会话的改动集，返回删除数 */
  prune(keep: (id: string) => boolean): number {
    let names: string[] = [];
    try { names = fs.readdirSync(this.root); } catch { return 0; }
    let n = 0;
    for (const name of names) {
      if (safeId(name) && keep(name)) continue;
      try { fs.rmSync(path.join(this.root, name), { recursive: true, force: true }); n++; } catch { /* 忽略 */ }
    }
    return n;
  }

  dispose(): void {
    for (const id of [...this.states.keys()]) this.forget(id);
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 文本行数；二进制返回 'binary'，过大或读不了返回 undefined */
async function countFile(abs: string): Promise<number | 'binary' | undefined> {
  try {
    const s = await fs.promises.stat(abs);
    if (s.size > MAX_COUNT_BYTES) return looksBinary(await readHead(abs, 8000)) ? 'binary' : undefined;
    const buf = await fs.promises.readFile(abs);
    return looksBinary(buf) ? 'binary' : countLines(buf.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** 整个文件作为新增内容显示，超过 512KB 截断到最后一个完整行 */
async function readAsAdded(shown: string, abs: string): Promise<FileDiff> {
  const res = (extra: Partial<FileDiff>): FileDiff => ({ path: shown, binary: false, truncated: false, hunks: [], ...extra });
  let buf: Buffer;
  let cut = false;
  try {
    buf = await readHead(abs, MAX_DIFF_BYTES + 1);
    if (buf.length > MAX_DIFF_BYTES) {
      cut = true;
      const nl = buf.lastIndexOf(0x0a, MAX_DIFF_BYTES - 1);
      buf = buf.subarray(0, nl >= 0 ? nl + 1 : MAX_DIFF_BYTES);
    }
  } catch (err) {
    return res({ error: `无法读取文件：${(err as NodeJS.ErrnoException).code ?? String(err)}` });
  }
  if (looksBinary(buf)) return res({ binary: true });
  const text = buf.toString('utf8');
  const parsed = addedFileDiff(text, MAX_DIFF_LINES);
  const d = res({ truncated: parsed.truncated || cut, hunks: parsed.hunks });
  if (text.includes('�')) d.notUtf8 = true;
  return d;
}
