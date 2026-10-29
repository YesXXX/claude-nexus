import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { gitErrorText, gitOk, GIT_PUSH_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS, type GitResult, type GitRunner } from './git-runner';
import { cliErrorText, type CliRunner } from './cli-runner';
import { checkWritable, lockMessage, type WriteGuard } from './write-guard';
import { redactCredentials, type CommandLog } from './command-log';
import { baseTip, collectStatus, dirtyOf, inProgressOf } from './finish-status';
import { LOCAL_CONFIG_FILES } from './worktree-manager';
import { compareUrl as buildCompareUrl, ghCreateCommand, parseRemote, remoteKind } from '../shared/remote-url';
import { commitBlockReason, mergeBlockReason, prBlockReason, pushBlockReason, READ_ONLY_TEXT } from '../shared/finish-rules';
import { conflictPrompt, mergeInWorktreePrompt } from './finish-prompts';
import { suggestCommitMessage, type SuggestResult } from './commit-message';
import type { ActivityReporter } from '../shared/activity';
import type { Session, WorktreeInfo } from '../shared/types';
import type {
  CommandRecord, FinishCommitOptions, FinishMergeOptions, FinishPrOptions, FinishStatus, GitOpResult,
} from '../shared/review-types';

/**
 * 工作区收尾：提交、合并回基线、推送、建 PR。
 * - 所有写操作在仓库写锁内执行，执行前重新采集状态并复查硬条件（只读、主工作区干净、在基线分支上等），
 *   force 只代表用户已确认忙碌警告，不能绕过硬条件；
 * - 合并在主工作区原地执行，冲突时保留现场，返回冲突文件列表；
 * - 推送从不强制；gh 不可用时返回可复制的命令与比较页链接。
 */

export interface FinisherDeps {
  git: GitRunner;
  gh: CliRunner;
  claude: CliRunner;
  log: CommandLog;
  guard: WriteGuard;
  sessions: {
    get(id: string): Session | undefined;
    list(): Session[];
    isBusy(id: string): boolean;
  };
  tracker: { refresh(id: string): Promise<unknown> };
  /** 提交信息与 PR 说明的临时文件目录 */
  tmpDir: string;
  /** gh 检测结果的缓存时长，缺省 5 分钟 */
  ghCacheMs?: number;
  /** 活动日志：提交成功、合并完成或失败时上报 */
  activity?: ActivityReporter;
}

const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
const GH_TIMEOUT_MS = 120000;
const BUSY_TEXT = 'Claude 正在运行，可能马上又改这个工作区';

type Ctx = { session: Session; info: WorktreeInfo };

function fail(message: string, extra: Partial<GitOpResult> = {}): GitOpResult {
  return { ok: false, message, steps: [], ...extra };
}

export class WorktreeFinisher {
  private readonly ghCache = new Map<string, { at: number; state: FinishStatus['gh']['state'] }>();

  constructor(private readonly deps: FinisherDeps) {}

  private ctx(id: string): Ctx | string {
    const session = this.deps.sessions.get(id);
    if (!session) return '会话不存在';
    if (!session.worktree) return '只有独立工作区会话才能收尾';
    return { session, info: session.worktree };
  }

  private record(id: string, cwd: string, file: string, args: string[], r: GitResult, steps: CommandRecord[]): GitResult {
    steps.push(this.deps.log.record(id, cwd, file, args, r));
    return r;
  }

  async status(id: string): Promise<FinishStatus | { error: string }> {
    const c = this.ctx(id);
    if (typeof c === 'string') return { error: c };
    const st = await collectStatus({ git: this.deps.git, sessions: this.deps.sessions }, c.session, c.info);
    st.gh = await this.ghState(st);
    return st;
  }

  /** gh 是否安装、是否已登录首选远端的主机；结果按主机缓存 */
  private async ghState(st: FinishStatus): Promise<FinishStatus['gh']> {
    const remote = st.remotes.find(r => r.name === 'origin') ?? st.remotes[0];
    const parsed = remote ? parseRemote(remote.url) : null;
    const host = parsed && remoteKind(parsed) !== 'gitlab' ? parsed.host : undefined;
    const key = host ?? '';
    const hit = this.ghCache.get(key);
    const ttl = this.deps.ghCacheMs ?? 5 * 60 * 1000;
    if (hit && Date.now() - hit.at < ttl) return { state: hit.state, ...(host ? { host } : {}) };
    const state = await this.detectGh(host);
    this.ghCache.set(key, { at: Date.now(), state });
    return { state, ...(host ? { host } : {}) };
  }

  private async detectGh(host: string | undefined): Promise<FinishStatus['gh']['state']> {
    const v = await this.deps.gh.run(['--version'], { env: GH_ENV, timeoutMs: 15000 });
    if (v.notFound || (v.code !== 0 && /not recognized|不是内部或外部命令/i.test(v.stderr))) return 'missing';
    if (v.code !== 0) return 'unknown';
    if (!host) return 'unknown';
    const a = await this.deps.gh.run(['auth', 'status', '--hostname', host], { env: GH_ENV, timeoutMs: 20000 });
    return a.code === 0 && !a.timedOut ? 'ok' : 'unauthed';
  }

  /** 重新采集状态（不检测 gh），写操作在锁内据此复查硬条件 */
  private async fresh(c: Ctx): Promise<FinishStatus> {
    return collectStatus({ git: this.deps.git, sessions: this.deps.sessions }, c.session, c.info);
  }

  async commit(id: string, msg: string, opts: FinishCommitOptions = {}): Promise<GitOpResult> {
    const c = this.ctx(id);
    if (typeof c === 'string') return fail(c);
    const text = typeof msg === 'string' ? msg.replace(/\r\n/g, '\n').trim() : '';
    if (!text) return fail('提交信息不能为空');
    const w = checkWritable(c.session, this.deps.sessions.isBusy);
    if (w.blocked) return fail(READ_ONLY_TEXT);
    if (w.busy && !opts.force) return fail(BUSY_TEXT, { needConfirm: 'busy' });
    const wt = c.info.path;
    const r = await this.deps.guard.withRepo(wt, async (): Promise<GitOpResult> => {
      const st = await this.fresh(c);
      const block = commitBlockReason(st);
      if (block) return fail(block);
      if (st.busy && !opts.force) return fail(BUSY_TEXT, { needConfirm: 'busy' });
      const steps: CommandRecord[] = [];
      const addArgs = ['add', '-A', '--', '.', ...LOCAL_CONFIG_FILES.map(excludePathspec)];
      const add = this.record(id, wt, 'git', addArgs, await this.deps.git.run(wt, addArgs, { timeoutMs: GIT_WRITE_TIMEOUT_MS }), steps);
      if (!gitOk(add)) return this.writeFail(wt, '暂存改动失败', add, steps);
      const file = this.tmpFile('commit-msg');
      try {
        fs.writeFileSync(file, `${text}\n`, 'utf8');
        const args = ['commit', '-F', file, ...(opts.noVerify ? ['--no-verify'] : [])];
        const cm = this.record(id, wt, 'git', args, await this.deps.git.run(wt, args, { timeoutMs: GIT_WRITE_TIMEOUT_MS }), steps);
        if (!gitOk(cm)) return this.writeFail(wt, '提交失败', cm, steps, cm.stdout);
      } finally {
        try { fs.rmSync(file, { force: true }); } catch { /* 临时文件删不掉不影响结果 */ }
      }
      const head = await this.deps.git.run(wt, ['rev-parse', '--short', 'HEAD']);
      const sha = gitOk(head) ? head.stdout.trim() : '';
      this.deps.activity?.report({
        type: 'git.commit', source: 'finish', sessionId: id,
        detail: text.split('\n')[0],
        data: { sha, subject: text.split('\n')[0], branch: c.info.branch, files: st.dirty },
      });
      return { ok: true, message: `已提交 ${sha}`.trim(), steps };
    });
    if (r.ok) await this.deps.tracker.refresh(id).catch(() => undefined);
    return r;
  }

  async merge(id: string, opts: FinishMergeOptions = {}): Promise<GitOpResult> {
    const c = this.ctx(id);
    if (typeof c === 'string') return fail(c);
    const w = checkWritable(c.session, this.deps.sessions.isBusy);
    if (w.blocked) return fail(READ_ONLY_TEXT);
    if (w.busy && !opts.force) return fail(BUSY_TEXT, { needConfirm: 'busy' });
    const root = c.info.repoRoot;
    const r = await this.deps.guard.withRepo(root, async (): Promise<GitOpResult> => {
      const st = await this.fresh(c);
      const block = mergeBlockReason(st);
      if (block) return fail(block);
      if (st.busy && !opts.force) return fail(BUSY_TEXT, { needConfirm: 'busy' });
      const steps: CommandRecord[] = [];
      const branch = c.info.branch;
      const message = opts.message?.trim() || `Merge branch '${branch}'`;
      const args = opts.ffOnly ? ['merge', '--ff-only', branch] : ['merge', '--no-ff', '-m', message, branch];
      const m = this.record(id, root, 'git', args,
        await this.deps.git.run(root, args, { timeoutMs: GIT_WRITE_TIMEOUT_MS, env: { GIT_MERGE_AUTOEDIT: 'no' } }), steps);
      const into = st.baseRef;
      const reportMerge = (ok: boolean, extra: { sha?: string; conflicts?: number } = {}): void => {
        this.deps.activity?.report({ type: 'git.merge', source: 'finish', sessionId: id, data: { from: branch, into, ok, ...extra } });
      };
      if (gitOk(m)) {
        const head = await this.deps.git.run(root, ['rev-parse', '--short', 'HEAD']);
        reportMerge(true, gitOk(head) ? { sha: head.stdout.trim() } : {});
        return { ok: true, message: `已把 ${branch} 合并到 ${into}`, steps };
      }
      const conflicts = await this.conflicts(root);
      reportMerge(false, conflicts.length > 0 ? { conflicts: conflicts.length } : {});
      if (conflicts.length > 0) {
        return fail('合并出现冲突', { conflicts, steps, detail: `主工作区 ${root} 现在处于合并中状态` });
      }
      return this.writeFail(root, '合并失败', m, steps, m.stdout);
    });
    await this.deps.tracker.refresh(id).catch(() => undefined);
    return r;
  }

  /** 主工作区里的冲突文件（由主进程重新读取，不信任渲染层） */
  async conflicts(root: string): Promise<string[]> {
    const r = await this.deps.git.run(root, ['diff', '--name-only', '--diff-filter=U', '-z']);
    return gitOk(r) ? [...new Set(r.stdout.split('\0').filter(Boolean))] : [];
  }

  async abortMerge(id: string): Promise<GitOpResult> {
    const c = this.ctx(id);
    if (typeof c === 'string') return fail(c);
    const w = checkWritable(c.session, this.deps.sessions.isBusy);
    if (w.blocked) return fail(READ_ONLY_TEXT);
    const root = c.info.repoRoot;
    return this.deps.guard.withRepo(root, async () => {
      if (await inProgressOf(this.deps.git, root) !== 'merge') return fail('主工作区没有进行中的合并');
      const steps: CommandRecord[] = [];
      const args = ['merge', '--abort'];
      const r = this.record(id, root, 'git', args, await this.deps.git.run(root, args, { timeoutMs: GIT_WRITE_TIMEOUT_MS }), steps);
      if (!gitOk(r)) return this.writeFail(root, '放弃合并失败', r, steps);
      return { ok: true, message: '已放弃合并，主工作区回到合并前', steps };
    });
  }

  async push(id: string, remote: string): Promise<GitOpResult> {
    const c = this.ctx(id);
    if (typeof c === 'string') return fail(c);
    const w = checkWritable(c.session, this.deps.sessions.isBusy);
    if (w.blocked) return fail(READ_ONLY_TEXT);
    const r = await this.deps.guard.withRepo(c.info.path, async () => {
      const st = await this.fresh(c);
      const block = pushBlockReason(st, remote);
      if (block) return fail(block);
      const steps: CommandRecord[] = [];
      const p = await this.pushStep(id, c, remote, steps);
      return p ?? { ok: true, message: `已推送到 ${remote}/${c.info.branch}`, steps };
    });
    await this.deps.tracker.refresh(id).catch(() => undefined);
    return r;
  }

  /** 执行 push -u；成功返回 undefined，失败返回可读的失败结果 */
  private async pushStep(id: string, c: Ctx, remote: string, steps: CommandRecord[]): Promise<GitOpResult | undefined> {
    const wt = c.info.path;
    const args = ['push', '-u', remote, c.info.branch];
    const r = this.record(id, wt, 'git', args, await this.deps.git.run(wt, args, { timeoutMs: GIT_PUSH_TIMEOUT_MS }), steps);
    if (gitOk(r)) return undefined;
    return fail(`推送失败：${pushReason(r)}`, { detail: redactCredentials(gitErrorText(r)), steps });
  }

  async pr(id: string, opts: FinishPrOptions): Promise<GitOpResult> {
    const c = this.ctx(id);
    if (typeof c === 'string') return fail(c);
    const w = checkWritable(c.session, this.deps.sessions.isBusy);
    if (w.blocked) return fail(READ_ONLY_TEXT);
    const title = (opts.title ?? '').trim();
    const body = (opts.body ?? '').replace(/\r\n/g, '\n').trim();
    if (!title) return fail('PR 标题不能为空');
    return this.deps.guard.withRepo(c.info.path, async () => {
      const st = await this.fresh(c);
      const block = prBlockReason(st, opts.remote);
      if (block) return fail(block);
      const remoteUrl = st.remotes.find(r => r.name === opts.remote)?.url ?? '';
      const parsed = parseRemote(remoteUrl);
      const url = parsed ? buildCompareUrl(parsed, st.baseRef, c.info.branch) : undefined;
      const command = ghCreateCommand(st.baseRef, c.info.branch, title, body);
      const fallback = (message: string, steps: CommandRecord[] = []): GitOpResult =>
        fail(message, { detail: command, ...(url ? { url } : {}), steps });
      if (!parsed) return fallback('远端不是 GitHub / GitLab 的网页地址，只能复制命令');
      if (remoteKind(parsed) === 'gitlab') return fallback('GitLab 远端请在网页上创建合并请求');
      this.ghCache.clear();
      const state = await this.detectGh(parsed.host);
      if (state === 'missing') return fallback('未安装 gh，可复制命令或打开比较页');
      if (state === 'unauthed') return fallback(`gh 未登录 ${parsed.host}，可先在终端执行 gh auth login，或复制命令 / 打开比较页`);
      if (state !== 'ok') return fallback('gh 不可用，可复制命令或打开比较页');

      const steps: CommandRecord[] = [];
      if (opts.pushFirst) {
        const p = await this.pushStep(id, c, opts.remote, steps);
        if (p) return { ...p, message: `${p.message}（未创建 PR）` };
      }
      const file = this.tmpFile('pr-body');
      try {
        fs.writeFileSync(file, body ? `${body}\n` : '', 'utf8');
        const args = ['pr', 'create', '--base', st.baseRef, '--head', c.info.branch, '--title', title, '--body-file', file];
        const r = await this.deps.gh.run(args, { cwd: c.info.path, env: GH_ENV, timeoutMs: GH_TIMEOUT_MS });
        this.record(id, c.info.path, 'gh', args, r, steps);
        const link = lastUrl(r.stdout);
        if (r.code === 0 && link) return { ok: true, message: '已创建 PR', url: link, steps };
        return fallback(`gh 创建 PR 失败：${cliErrorText('gh', r)}`, steps);
      } finally {
        try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ }
      }
    });
  }

  /** 本会话某个远端的比较页链接（主进程按远端地址计算，渲染层传不进任意 URL） */
  async compareUrl(id: string, remote: string): Promise<string | undefined> {
    const c = this.ctx(id);
    if (typeof c === 'string') return undefined;
    const st = await this.fresh(c);
    const url = st.remotes.find(r => r.name === remote)?.url;
    const parsed = url ? parseRemote(url) : null;
    if (!parsed || !st.baseIsBranch) return undefined;
    return buildCompareUrl(parsed, st.baseRef, c.info.branch);
  }

  /** 冲突会话的提示词：冲突文件由主进程重新读取 */
  async conflictPrompt(id: string): Promise<{ text: string; files: string[]; info: WorktreeInfo; label: string } | { error: string }> {
    const c = this.ctx(id);
    if (typeof c === 'string') return { error: c };
    const files = await this.conflicts(c.info.repoRoot);
    if (files.length === 0) return { error: '主工作区没有冲突文件' };
    return { text: conflictPrompt(c.info, files), files, info: c.info, label: c.session.label };
  }

  /** 让本会话在工作区里先把基线合进来：可能冲突的文件取预检结果 */
  async mergeInWorktreePrompt(id: string): Promise<string | { error: string }> {
    const c = this.ctx(id);
    if (typeof c === 'string') return { error: c };
    const st = await this.fresh(c);
    if (!st.baseIsBranch) return { error: `基线 ${st.baseRef} 不是分支` };
    const tip = await baseTip(this.deps.git, c.info);
    return mergeInWorktreePrompt(c.info, tip.ref.replace(/^refs\/heads\//, ''), st.precheck?.files ?? []);
  }

  /** 工作区里不含本地配置的未提交文件数（提交信息生成用） */
  async dirtyCount(id: string): Promise<number> {
    const c = this.ctx(id);
    if (typeof c === 'string') return 0;
    return (await dirtyOf(this.deps.git, c.info.path))?.length ?? 0;
  }

  /** 「请 Claude 生成」提交信息：只读，不进仓库写锁 */
  async suggest(id: string): Promise<SuggestResult> {
    const c = this.ctx(id);
    if (typeof c === 'string') return { ok: false, error: c };
    if (c.session.readOnly) return { ok: false, error: READ_ONLY_TEXT };
    return suggestCommitMessage({ git: this.deps.git, claude: this.deps.claude }, c.info.path);
  }

  private tmpFile(prefix: string): string {
    fs.mkdirSync(this.deps.tmpDir, { recursive: true });
    return path.join(this.deps.tmpDir, `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}.txt`);
  }

  private async writeFail(cwd: string, message: string, r: GitResult, steps: CommandRecord[], extra = ''): Promise<GitOpResult> {
    const lockFile = await this.deps.guard.findIndexLock(cwd);
    if (lockFile) return fail(message, { detail: lockMessage(lockFile), lockFile, steps });
    const first = gitErrorText(r);
    // 钩子失败等情况 stderr 可能为空，信息在 stdout 里
    const detail = first.startsWith('git 退出码') && extra.trim() ? extra.trim().split(/\r?\n/)[0] : first;
    return fail(message, { detail: redactCredentials(detail), steps });
  }
}

/**
 * 排除某个文件的 pathspec。末字符写成字符组，让 git 按通配匹配：
 * 字面路径恰好被 .gitignore 忽略时，git add 会报「路径被忽略」并以退出码 1 结束。
 */
export function excludePathspec(file: string): string {
  return `:(exclude)${file.slice(0, -1)}[${file.slice(-1)}]`;
}

/** stdout 里最后一个 http(s) 链接（gh pr create 成功时输出 PR 地址） */
export function lastUrl(out: string): string | undefined {
  const all = out.match(/https?:\/\/[^\s"'<>]+/g);
  return all ? all[all.length - 1] : undefined;
}

/** push 失败的可读原因 */
export function pushReason(r: GitResult): string {
  const s = `${r.stderr}\n${r.stdout}`;
  if (r.timedOut) return '超时，可能在等待凭据输入或网络不通';
  if (/could not read (username|password)|authentication failed|terminal prompts disabled|permission denied \(publickey\)|403/i.test(s)) {
    return '需要凭据或无权限，请先在终端里登录远端或配置凭据管理器';
  }
  if (/non-fast-forward|fetch first|\[rejected\]|rejected/i.test(s)) {
    return '远端拒绝：远端分支已有新的提交，请先在会话里拉取并合并（面板不提供强制推送）';
  }
  if (/does not appear to be a git repository|could not read from remote|not found|unable to access/i.test(s)) {
    return '无法访问远端，请检查远端地址与网络';
  }
  return redactCredentials(gitErrorText(r));
}
