import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { createGitRunner } from '../src/main/git-runner';
import { createCliRunner, type CliRunner } from '../src/main/cli-runner';
import { WriteGuard } from '../src/main/write-guard';
import { CommandLog } from '../src/main/command-log';
import { WorktreeManager } from '../src/main/worktree-manager';
import { WorktreeFinisher, lastUrl, pushReason } from '../src/main/worktree-finisher';
import type { Session } from '../src/shared/types';
import type { FinishStatus } from '../src/shared/review-types';
import type { ActivityInput } from '../src/shared/activity';

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function tmpDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(root: string, rel: string, content: string): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** 假 gh：参数逐行记进 calls.log；auth status 的退出码由 authCode 决定，pr create 输出一个 PR 地址 */
function fakeGh(dir: string, authCode: number): string {
  const file = path.join(dir, 'fake-gh.js');
  fs.writeFileSync(file, [
    "const fs = require('fs');",
    "const path = require('path');",
    'const args = process.argv.slice(2);',
    "fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify(args) + '\\n');",
    "if (args[0] === '--version') { console.log('gh version 2.60.0'); process.exit(0); }",
    `if (args[0] === 'auth') { process.stderr.write('not logged in'); process.exit(${authCode}); }`,
    "if (args[0] === 'pr') {",
    "  const body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');",
    "  fs.writeFileSync(path.join(__dirname, 'body.txt'), body);",
    "  console.log('Creating pull request\\nhttps://github.com/o/r/pull/7');",
    '  process.exit(0);',
    '}',
    'process.exit(3);',
  ].join('\n'));
  return file;
}

const SID = 'abcdef12-1111-2222-3333-444444444444';

async function setup(opts: { gh?: CliRunner } = {}) {
  const repo = tmpDir('panel-fin-repo-');
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 't');
  sh(repo, 'config', 'core.autocrlf', 'false');
  write(repo, 'a.txt', 'a1\na2\na3\n');
  write(repo, 'c.txt', 'base\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  write(repo, 'CLAUDE.local.md', 'local\n');
  const home = tmpDir('panel-fin-home-');
  const git = createGitRunner();
  const wm = new WorktreeManager({ git, registryFile: path.join(home, 'worktrees.json'), sleep: async () => {} });
  const { info, cwd } = await wm.create({ sessionId: SID, label: 't', cwd: repo });
  const session = { id: SID, label: '任务一', cwd, worktree: info } as unknown as Session;
  const other = { id: 'main-1', label: '主会话', cwd: repo } as unknown as Session;
  const busy = new Set<string>();
  const sessions = [session, other];
  const log = new CommandLog();
  const refreshed: string[] = [];
  const reported: ActivityInput[] = [];
  const finisher = new WorktreeFinisher({
    git,
    gh: opts.gh ?? createCliRunner({ file: path.join(home, 'no-gh.exe') }),
    claude: createCliRunner({ file: path.join(home, 'no-claude.exe') }),
    log,
    guard: new WriteGuard(git),
    sessions: { get: id => sessions.find(s => s.id === id), list: () => sessions, isBusy: id => busy.has(id) },
    tracker: { refresh: async id => { refreshed.push(id); } },
    tmpDir: path.join(home, 'tmp'),
    activity: { report: input => { reported.push(input); return null; } },
  });
  const wt = info.path;
  /** 在工作区里提交一个改动 */
  const commitInWt = (rel: string, content: string, msg: string): void => {
    write(wt, rel, content);
    sh(wt, 'add', rel);
    sh(wt, 'commit', '-q', '-m', msg);
  };
  const status = async (): Promise<FinishStatus> => {
    const st = await finisher.status(SID);
    if ('error' in st) throw new Error(st.error);
    return st;
  };
  return { repo, home, wt, info, session, busy, log, finisher, refreshed, reported, commitInWt, status };
}

describe('WorktreeFinisher 状态与提交', () => {
  it('初始状态：分支与基线、无领先、无远端、主工作区干净、gh 未安装', async () => {
    const env = await setup();
    const st = await env.status();
    expect(st.branch).toBe('nexus/abcdef12');
    expect(st.branchExists).toBe(true);
    expect(st.baseRef).toBe('main');
    expect(st.baseIsBranch).toBe(true);
    expect([st.ahead, st.behind, st.dirty]).toEqual([0, 0, 0]);
    expect(st.remotes).toEqual([]);
    expect(st.main).toMatchObject({ branch: 'main', clean: true, busySessions: [] });
    expect(st.precheck?.state).toBe('nothing');
    expect(st.gh.state).toBe('missing');
    expect(st.readOnly).toBe(false);
  });

  it('提交：排除复制进来的本地配置，提交后领先 1，并刷新改动', async () => {
    const env = await setup();
    expect(fs.existsSync(path.join(env.wt, 'CLAUDE.local.md'))).toBe(true);
    write(env.wt, 'a.txt', 'a1\nchanged\na3\n');
    write(env.wt, 'new/b.txt', 'b\n');
    write(env.wt, '.claude/settings.local.json', '{}');
    expect((await env.status()).dirty).toBe(2);
    const r = await env.finisher.commit(SID, 'feat: 第一次提交\r\n\r\n正文');
    expect(r.ok, r.detail).toBe(true);
    expect(r.message).toMatch(/^已提交 [0-9a-f]+$/);
    expect(r.steps.map(s => s.display.split(' ')[1])).toEqual(['add', 'commit']);
    expect(sh(env.wt, 'show', '--name-only', '--format=%B', 'HEAD')).toBe('feat: 第一次提交\n\n正文\n\n\na.txt\nnew/b.txt');
    expect(sh(env.wt, 'ls-files', '--', 'CLAUDE.local.md', '.claude/settings.local.json')).toBe('');
    expect(fs.existsSync(path.join(env.wt, 'CLAUDE.local.md'))).toBe(true);
    const st = await env.status();
    expect([st.ahead, st.dirty]).toEqual([1, 0]);
    expect(st.prTitle).toBe('feat: 第一次提交');
    expect(st.prBody).toBe('- feat: 第一次提交');
    expect(env.refreshed).toContain(SID);
    expect(fs.readdirSync(path.join(env.home, 'tmp'))).toEqual([]);
    expect(env.log.list(SID).length).toBe(2);
    const sha = r.message.replace('已提交 ', '');
    expect(env.reported).toEqual([{
      type: 'git.commit', source: 'finish', sessionId: SID, detail: 'feat: 第一次提交',
      data: { sha, subject: 'feat: 第一次提交', branch: 'nexus/abcdef12', files: 2 },
    }]);
  });

  it('提交拒绝：空信息、没有改动、只读；忙碌时先要确认', async () => {
    const env = await setup();
    expect((await env.finisher.commit(SID, '  ')).message).toBe('提交信息不能为空');
    expect((await env.finisher.commit(SID, 'x')).message).toBe('没有需要提交的改动');
    write(env.wt, 'a.txt', 'z\n');
    env.busy.add(SID);
    const b = await env.finisher.commit(SID, 'x');
    expect(b.needConfirm).toBe('busy');
    expect(sh(env.wt, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect((await env.finisher.commit(SID, 'x', { force: true })).ok).toBe(true);
    (env.session as { readOnly?: boolean }).readOnly = true;
    write(env.wt, 'a.txt', 'y\n');
    const ro = await env.finisher.commit(SID, 'x');
    expect(ro.ok).toBe(false);
    expect(ro.message).toContain('只读');
  });

  it('提交钩子失败给出钩子输出；跳过钩子时提交成功', async () => {
    const env = await setup();
    const hook = path.join(env.repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho "lint 未通过"\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    write(env.wt, 'a.txt', 'hook\n');
    const r = await env.finisher.commit(SID, 'feat: x');
    expect(r.ok).toBe(false);
    expect(r.message).toBe('提交失败');
    expect(r.detail).toContain('lint 未通过');
    const r2 = await env.finisher.commit(SID, 'feat: x', { noVerify: true });
    expect(r2.ok, r2.detail).toBe(true);
    expect(r2.steps[1].display).toContain('--no-verify');
  });

  it('不是工作区会话或会话不存在', async () => {
    const env = await setup();
    expect((await env.finisher.commit('main-1', 'x')).message).toBe('只有独立工作区会话才能收尾');
    expect(await env.finisher.status('nope')).toEqual({ error: '会话不存在' });
  });
});

describe('WorktreeFinisher 合并', () => {
  it('四种拒绝：主工作区有改动、不在基线分支、有忙碌会话、没有提交', async () => {
    const env = await setup();
    expect((await env.finisher.merge(SID)).message).toBe('没有需要合并的提交');
    env.commitInWt('a.txt', 'wt\n', 'feat: wt');
    write(env.repo, 'c.txt', 'dirty\n');
    expect((await env.finisher.merge(SID)).message).toBe('主工作区有 1 个未提交改动，请先在主工作区提交或暂存');
    sh(env.repo, 'checkout', '-q', '--', 'c.txt');
    sh(env.repo, 'switch', '-q', '-c', 'other');
    expect((await env.finisher.merge(SID)).message).toContain('主工作区当前在 other 上，不在基线分支 main 上');
    sh(env.repo, 'switch', '-q', 'main');
    env.busy.add('main-1');
    expect((await env.finisher.merge(SID)).message).toBe('主工作区里有正在运行的会话：主会话，请等它们这一轮结束后再合并');
    env.busy.delete('main-1');
    expect(sh(env.repo, 'rev-list', '--count', 'main')).toBe('1');
  });

  it('预检干净后 --no-ff 合并生成合并提交', async () => {
    const env = await setup();
    env.commitInWt('new.txt', 'n\n', 'feat: new');
    const st = await env.status();
    expect(st.precheck).toEqual({ state: 'clean', files: [] });
    const r = await env.finisher.merge(SID);
    expect(r.ok, r.detail).toBe(true);
    expect(r.message).toBe('已把 nexus/abcdef12 合并到 main');
    expect(sh(env.repo, 'log', '-1', '--format=%s%n%P')).toMatch(/^Merge branch 'nexus\/abcdef12'\n\w+ \w+$/);
    expect((await env.status()).ahead).toBe(0);
    expect(env.reported).toEqual([{
      type: 'git.merge', source: 'finish', sessionId: SID,
      data: { from: 'nexus/abcdef12', into: 'main', ok: true, sha: sh(env.repo, 'rev-parse', '--short', 'HEAD') },
    }]);
  });

  it('--ff-only：可快进时快进，基线有新提交时失败', async () => {
    const env = await setup();
    env.commitInWt('new.txt', 'n\n', 'feat: new');
    const r = await env.finisher.merge(SID, { ffOnly: true });
    expect(r.ok, r.detail).toBe(true);
    expect(sh(env.repo, 'rev-parse', 'main')).toBe(sh(env.wt, 'rev-parse', 'HEAD'));
    env.commitInWt('new2.txt', 'n\n', 'feat: new2');
    write(env.repo, 'm.txt', 'm\n');
    sh(env.repo, 'add', 'm.txt');
    sh(env.repo, 'commit', '-q', '-m', 'main moves');
    const r2 = await env.finisher.merge(SID, { ffOnly: true });
    expect(r2.ok).toBe(false);
    expect(r2.message).toBe('合并失败');
  });

  it('冲突：预检报出文件，合并后保留现场并列出冲突，放弃合并后回到原样', async () => {
    const env = await setup();
    env.commitInWt('c.txt', 'from wt\n', 'feat: wt side');
    write(env.repo, 'c.txt', 'from main\n');
    sh(env.repo, 'commit', '-q', '-am', 'main side');
    const head = sh(env.repo, 'rev-parse', 'HEAD');
    const st = await env.status();
    expect(st.precheck).toEqual({ state: 'conflict', files: ['c.txt'] });
    expect(st.behind).toBe(1);
    const r = await env.finisher.merge(SID);
    expect(r.ok).toBe(false);
    expect(r.message).toBe('合并出现冲突');
    expect(r.conflicts).toEqual(['c.txt']);
    expect(env.reported).toEqual([{
      type: 'git.merge', source: 'finish', sessionId: SID, data: { from: 'nexus/abcdef12', into: 'main', ok: false, conflicts: 1 },
    }]);
    const after = await env.status();
    expect(after.main.inProgress).toBe('merge');
    expect((await env.finisher.merge(SID)).message).toBe('主工作区有进行中的合并，请先完成或放弃');
    const p = await env.finisher.conflictPrompt(SID);
    expect('text' in p && p.files).toEqual(['c.txt']);
    expect('text' in p && p.text).toContain(env.repo);
    const a = await env.finisher.abortMerge(SID);
    expect(a.ok, a.detail).toBe(true);
    expect(sh(env.repo, 'rev-parse', 'HEAD')).toBe(head);
    expect((await env.status()).main.inProgress).toBeUndefined();
    expect((await env.finisher.abortMerge(SID)).message).toBe('主工作区没有进行中的合并');
    expect(await env.finisher.conflictPrompt(SID)).toEqual({ error: '主工作区没有冲突文件' });
  });

  it('基线不是分支时拒绝合并', async () => {
    const env = await setup();
    env.commitInWt('new.txt', 'n\n', 'feat: new');
    env.info.baseRef = env.info.baseCommit.slice(0, 8);
    const st = await env.status();
    expect(st.baseIsBranch).toBe(false);
    expect(st.ahead).toBe(1);
    expect((await env.finisher.merge(SID)).message).toContain('不是分支，无法合并');
  });
});

describe('WorktreeFinisher 推送与 PR', () => {
  it('推送到本地裸仓库并设置上游；地址不可达时给出可读原因', async () => {
    const env = await setup();
    expect((await env.finisher.push(SID, 'origin')).message).toBe('没有配置远端，可在会话里执行 git remote add 添加');
    const bare = tmpDir('panel-fin-bare-');
    sh(bare, 'init', '-q', '--bare');
    sh(env.wt, 'remote', 'add', 'origin', bare);
    sh(env.wt, 'remote', 'add', 'broken', path.join(env.home, 'missing.git'));
    expect((await env.finisher.push(SID, 'origin')).message).toBe('没有需要推送的提交');
    expect((await env.finisher.push(SID, 'nope')).message).toBe('远端 nope 不存在');
    env.commitInWt('new.txt', 'n\n', 'feat: new');
    const r = await env.finisher.push(SID, 'origin');
    expect(r.ok, r.detail).toBe(true);
    expect(r.message).toBe('已推送到 origin/nexus/abcdef12');
    expect(sh(bare, 'rev-parse', 'refs/heads/nexus/abcdef12')).toBe(sh(env.wt, 'rev-parse', 'HEAD'));
    const st = await env.status();
    expect(st.upstream).toEqual({ name: 'origin/nexus/abcdef12', ahead: 0, behind: 0 });
    const bad = await env.finisher.push(SID, 'broken');
    expect(bad.ok).toBe(false);
    expect(bad.message).toBe('推送失败：无法访问远端，请检查远端地址与网络');
  });

  it('gh 未安装：返回可复制命令与比较页链接，不执行任何命令', async () => {
    const env = await setup();
    sh(env.wt, 'remote', 'add', 'origin', 'https://user:tok@github.com/o/r.git');
    env.commitInWt('new.txt', 'n\n', 'feat: 新功能');
    const st = await env.status();
    expect(st.remotes).toEqual([{ name: 'origin', url: 'https://github.com/o/r.git', web: 'https://github.com/o/r' }]);
    expect(st.gh).toEqual({ state: 'missing', host: 'github.com' });
    const r = await env.finisher.pr(SID, { remote: 'origin', title: st.prTitle, body: st.prBody, pushFirst: true });
    expect(r.ok).toBe(false);
    expect(r.message).toBe('未安装 gh，可复制命令或打开比较页');
    expect(r.detail).toBe('gh pr create --base main --head nexus/abcdef12 --title "feat: 新功能" --body "- feat: 新功能"');
    expect(r.url).toBe('https://github.com/o/r/compare/main...nexus/abcdef12?expand=1');
    expect(r.steps).toEqual([]);
    expect(await env.finisher.compareUrl(SID, 'origin')).toBe(r.url);
    expect((await env.finisher.pr(SID, { remote: 'origin', title: ' ', body: '', pushFirst: false })).message).toBe('PR 标题不能为空');
  });

  it('GitLab 与无法识别的远端直接走复制命令', async () => {
    const env = await setup();
    sh(env.wt, 'remote', 'add', 'gl', 'git@gitlab.com:g/r.git');
    sh(env.wt, 'remote', 'add', 'local', path.join(env.home, 'x.git'));
    env.commitInWt('new.txt', 'n\n', 'feat: new');
    const g = await env.finisher.pr(SID, { remote: 'gl', title: 't', body: '', pushFirst: false });
    expect(g.message).toBe('GitLab 远端请在网页上创建合并请求');
    expect(g.url).toContain('/-/merge_requests/new?');
    const l = await env.finisher.pr(SID, { remote: 'local', title: 't', body: '', pushFirst: false });
    expect(l.message).toBe('远端不是 GitHub / GitLab 的网页地址，只能复制命令');
    expect(l.url).toBeUndefined();
    expect(l.detail).toContain('gh pr create');
  });

  it('gh 已登录：经说明文件创建 PR 并返回地址', async () => {
    const dir = tmpDir('panel-fin-gh-');
    const gh = createCliRunner({ file: process.execPath, prefixArgs: [fakeGh(dir, 0)] });
    const env = await setup({ gh });
    sh(env.wt, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    env.commitInWt('new.txt', 'n\n', 'feat: new');
    expect((await env.status()).gh).toEqual({ state: 'ok', host: 'github.com' });
    const r = await env.finisher.pr(SID, { remote: 'origin', title: '标题', body: '说明\r\n第二行', pushFirst: false });
    expect(r.ok, r.message).toBe(true);
    expect(r.url).toBe('https://github.com/o/r/pull/7');
    expect(fs.readFileSync(path.join(dir, 'body.txt'), 'utf8')).toBe('说明\n第二行\n');
    const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[]);
    const create = calls.find(c => c[0] === 'pr')!;
    expect(create.slice(0, 8)).toEqual(['pr', 'create', '--base', 'main', '--head', 'nexus/abcdef12', '--title', '标题']);
    expect(calls).toContainEqual(['auth', 'status', '--hostname', 'github.com']);
    expect(env.log.list(SID).some(c => c.display.startsWith('gh pr create'))).toBe(true);
    expect(fs.readdirSync(path.join(env.home, 'tmp'))).toEqual([]);
  });

  it('gh 未登录：状态为 unauthed，建 PR 走复制命令', async () => {
    const dir = tmpDir('panel-fin-gh-');
    const gh = createCliRunner({ file: process.execPath, prefixArgs: [fakeGh(dir, 1)] });
    const env = await setup({ gh });
    sh(env.wt, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    env.commitInWt('new.txt', 'n\n', 'feat: new');
    expect((await env.status()).gh.state).toBe('unauthed');
    const r = await env.finisher.pr(SID, { remote: 'origin', title: 't', body: '', pushFirst: false });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('gh 未登录 github.com');
    expect(r.url).toContain('/compare/main...nexus/abcdef12');
  });

  it('提示词：在工作区里合入基线的提示带上预检冲突文件', async () => {
    const env = await setup();
    env.commitInWt('c.txt', 'wt\n', 'feat: wt');
    write(env.repo, 'c.txt', 'main\n');
    sh(env.repo, 'commit', '-q', '-am', 'main side');
    const p = await env.finisher.mergeInWorktreePrompt(SID);
    expect(typeof p).toBe('string');
    expect(p as string).toContain('main');
    expect(p as string).toContain('c.txt');
  });
});

describe('辅助函数', () => {
  it('lastUrl 取最后一个链接', () => {
    expect(lastUrl('a https://x/1\nWarning\nhttps://github.com/o/r/pull/9\n')).toBe('https://github.com/o/r/pull/9');
    expect(lastUrl('none')).toBeUndefined();
  });
  it('pushReason 分类', () => {
    const r = (stderr: string, timedOut = false) => ({ code: 1, stdout: '', stderr, ms: 1, notFound: false, timedOut });
    expect(pushReason(r('', true))).toContain('超时');
    expect(pushReason(r('fatal: could not read Username for https://github.com'))).toContain('需要凭据');
    expect(pushReason(r(' ! [rejected] main -> main (fetch first)'))).toContain('远端拒绝');
    expect(pushReason(r("fatal: 'x' does not appear to be a git repository"))).toContain('无法访问远端');
    expect(pushReason(r('fatal: https://u:secret@h/x weird'))).not.toContain('secret');
  });
});
