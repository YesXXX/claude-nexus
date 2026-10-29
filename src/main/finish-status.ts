import * as fs from 'fs';
import * as path from 'path';
import { gitOk, type GitRunner } from './git-runner';
import { lockKey } from './write-guard';
import { withoutLocalConfig } from './worktree-manager';
import { countDirty, parsePorcelainV2 } from '../shared/git-parse';
import { parseRemote, stripCredentials } from '../shared/remote-url';
import type { Session, WorktreeInfo } from '../shared/types';
import type { FinishRemote, FinishStatus, GitInProgress } from '../shared/review-types';

/**
 * 收尾页的状态采集：全部是只读 git 命令（git-runner 默认带 GIT_OPTIONAL_LOCKS=0，不抢索引锁）。
 * 工作区一侧：领先 / 落后、未提交文件、进行中的操作、上游、远端、默认 PR 标题与说明；
 * 主工作区一侧：当前分支、是否干净、进行中的操作、里面正忙的其他会话；
 * 再用 merge-tree 预检合并冲突（不碰任何工作区与引用）。
 */

const MAX_DIRTY_LIST = 200;
const MAX_PR_COMMITS = 30;

export interface StatusContext {
  git: GitRunner;
  sessions: { list(): Session[]; isBusy(id: string): boolean };
}

/** 基线的比较端点：基线分支仍存在时用分支，否则用创建时的基线提交 */
export async function baseTip(git: GitRunner, info: WorktreeInfo): Promise<{ ref: string; isBranch: boolean }> {
  const looksSha = info.baseRef === info.baseCommit.slice(0, info.baseRef.length) && /^[0-9a-f]{7,40}$/i.test(info.baseRef);
  if (info.baseRef && !looksSha) {
    const r = await git.run(info.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${info.baseRef}`]);
    if (gitOk(r)) return { ref: `refs/heads/${info.baseRef}`, isBranch: true };
  }
  return { ref: info.baseCommit, isBranch: false };
}

/** 进行中的合并 / 变基 / 拣选：按 git 自己给出的路径判断标记文件是否存在 */
export async function inProgressOf(git: GitRunner, cwd: string): Promise<GitInProgress | undefined> {
  const names = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'];
  const r = await git.run(cwd, ['rev-parse', ...names.flatMap(n => ['--git-path', n])]);
  if (!gitOk(r)) return undefined;
  const lines = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const has = (i: number): boolean => !!lines[i] && fs.existsSync(path.resolve(cwd, lines[i]));
  if (has(0)) return 'merge';
  if (has(1) || has(2)) return 'rebase';
  if (has(3)) return 'cherry-pick';
  return undefined;
}

/** rev-list --left-right --count A...B 的输出：左边是只在 A 的提交数，右边是只在 B 的 */
export function parseLeftRight(out: string): { left: number; right: number } | undefined {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(out);
  return m ? { left: Number(m[1]), right: Number(m[2]) } : undefined;
}

/** remote -v 的 fetch 行，地址去凭据；同名只取第一条 */
export function parseRemotes(out: string): FinishRemote[] {
  const list: FinishRemote[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+)\s+(.+?)\s+\(fetch\)\s*$/.exec(line);
    if (!m || list.some(r => r.name === m[1])) continue;
    const url = stripCredentials(m[2]);
    const parsed = parseRemote(url);
    list.push({ name: m[1], url, ...(parsed ? { web: parsed.web } : {}) });
  }
  return list;
}

/** merge-tree --write-tree --name-only 的输出：第一行是树对象，冲突时其后每行一个文件，空行之后是提示信息 */
export function parseMergeTree(out: string): string[] {
  const lines = out.split(/\r?\n/);
  const files: string[] = [];
  for (const l of lines.slice(1)) {
    if (!l.trim()) break;
    if (!files.includes(l)) files.push(l);
  }
  return files;
}

function within(child: string, root: string): boolean {
  const c = lockKey(child);
  const r = lockKey(root);
  return c === r || c.startsWith(`${r}/`);
}

/** 主工作区的状态（不含忙碌会话） */
export async function mainState(git: GitRunner, repoRoot: string): Promise<Omit<FinishStatus['main'], 'busySessions'>> {
  const sym = await git.run(repoRoot, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const branch = gitOk(sym) ? sym.stdout.trim() || undefined : undefined;
  const st = await git.run(repoRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=no']);
  const dirtyCount = gitOk(st) ? countDirty(parsePorcelainV2(st.stdout)) : 0;
  const inProgress = await inProgressOf(git, repoRoot);
  return { path: repoRoot, ...(branch ? { branch } : {}), clean: gitOk(st) && dirtyCount === 0 && !inProgress, dirtyCount, ...(inProgress ? { inProgress } : {}) };
}

/** 主工作区里正忙的其他普通会话（工作区会话不算，它们在各自的目录里） */
export function busyInMain(ctx: StatusContext, selfId: string, repoRoot: string): string[] {
  return ctx.sessions.list()
    .filter(s => s.id !== selfId && !s.worktree && ctx.sessions.isBusy(s.id) && within(s.cwd, repoRoot))
    .map(s => s.label);
}

/** 工作区里不含本地配置的未提交文件 */
export async function dirtyOf(git: GitRunner, wt: string): Promise<string[] | undefined> {
  const st = await git.run(wt, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  if (!gitOk(st)) return undefined;
  return withoutLocalConfig(parsePorcelainV2(st.stdout)).filter(e => e.type !== 'ignored').map(e => e.path);
}

/** 收尾页的完整状态；gh 一项由调用方填写 */
export async function collectStatus(ctx: StatusContext, s: Session, info: WorktreeInfo): Promise<FinishStatus> {
  const { git } = ctx;
  const wt = info.path;
  const tip = await baseTip(git, info);
  const exists = await git.run(info.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${info.branch}`]);
  const branchExists = gitOk(exists) && fs.existsSync(wt);

  let ahead = 0;
  let behind = 0;
  const lr = branchExists ? await git.run(wt, ['rev-list', '--left-right', '--count', `${tip.ref}...HEAD`]) : undefined;
  const counts = lr && gitOk(lr) ? parseLeftRight(lr.stdout) : undefined;
  if (counts) { behind = counts.left; ahead = counts.right; }

  const dirtyFiles = branchExists ? (await dirtyOf(git, wt)) ?? [] : [];
  const inProgress = branchExists ? await inProgressOf(git, wt) : undefined;

  let upstream: FinishStatus['upstream'];
  if (branchExists) {
    const u = await git.run(wt, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (gitOk(u) && u.stdout.trim()) {
      const ulr = await git.run(wt, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
      const uc = gitOk(ulr) ? parseLeftRight(ulr.stdout) : undefined;
      upstream = { name: u.stdout.trim(), ahead: uc?.right ?? 0, behind: uc?.left ?? 0 };
    }
  }

  const rv = await git.run(branchExists ? wt : info.repoRoot, ['remote', '-v']);
  const remotes = gitOk(rv) ? parseRemotes(rv.stdout) : [];

  const main = { ...(await mainState(git, info.repoRoot)), busySessions: busyInMain(ctx, s.id, info.repoRoot) };

  let precheck: FinishStatus['precheck'];
  if (!branchExists || ahead === 0) precheck = { state: 'nothing', files: [] };
  else if (tip.isBranch) {
    const mt = await git.run(info.repoRoot, ['merge-tree', '--write-tree', '--name-only', '--no-messages', tip.ref, `refs/heads/${info.branch}`]);
    if (mt.code === 0 && !mt.notFound && !mt.timedOut) precheck = { state: 'clean', files: [] };
    else if (mt.code === 1 && /^[0-9a-f]{40}/.test(mt.stdout)) precheck = { state: 'conflict', files: parseMergeTree(mt.stdout) };
    else precheck = { state: 'unknown', files: [] };
  }

  let prTitle = '';
  let prBody = '';
  if (branchExists && ahead > 0) {
    const t = await git.run(wt, ['log', '-1', '--format=%s']);
    prTitle = gitOk(t) ? t.stdout.trim() : '';
    const b = await git.run(wt, ['log', `--max-count=${MAX_PR_COMMITS}`, '--format=- %s', `${tip.ref}..HEAD`]);
    prBody = gitOk(b) ? b.stdout.trim() : '';
  }

  return {
    sessionId: s.id,
    branch: info.branch,
    branchExists,
    baseRef: info.baseRef,
    baseIsBranch: tip.isBranch,
    ahead,
    behind,
    dirty: dirtyFiles.length,
    dirtyFiles: dirtyFiles.slice(0, MAX_DIRTY_LIST),
    ...(inProgress ? { inProgress } : {}),
    ...(upstream ? { upstream } : {}),
    remotes,
    main,
    ...(precheck ? { precheck } : {}),
    gh: { state: 'unknown' },
    prTitle,
    prBody,
    readOnly: !!s.readOnly,
    busy: ctx.sessions.isBusy(s.id),
    checkedAt: Date.now(),
  };
}
