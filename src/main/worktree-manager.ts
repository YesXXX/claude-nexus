import * as fs from 'fs';
import * as path from 'path';
import { GitRunner, gitErrorText, gitOk } from './git-runner';
import { countDirty, parsePorcelainV2, parseWorktreeList, StatusEntry } from '../shared/git-parse';
import { log } from './logger';
import type { GitRepoInfo, KillResult, WorktreeInfo, WorktreeRecord, WorktreeStatus } from '../shared/types';

/** 工作区统一放在主仓库根下的这个目录，与 Claude Code CLI 自身的工作区约定一致 */
export const WORKTREE_DIR = path.join('.claude', 'worktrees');
const EXCLUDE_LINE = '/.claude/worktrees/';

/**
 * 未被跟踪的本地配置：创建工作区时从原目录复制过去，保证权限设置与本地指令一致。
 * 这些文件是面板自己带进去的，统计「未提交文件」时不算，删除工作区前也由面板自己清掉。
 */
export const LOCAL_CONFIG_FILES = ['.claude/settings.local.json', 'CLAUDE.local.md'];

const ADD_TIMEOUT_MS = 120_000;   // 大仓库检出可能很慢
const BUSY_RETRY_MS = 1000;

export interface WorktreeManagerDeps {
  git: GitRunner;
  registryFile: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface CreateWorktreeInput {
  sessionId: string;
  label: string;
  cwd: string;
  branch?: string;
  baseRef?: string;
}

export class WorktreeManager {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: WorktreeManagerDeps) {
    this.sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  /** 探测目录所属仓库：新建表单据此决定是否显示「独立工作区」以及提示内容 */
  async inspect(cwd: string): Promise<GitRepoInfo & { toplevel?: string }> {
    const { git } = this.deps;
    if (!cwd || !fs.existsSync(cwd)) return { state: 'not_repo' };
    const bare = await git.run(cwd, ['rev-parse', '--is-bare-repository']);
    if (bare.notFound) return { state: 'no_git' };
    if (!gitOk(bare)) return { state: 'not_repo' };
    if (bare.stdout.trim() === 'true') return { state: 'bare' };

    const top = await git.run(cwd, ['rev-parse', '--show-toplevel']);
    if (!gitOk(top)) return { state: 'not_repo', error: gitErrorText(top) };
    const toplevel = path.resolve(top.stdout.trim());

    const list = await git.run(cwd, ['worktree', 'list', '--porcelain']);
    const main = gitOk(list) ? parseWorktreeList(list.stdout)[0] : undefined;
    if (main?.bare) return { state: 'bare' };
    const repoRoot = main ? path.resolve(main.path) : toplevel;

    const hasSubmodules = fs.existsSync(path.join(toplevel, '.gitmodules'));
    const head = await this.headName(cwd);
    if (!head) return { state: 'no_commit', repoRoot, toplevel, hasSubmodules };

    const st = await git.run(cwd, ['status', '--porcelain=v2', '-z']);
    const dirtyCount = gitOk(st) ? countDirty(parsePorcelainV2(st.stdout)) : undefined;
    return { state: 'repo', repoRoot, toplevel, head, dirtyCount, hasSubmodules };
  }

  /**
   * 创建独立工作区。成功返回工作区信息与会话应使用的 cwd（原目录是仓库子目录时映射到工作区的同一子目录）。
   * 任一步失败都回滚已创建的目录和分支，并抛出可直接展示的中文错误。
   */
  async create(input: CreateWorktreeInput): Promise<{ info: WorktreeInfo; cwd: string }> {
    const { git } = this.deps;
    const repo = await this.inspect(input.cwd);
    if (repo.state === 'no_git') throw new Error('未检测到 git，无法创建独立工作区');
    if (repo.state === 'bare') throw new Error('裸仓库不支持独立工作区');
    if (repo.state === 'no_commit') throw new Error('仓库还没有提交，无法创建独立工作区');
    if (repo.state !== 'repo' || !repo.repoRoot || !repo.toplevel) throw new Error('所选目录不是 git 仓库');
    const repoRoot = repo.repoRoot;

    const baseRef = input.baseRef?.trim() || repo.head!;
    const base = await git.run(input.cwd, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
    if (!gitOk(base)) throw new Error(`基线不存在：${baseRef}`);
    const baseCommit = base.stdout.trim();

    const id8 = input.sessionId.slice(0, 8);
    const branch = input.branch?.trim() || `nexus/${id8}`;
    const fmt = await git.run(repoRoot, ['check-ref-format', '--branch', branch]);
    if (!gitOk(fmt)) throw new Error(`分支名不合法：${branch}`);
    const exists = await git.run(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (gitOk(exists)) throw new Error(`分支已存在：${branch}`);

    const wtPath = path.join(repoRoot, WORKTREE_DIR, `nexus-${id8}`);
    if (fs.existsSync(wtPath)) throw new Error(`工作区目录已存在：${wtPath}`);

    await this.ensureExclude(repoRoot);
    log('worktree', `创建工作区 ${wtPath}（分支 ${branch}，基线 ${baseRef}@${baseCommit.slice(0, 8)}）`);
    const add = await git.run(repoRoot, ['worktree', 'add', '-b', branch, wtPath, baseCommit], { timeoutMs: ADD_TIMEOUT_MS });
    if (!gitOk(add)) {
      await this.rollback(repoRoot, wtPath, branch);
      throw new Error(`创建工作区失败：${gitErrorText(add)}`);
    }
    log('worktree', `工作区创建完成，耗时 ${add.ms}ms`);

    this.copyLocalConfig(repo.toplevel, wtPath);

    // 子目录用 git 自己算的前缀映射，避开 8.3 短路径、大小写、符号链接导致的 path.relative 偏差
    const prefix = await git.run(input.cwd, ['rev-parse', '--show-prefix']);
    const rel = gitOk(prefix) ? prefix.stdout.trim().replace(/\/$/, '') : '';
    let cwd = rel ? path.join(wtPath, ...rel.split('/')) : wtPath;
    if (!fs.existsSync(cwd)) {
      log('worktree', `子目录 ${rel} 在工作区中不存在（未被跟踪），会话改用工作区根目录`);
      cwd = wtPath;
    }

    const shortBase = baseRef === baseCommit ? baseCommit.slice(0, 8) : baseRef;
    const info: WorktreeInfo = { repoRoot, path: wtPath, branch, baseRef: shortBase, baseCommit };
    this.addRecord({ ...info, sessionId: input.sessionId, label: input.label, createdAt: this.now() });
    return { info, cwd };
  }

  /** 结束会话前展示用：未提交文件数（不含面板复制进去的本地配置）与基线之后的提交数 */
  async status(info: WorktreeInfo): Promise<WorktreeStatus> {
    const { git } = this.deps;
    if (!fs.existsSync(info.path)) return { dirtyFiles: 0, unmergedCommits: 0 };
    const st = await git.run(info.path, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
    const dirtyFiles = gitOk(st) ? countDirty(withoutLocalConfig(parsePorcelainV2(st.stdout))) : 0;
    const ref = await this.unmergedRef(info);
    const rl = await git.run(info.path, ['rev-list', '--count', `${ref}..HEAD`]);
    const unmergedCommits = gitOk(rl) ? Number(rl.stdout.trim()) || 0 : 0;
    return { dirtyFiles, unmergedCommits };
  }

  /**
   * 删除工作区与分支。force=false 时有未提交内容会被 git 拒绝；分支有未合并提交时保留分支。
   * Windows 下目录被进程占用会删除失败：间隔 1 秒重试一次，仍失败则保留并说明。
   */
  async remove(info: WorktreeInfo, force: boolean): Promise<KillResult> {
    const { git } = this.deps;
    if (fs.existsSync(info.path)) {
      if (!force) await this.removeLocalConfig(info.path);
      const args = ['worktree', 'remove', ...(force ? ['--force'] : []), info.path];
      let r = await git.run(info.repoRoot, args);
      if (!gitOk(r) && fs.existsSync(info.path) && isBusyError(r.stderr)) {
        await this.sleep(BUSY_RETRY_MS);
        r = await git.run(info.repoRoot, args);
      }
      if (!gitOk(r) && fs.existsSync(info.path)) {
        const reason = gitErrorText(r);
        log('worktree', `删除工作区失败 ${info.path}：${reason}`);
        if (isBusyError(r.stderr)) {
          return { ok: true, kept: 'busy', message: '工作区目录被占用，已保留，可稍后在命令面板中清理' };
        }
        return { ok: true, kept: 'error', message: `工作区已保留：${reason}` };
      }
    } else {
      await git.run(info.repoRoot, ['worktree', 'prune']);
    }
    this.removeRecord(info.path);
    log('worktree', `已删除工作区 ${info.path}`);

    const br = await git.run(info.repoRoot, ['branch', force ? '-D' : '-d', info.branch]);
    if (!gitOk(br)) {
      const missing = /not found/i.test(br.stderr);
      if (!missing) {
        log('worktree', `分支 ${info.branch} 未删除：${gitErrorText(br)}`);
        return { ok: true, kept: 'unmerged', message: `工作区已删除；分支 ${info.branch} 有未合并的提交，已保留` };
      }
    } else {
      log('worktree', `已删除分支 ${info.branch}`);
    }
    return { ok: true };
  }

  /** 主仓库目录在且其中存在该本地分支 */
  async branchExists(repoRoot: string, branch: string): Promise<boolean> {
    if (!repoRoot || !branch || !fs.existsSync(repoRoot)) return false;
    const r = await this.deps.git.run(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return gitOk(r);
  }

  /**
   * 按原路径与原分支重建被删除的工作区（不新建分支），复制本地配置并重新登记。
   * 目录仍在、主仓库或分支不在时抛出可直接展示的中文错误；git 失败时清掉半成品目录。
   */
  async restore(info: WorktreeInfo, owner: { sessionId: string; label: string }): Promise<void> {
    const { git } = this.deps;
    if (fs.existsSync(info.path)) throw new Error(`工作区目录已存在：${info.path}`);
    if (!fs.existsSync(info.repoRoot)) throw new Error(`主仓库目录已不存在：${info.repoRoot}`);
    if (!(await this.branchExists(info.repoRoot, info.branch))) throw new Error(`分支已不存在：${info.branch}`);

    // 目录被手动删掉后 git 仍认为工作区登记着，先清掉失效元数据，否则 add 会报「already registered」
    await git.run(info.repoRoot, ['worktree', 'prune']);
    await this.ensureExclude(info.repoRoot);
    log('worktree', `重建工作区 ${info.path}（分支 ${info.branch}）`);
    const add = await git.run(info.repoRoot, ['worktree', 'add', info.path, info.branch], { timeoutMs: ADD_TIMEOUT_MS });
    if (!gitOk(add)) {
      if (fs.existsSync(info.path)) fs.rmSync(info.path, { recursive: true, force: true });
      await git.run(info.repoRoot, ['worktree', 'prune']);
      throw new Error(`重建工作区失败：${gitErrorText(add)}`);
    }
    log('worktree', `工作区重建完成，耗时 ${add.ms}ms`);
    this.copyLocalConfig(info.repoRoot, info.path);
    this.addRecord({ ...info, sessionId: owner.sessionId, label: owner.label, createdAt: this.now() });
  }

  /** 登记表中存在、但当前没有对应存活会话的工作区 */
  leftovers(liveSessionIds: Set<string>): WorktreeRecord[] {
    return this.readRecords().filter(r => !liveSessionIds.has(r.sessionId) && fs.existsSync(r.path));
  }

  findRecord(wtPath: string): WorktreeRecord | undefined {
    const key = path.resolve(wtPath);
    return this.readRecords().find(r => path.resolve(r.path) === key);
  }

  /** 启动时同步登记表：目录已不存在的记录移除，并让 git 清掉对应的失效工作区元数据 */
  async prune(): Promise<number> {
    const records = this.readRecords();
    const gone = records.filter(r => !fs.existsSync(r.path));
    const roots = new Set(gone.map(r => r.repoRoot).filter(r => fs.existsSync(r)));
    for (const root of roots) await this.deps.git.run(root, ['worktree', 'prune']);
    if (gone.length > 0) {
      this.writeRecords(records.filter(r => fs.existsSync(r.path)));
      log('worktree', `登记表同步：移除 ${gone.length} 条目录已不存在的工作区记录`);
    }
    return gone.length;
  }

  private async headName(cwd: string): Promise<string | undefined> {
    const { git } = this.deps;
    const sym = await git.run(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
    const name = gitOk(sym) ? sym.stdout.trim() : '';
    const rev = await git.run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (!gitOk(rev)) return undefined;   // 还没有任何提交
    return name || rev.stdout.trim().slice(0, 8);
  }

  /** 统计「未合并提交」的参照：基线分支仍存在时以它为准（它可能已合并过一部分），否则用创建时的基线提交 */
  private async unmergedRef(info: WorktreeInfo): Promise<string> {
    if (info.baseRef && info.baseRef !== info.baseCommit.slice(0, 8)) {
      const r = await this.deps.git.run(info.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${info.baseRef}`]);
      if (gitOk(r)) return r.stdout.trim();
    }
    return info.baseCommit;
  }

  /** 本地排除规则：让主目录的 git status 看不到工作区目录；写的是 info/exclude，不改任何被跟踪文件 */
  private async ensureExclude(repoRoot: string): Promise<void> {
    const r = await this.deps.git.run(repoRoot, ['rev-parse', '--git-common-dir']);
    if (!gitOk(r)) return;
    const commonDir = path.resolve(repoRoot, r.stdout.trim());
    const file = path.join(commonDir, 'info', 'exclude');
    try {
      const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (cur.split(/\r?\n/).some(l => l.trim() === EXCLUDE_LINE)) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const sep = cur && !cur.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(file, `${sep}${EXCLUDE_LINE}\n`);
      log('worktree', `已在 ${file} 追加本地排除规则 ${EXCLUDE_LINE}`);
    } catch (err) {
      log('worktree', `写入本地排除规则失败：${String(err)}`);
    }
  }

  private async rollback(repoRoot: string, wtPath: string, branch: string): Promise<void> {
    const { git } = this.deps;
    if (fs.existsSync(wtPath)) await git.run(repoRoot, ['worktree', 'remove', '--force', wtPath]);
    if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });
    await git.run(repoRoot, ['worktree', 'prune']);
    await git.run(repoRoot, ['branch', '-D', branch]);
    log('worktree', `创建失败，已回滚 ${wtPath}`);
  }

  private copyLocalConfig(fromRoot: string, toRoot: string): void {
    for (const rel of LOCAL_CONFIG_FILES) {
      const src = path.join(fromRoot, rel);
      const dst = path.join(toRoot, rel);
      try {
        if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        log('worktree', `已复制本地配置 ${rel}`);
      } catch (err) {
        log('worktree', `复制本地配置 ${rel} 失败：${String(err)}`);
      }
    }
  }

  /** 只删仍未被跟踪的本地配置（若用户把它提交进了分支，就是正常文件，不动） */
  private async removeLocalConfig(root: string): Promise<void> {
    for (const rel of LOCAL_CONFIG_FILES) {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) continue;
      const tracked = await this.deps.git.run(root, ['ls-files', '--error-unmatch', rel]);
      if (gitOk(tracked)) continue;
      try { fs.rmSync(file, { force: true }); } catch { /* 删除失败交给 git 报错 */ }
    }
  }

  private readRecords(): WorktreeRecord[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.registryFile, 'utf8')) as unknown;
      return Array.isArray(raw) ? raw.filter(isRecord) : [];
    } catch {
      return [];
    }
  }

  private writeRecords(records: WorktreeRecord[]): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.registryFile), { recursive: true });
      fs.writeFileSync(this.deps.registryFile, JSON.stringify(records, null, 2));
    } catch (err) {
      log('worktree', `写入工作区登记表失败：${String(err)}`);
    }
  }

  private addRecord(rec: WorktreeRecord): void {
    this.writeRecords([...this.readRecords().filter(r => path.resolve(r.path) !== path.resolve(rec.path)), rec]);
  }

  private removeRecord(wtPath: string): void {
    const key = path.resolve(wtPath);
    const records = this.readRecords();
    const next = records.filter(r => path.resolve(r.path) !== key);
    if (next.length !== records.length) this.writeRecords(next);
  }
}

export function withoutLocalConfig(entries: StatusEntry[]): StatusEntry[] {
  return entries.filter(e => !(e.type === 'untracked' && isLocalConfigPath(e.path)));
}

export function isLocalConfigPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  return LOCAL_CONFIG_FILES.includes(norm) || norm === '.claude/';
}

/** Windows 下目录被占用时 git 的典型报错 */
function isBusyError(stderr: string): boolean {
  return /permission denied|resource busy|being used by another process|directory not empty|invalid argument/i.test(stderr);
}

function isRecord(v: unknown): v is WorktreeRecord {
  const r = v as WorktreeRecord;
  return !!r && typeof r.path === 'string' && typeof r.repoRoot === 'string'
    && typeof r.branch === 'string' && typeof r.sessionId === 'string';
}
