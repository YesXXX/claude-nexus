import type { ChangeKind, DiffHunk, DiffLine } from './types';

// git 输出的纯函数解析：不碰文件系统与进程，便于用固定样本单测

/** git status --porcelain=v2 -z 的条目（只保留改动统计需要的字段） */
export interface StatusEntry {
  type: 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';
  xy: string;            // 两位状态码：X 为暂存区，Y 为工作区；untracked/ignored 为 '??' / '!!'
  path: string;
  oldPath?: string;
}

/**
 * 解析 porcelain v2 -z 输出。各类条目在路径前的固定字段数不同，路径本身可能含空格，
 * 所以先按空格切出固定字段，剩余部分整体作为路径；重命名条目的原路径是紧跟的下一个 NUL 段。
 */
export function parsePorcelainV2(out: string): StatusEntry[] {
  const parts = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const tag = rec[0];
    if (tag === '#') continue;
    if (tag === '?' || tag === '!') {
      entries.push({ type: tag === '?' ? 'untracked' : 'ignored', xy: tag + tag, path: rec.slice(2) });
      continue;
    }
    const fixed = tag === '1' ? 8 : tag === '2' ? 9 : tag === 'u' ? 10 : -1;
    if (fixed < 0) continue;
    const fields = rec.split(' ');
    const p = fields.slice(fixed).join(' ');
    const xy = fields[1] ?? '..';
    if (tag === '1') entries.push({ type: 'changed', xy, path: p });
    else if (tag === 'u') entries.push({ type: 'unmerged', xy, path: p });
    else {
      const oldPath = parts[i + 1];
      i++;
      entries.push({ type: 'renamed', xy, path: p, oldPath });
    }
  }
  return entries;
}

/** status 条目数（不含被忽略的），用于「有 N 个未提交改动」提示 */
export function countDirty(entries: StatusEntry[]): number {
  return entries.filter(e => e.type !== 'ignored').length;
}

export interface NameStatusEntry { kind: ChangeKind; path: string; oldPath?: string; }

/**
 * 解析 git diff --name-status -z。格式：状态码\0路径\0；重命名 / 复制带相似度且有两个路径：R100\0旧\0新\0。
 * 复制（C）视为新增，未合并（U）视为冲突。
 */
export function parseNameStatusZ(out: string): NameStatusEntry[] {
  const parts = out.split('\0');
  const result: NameStatusEntry[] = [];
  let i = 0;
  while (i < parts.length) {
    const code = parts[i];
    if (!code) { i++; continue; }
    const c = code[0];
    if (c === 'R' || c === 'C') {
      const oldPath = parts[i + 1] ?? '';
      const p = parts[i + 2] ?? '';
      result.push(c === 'R' ? { kind: 'renamed', path: p, oldPath } : { kind: 'added', path: p });
      i += 3;
      continue;
    }
    const p = parts[i + 1] ?? '';
    const kind: ChangeKind = c === 'A' ? 'added' : c === 'D' ? 'deleted' : c === 'T' ? 'typechange'
      : c === 'U' ? 'conflicted' : 'modified';
    result.push({ kind, path: p });
    i += 2;
  }
  return result;
}

export interface NumstatEntry { path: string; oldPath?: string; additions: number | null; deletions: number | null; }

/**
 * 解析 git diff --numstat -z。普通条目：增\t删\t路径\0；重命名条目路径段为空，随后两个 NUL 段为旧、新路径。
 * 二进制文件增删都是 '-'，记为 null。
 */
export function parseNumstatZ(out: string): NumstatEntry[] {
  const parts = out.split('\0');
  const result: NumstatEntry[] = [];
  let i = 0;
  while (i < parts.length) {
    const rec = parts[i];
    if (!rec) { i++; continue; }
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) { i++; continue; }
    const additions = m[1] === '-' ? null : Number(m[1]);
    const deletions = m[2] === '-' ? null : Number(m[2]);
    if (m[3] === '') {
      result.push({ additions, deletions, oldPath: parts[i + 1] ?? '', path: parts[i + 2] ?? '' });
      i += 3;
    } else {
      result.push({ additions, deletions, path: m[3] });
      i += 1;
    }
  }
  return result;
}

export interface WorktreeListEntry { path: string; head?: string; branch?: string; bare: boolean; detached: boolean; }

/** 解析 git worktree list --porcelain：空行分隔的块，第一块是主工作区 */
export function parseWorktreeList(out: string): WorktreeListEntry[] {
  const result: WorktreeListEntry[] = [];
  let cur: WorktreeListEntry | null = null;
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) { if (cur) result.push(cur); cur = null; continue; }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') { if (cur) result.push(cur); cur = { path: val, bare: false, detached: false }; continue; }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = val;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'bare') cur.bare = true;
    else if (key === 'detached') cur.detached = true;
  }
  if (cur) result.push(cur);
  return result;
}

export interface ParsedDiff { binary: boolean; truncated: boolean; hunks: DiffHunk[]; }

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * 解析单文件 unified diff。文件头（diff --git / index / --- / +++）跳过；
 * 「Binary files ... differ」判为二进制；超过 maxLines 行截断并标记。
 */
export function parseUnifiedDiff(out: string, maxLines = 5000): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let count = 0;
  let binary = false;
  const lines = out.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const h = HUNK_RE.exec(line);
    if (h) {
      cur = { header: line, lines: [] };
      hunks.push(cur);
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      continue;
    }
    if (!cur) {
      if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) binary = true;
      continue;
    }
    if (count >= maxLines) return { binary, truncated: true, hunks };
    const c = line[0];
    let dl: DiffLine;
    if (c === '+') dl = { kind: 'add', newNo: newNo++, text: line.slice(1) };
    else if (c === '-') dl = { kind: 'del', oldNo: oldNo++, text: line.slice(1) };
    else if (c === '\\') dl = { kind: 'meta', text: line.slice(2) };
    else if (c === ' ' || line === '') dl = { kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) };
    else continue;
    cur.lines.push(dl);
    count++;
  }
  return { binary, truncated: false, hunks };
}

/** 未跟踪文件没有 git diff：整份内容作为一个全新增的分块 */
export function addedFileDiff(text: string, maxLines = 5000): ParsedDiff {
  if (!text) return { binary: false, truncated: false, hunks: [] };
  const lines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  if (endsWithNewline) lines.pop();
  if (lines.length === 0) return { binary: false, truncated: false, hunks: [] };
  const truncated = lines.length > maxLines;
  const shown = truncated ? lines.slice(0, maxLines) : lines;
  const hunk: DiffHunk = {
    header: `@@ -0,0 +1,${lines.length} @@`,
    lines: shown.map((l, i) => ({ kind: 'add' as const, newNo: i + 1, text: l.endsWith('\r') ? l.slice(0, -1) : l })),
  };
  if (!truncated && !endsWithNewline) hunk.lines.push({ kind: 'meta', text: 'No newline at end of file' });
  return { binary: false, truncated, hunks: [hunk] };
}

/** 文件被删除：整份原内容作为一个全删除的分块 */
export function removedFileDiff(text: string, maxLines = 5000): ParsedDiff {
  const added = addedFileDiff(text, maxLines);
  const n = added.hunks[0]?.lines.filter(l => l.kind === 'add').length ?? 0;
  for (const h of added.hunks) {
    const total = /\+1,(\d+)/.exec(h.header)?.[1] ?? String(n);
    h.header = `@@ -1,${total} +0,0 @@`;
    h.lines = h.lines.map(l => (l.kind === 'add' ? { kind: 'del' as const, oldNo: l.newNo, text: l.text } : l));
  }
  return added;
}

/** 文本行数（与 git numstat 口径一致：末尾无换行的最后一行也算一行） */
export function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/** 前 8000 字节含 NUL 即判为二进制（与 git 的启发式一致） */
export function looksBinary(buf: Uint8Array): boolean {
  const end = Math.min(buf.length, 8000);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
}
