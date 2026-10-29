import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { readJson, writeJsonAtomic } from './json-store';
import type { DiffMode } from '../shared/types';

/**
 * 撤销备份：每次撤销一个目录 <undo>/<sessionId>/<entryId>/，内含原样复制的文件与 manifest.json。
 * manifest 记录撤销前每个路径的状态、暂存区条目（ls-files -s 原样）与撤销后的状态，
 * 恢复时据此判断文件之后是否又被修改过。
 */

/** 磁盘上一个路径的状态 */
export type Snap =
  | { exists: false }
  | { exists: true; kind: 'file'; sha256: string; size: number }
  | { exists: true; kind: 'link'; target: string }
  | { exists: true; kind: 'dir' };

export interface BackupFile {
  /** 相对仓库根，正斜杠 */
  path: string;
  before: Snap;
  after?: Snap;
  /** 备份目录里的文件名；原本不存在、符号链接或过大未备份时缺省 */
  stored?: string;
}

/** 暂存区条目，与 git ls-files -s 一致 */
export interface IndexEntry {
  mode: string;
  sha: string;
  stage: number;
  path: string;
}

export interface RevertManifest {
  version: 1;
  id: string;
  sessionId: string;
  root: string;
  mode: DiffMode;
  /** 恢复到的提交（完整 sha）；未跟踪文件删除时为空串 */
  source: string;
  /** 显示用命令 */
  command: string;
  at: number;
  /** 文件过大未备份时为 false */
  restorable: boolean;
  files: BackupFile[];
  index: IndexEntry[];
  restoredAt?: number;
}

/** 解析 ls-files -s -z 输出：每条为「mode sha stage\tpath\0」 */
export function parseLsFilesStage(out: string): IndexEntry[] {
  const list: IndexEntry[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, sha, stage] = rec.slice(0, tab).split(' ');
    if (!mode || !sha || stage === undefined) continue;
    list.push({ mode, sha, stage: Number(stage), path: rec.slice(tab + 1) });
  }
  return list;
}

const ZERO_SHA = '0'.repeat(40);

/**
 * update-index -z --index-info 的输入：原本在暂存区的路径按备份写回，
 * 原本不在暂存区的路径写 mode 0 将其移除。
 */
export function indexInfoInput(paths: string[], entries: IndexEntry[]): string {
  const out: string[] = [];
  for (const p of paths) {
    const mine = entries.filter(e => e.path === p);
    if (mine.length === 0) out.push(`0 ${ZERO_SHA}\t${p}`);
    else for (const e of mine) out.push(`${e.mode} ${e.sha} ${e.stage}\t${e.path}`);
  }
  return out.map(s => `${s}\0`).join('');
}

export async function sha256File(abs: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const s = fs.createReadStream(abs);
    s.on('data', c => h.update(c));
    s.on('end', () => resolve());
    s.on('error', reject);
  });
  return h.digest('hex');
}

/** 读取路径状态：不跟随符号链接 */
export async function snapshot(abs: string): Promise<Snap> {
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false };
    throw err;
  }
  if (st.isSymbolicLink()) return { exists: true, kind: 'link', target: await fs.promises.readlink(abs) };
  if (st.isDirectory()) return { exists: true, kind: 'dir' };
  return { exists: true, kind: 'file', sha256: await sha256File(abs), size: st.size };
}

export function sameSnap(a: Snap | undefined, b: Snap | undefined): boolean {
  if (!a || !b) return false;
  if (!a.exists || !b.exists) return a.exists === b.exists;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'file' && b.kind === 'file') return a.sha256 === b.sha256 && a.size === b.size;
  if (a.kind === 'link' && b.kind === 'link') return a.target === b.target;
  return true;
}

export interface PrunePolicy {
  /** 单会话保留的最近次数 */
  keepPerSession: number;
  /** 超过这个时长的删除 */
  maxAgeMs: number;
  /** 总量上限，超过时从最旧的开始删 */
  maxTotalBytes: number;
}

export const DEFAULT_PRUNE: PrunePolicy = {
  keepPerSession: 10,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxTotalBytes: 200 * 1024 * 1024,
};

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** 备份目录名与会话 id 只允许安全字符，渲染层传来的 id 不能借此跑出备份目录 */
export function safeId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

function dirSize(dir: string): number {
  let n = 0;
  let names: fs.Dirent[] = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const d of names) {
    const p = path.join(dir, d.name);
    try { n += d.isDirectory() ? dirSize(p) : fs.lstatSync(p).size; } catch { /* 读不到按 0 计 */ }
  }
  return n;
}

/** 备份目录的读写与清理 */
export class UndoStore {
  private lastStamp = 0;

  constructor(private readonly root: string, private readonly now: () => number = Date.now) {}

  private sessionDir(sessionId: string): string {
    return path.join(this.root, sessionId);
  }

  /** 某次撤销的备份目录；id 不合规时返回 undefined */
  dir(sessionId: string, id: string): string | undefined {
    if (!safeId(sessionId) || !safeId(id)) return undefined;
    return path.join(this.sessionDir(sessionId), id);
  }

  /** 新建一个空备份目录；目录名以时间开头，按名称排序即按时间排序（同一毫秒内连续创建时顺延 1ms） */
  create(sessionId: string): { id: string; dir: string } {
    const stamp = Math.max(this.now(), this.lastStamp + 1);
    this.lastStamp = stamp;
    const id = `${stamp.toString(36).padStart(9, '0')}-${randomBytes(3).toString('hex')}`;
    const dir = path.join(this.sessionDir(sessionId), id);
    fs.mkdirSync(dir, { recursive: true });
    return { id, dir };
  }

  write(m: RevertManifest): boolean {
    const dir = this.dir(m.sessionId, m.id);
    return !!dir && writeJsonAtomic(path.join(dir, 'manifest.json'), m, { tag: 'revert', indent: 0 });
  }

  read(sessionId: string, id: string): RevertManifest | null {
    const dir = this.dir(sessionId, id);
    if (!dir) return null;
    const m = readJson<RevertManifest>(path.join(dir, 'manifest.json'), { tag: 'revert' });
    return m && m.version === 1 && m.id === id && m.sessionId === sessionId && Array.isArray(m.files) ? m : null;
  }

  /** 该会话的全部备份，最新的在前；没有 manifest 的残缺目录跳过 */
  list(sessionId: string): RevertManifest[] {
    if (!safeId(sessionId)) return [];
    let names: string[] = [];
    try { names = fs.readdirSync(this.sessionDir(sessionId)); } catch { return []; }
    return names.filter(safeId).sort().reverse()
      .map(n => this.read(sessionId, n)).filter((m): m is RevertManifest => !!m);
  }

  remove(sessionId: string, id: string): void {
    const dir = this.dir(sessionId, id);
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉下次清理再试 */ }
  }

  /**
   * 清理：单会话只留最近 keepPerSession 次；超过 maxAgeMs 的删除；总量超过上限时从最旧的开始删。
   * 没有 manifest 的残缺目录（写入中途失败留下的）一并删除。返回删除的目录数。
   */
  prune(policy: PrunePolicy = DEFAULT_PRUNE): number {
    let sessions: string[] = [];
    try { sessions = fs.readdirSync(this.root); } catch { return 0; }
    const cutoff = this.now() - policy.maxAgeMs;
    const kept: Array<{ sessionId: string; id: string; at: number; bytes: number }> = [];
    let removed = 0;
    for (const sid of sessions) {
      const sdir = this.sessionDir(sid);
      let names: string[] = [];
      try { names = fs.readdirSync(sdir); } catch { continue; }
      let n = 0;
      for (const id of names.sort().reverse()) {
        const m = safeId(sid) && safeId(id) ? this.read(sid, id) : null;
        if (!m || m.at < cutoff || n >= policy.keepPerSession) {
          try { fs.rmSync(path.join(sdir, id), { recursive: true, force: true }); removed++; } catch { /* 下次再试 */ }
          continue;
        }
        n++;
        kept.push({ sessionId: sid, id, at: m.at, bytes: dirSize(path.join(sdir, id)) });
      }
      try { if (fs.readdirSync(sdir).length === 0) fs.rmdirSync(sdir); } catch { /* 忽略 */ }
    }
    let total = kept.reduce((s, k) => s + k.bytes, 0);
    for (const k of kept.sort((a, b) => a.at - b.at)) {
      if (total <= policy.maxTotalBytes) break;
      this.remove(k.sessionId, k.id);
      total -= k.bytes;
      removed++;
    }
    return removed;
  }
}
