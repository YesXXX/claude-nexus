import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { q, useApp } from './harness';
import { createSessionViaForm, createWorktreeSession, git, initGitRepo, mkWorkDir, waitOutput, writeFiles } from './fixtures';

/**
 * 工作区收尾：只有独立工作区会话有「收尾」标签，数字与 git 一致；提交的确认框列出完整命令，提交后未提交数归零、
 * 操作记录 exit 0；主工作区不干净时合并置灰并说明原因；推送到本地裸仓库后上游更新；
 * gh 不可用时可复制 gh 命令、打开比较页（隔离实例只记录链接）；最后合并回主工作区。
 */

const BRANCH = 'e2e/fin';

function hasGh(): boolean {
  try {
    execFileSync('where', ['gh'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

describe('工作区收尾', () => {
  const app = useApp({ env: { CLAUDE_PANEL_OPEN_EXTERNAL_LOG: '{root}/open-external.jsonl' } });
  let id = '';
  let repo = '';
  let bare = '';
  let wtPath = '';

  const confirmText = () => app.text('#confirm-message');
  const clickConfirm = (text: string) => app.eval<boolean>(`(() => {
    const b = [...document.querySelectorAll('#confirm-buttons button')].find(x => x.textContent.trim() === ${q(text)});
    if (!b) return false; b.click(); return true; })()`);
  const status = () => app.eval<{ ahead: number; dirty: number; upstream?: { name: string; ahead: number } }>(
    `window.panelApi.finish.status(${q(id)})`);
  // 点击后同步进入「检查中…」，等它变回「检查于」即为重新检查完成
  const refresh = async () => {
    await app.click('.fin-refresh');
    await app.waitFor(`(document.querySelector('.fin-time')?.textContent ?? '').startsWith('检查于')`, { message: '重新检查完成' });
  };

  it('准备：仓库带本地裸远端与 GitHub 远端；普通会话没有收尾标签', async () => {
    repo = initGitRepo(app, 'proj-fin', { 'a.txt': 'one\ntwo\n', 'b.txt': 'b\n' });
    // 面板里的 git 读仓库配置：固定换行处理，避免全局 autocrlf 影响合并后的文件内容
    git(repo, 'config', 'core.autocrlf', 'false');
    bare = mkWorkDir(app, 'origin.git');
    git(bare, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'remote', 'add', 'github', 'https://github.com/e2e/demo.git');

    const plain = await createSessionViaForm(app, '普通会话', repo);
    await waitOutput(app, plain, 'mock-claude 已启动');
    await app.waitVisible('#tab-changes');
    expect(await app.visible('#tab-finish')).toBe(false);
    await app.press('Control+Shift+F');
    await new Promise(r => setTimeout(r, 300));
    expect(await app.visible('#finish-host')).toBe(false);

    ({ id, wtPath } = await createWorktreeSession(app, '收尾用例', repo, BRANCH));
    writeFiles(wtPath, { 'a.txt': 'one\nTWO\n' });
    git(wtPath, 'commit', '-q', '-am', 'feat: 第一个提交');
    writeFiles(wtPath, { 'b.txt': 'B\n', 'c.txt': 'new\n' });
    expect(await app.postHook(id, { hook_event_name: 'Stop' })).toBe(200);
    await app.until(async () => (await app.session(id))?.changes, { message: '改动摘要已统计' });
  });

  it('收尾标签：Ctrl+Shift+F 切换，领先与未提交数与 git 一致', async () => {
    await app.waitVisible('#tab-finish');
    await app.press('Control+Shift+F');
    await app.waitVisible('#finish-host');
    await app.waitFor(`!!document.querySelector('#finish-host .fin-ahead')`, { message: '状态已取回' });
    const ahead = Number(git(repo, 'rev-list', '--count', `main..${BRANCH}`).trim());
    const dirty = git(wtPath, 'status', '--porcelain').split('\n').filter(Boolean).length;
    expect(ahead).toBe(1);
    expect(dirty).toBe(2);
    expect(await app.text('.fin-ahead')).toBe(`↑${ahead}`);
    expect(await app.text('.fin-dirty')).toBe(` · ${dirty} 个未提交`);
    expect(await app.text('.fin-branch')).toBe(`⑂ ${BRANCH}`);
    expect(await app.text('.fin-main')).toBe('主工作区：main · 干净');
    await app.waitFor(`document.querySelector('#tab-finish-stat')?.textContent === '↑1'`, { message: '标签上显示领先数' });
    await app.shot('finish-tab');
    await app.press('Control+Shift+F');
    await app.waitHidden('#finish-host');
    await app.press('Control+Shift+F');
    await app.waitVisible('#finish-host');
  });

  it('提交：确认框列出工作目录与 git commit -F，提交后未提交数归零、记录 exit 0', async () => {
    await app.fill('.fin-msg', 'feat: e2e 收尾提交');
    await app.waitFor(`document.querySelector('.fin-commit')?.disabled === false`, { message: '提交按钮可用' });
    await app.click('.fin-commit');
    await app.waitVisible('#confirm-backdrop');
    const msg = await confirmText();
    expect(msg).toContain(`工作目录：${wtPath}`);
    expect(msg).toContain('git commit -F <临时文件>');
    expect(msg).toContain('提交信息：feat: e2e 收尾提交');
    expect(msg).not.toContain('Claude 正在运行');
    expect(await clickConfirm('提交')).toBe(true);
    await app.waitFor(`document.querySelector('.fin-dirty')?.textContent === ' · 0 个未提交'`, { message: '未提交数归零' });
    expect(git(wtPath, 'log', '-1', '--format=%s').trim()).toBe('feat: e2e 收尾提交');
    expect(git(wtPath, 'status', '--porcelain').trim()).toBe('');
    await app.waitFor(`document.querySelector('.fin-ahead')?.textContent === '↑2'`, { message: '领先数变为 2' });
    const row = await app.text('.fin-log-sec .fin-log-row');
    expect(row).toContain('git commit -F');
    expect(await app.text('.fin-log-sec .fin-log-row .fin-log-code')).toBe('exit 0');
    expect(await app.eval<boolean>(`document.querySelector('.fin-commit').disabled`)).toBe(true);
    expect(await app.eval<string>(`document.querySelector('.fin-commit').title`)).toBe('没有需要提交的改动');
  });

  it('主工作区有未提交改动时合并置灰并说明原因', async () => {
    // 主工作区只看已跟踪文件的改动，未跟踪文件不阻止合并
    writeFiles(repo, { 'b.txt': 'main dirty\n' });
    await refresh();
    await app.waitFor(`(document.querySelector('.fin-merge')?.title ?? '').includes('主工作区有 1 个未提交改动')`,
      { message: '合并按钮说明主工作区不干净' });
    expect(await app.eval<boolean>(`document.querySelector('.fin-merge').disabled`)).toBe(true);
    expect(await app.text('.fin-main')).toBe('主工作区：main · 1 个未提交');
    writeFiles(repo, { 'b.txt': 'b\n' });
    await refresh();
    await app.waitFor(`document.querySelector('.fin-merge')?.disabled === false`, { message: '主工作区干净后合并可用' });
  });

  it('推送到本地裸仓库：远端出现分支，上游更新', async () => {
    expect(await app.eval<string>(`document.querySelector('.fin-remote').value`)).toBe('origin');
    await app.click('.fin-push');
    await app.waitVisible('#confirm-backdrop');
    const msg = await confirmText();
    expect(msg).toContain(`git push -u origin ${BRANCH}`);
    expect(await clickConfirm('推送')).toBe(true);
    await app.waitFor(`document.querySelector('.fin-upstream')?.textContent === ${q(`上游 origin/${BRANCH}`)}`,
      { timeout: 20_000, message: '上游显示 origin 分支' });
    expect(git(bare, 'branch', '--list', BRANCH).trim()).toContain(BRANCH);
    expect(git(bare, 'rev-parse', BRANCH).trim()).toBe(git(wtPath, 'rev-parse', 'HEAD').trim());
    const st = await status();
    expect(st.upstream).toMatchObject({ name: `origin/${BRANCH}`, ahead: 0 });
    expect(await app.text('.fin-log-sec .fin-log-row .fin-log-cmd')).toContain(`git push -u origin ${BRANCH}`);
  });

  it('gh 不可用：复制 gh 命令，打开比较页只记录链接', async () => {
    if (!hasGh()) expect(await app.text('.fin-gh')).toBe('gh：未安装');
    expect(await app.eval<string>(`document.querySelector('.fin-pr-title').value`)).toBe('feat: e2e 收尾提交');
    // 不碰系统剪贴板：替换页面里的写剪贴板函数，记录写入的文本
    await app.eval(`(navigator.clipboard.writeText = t => { window.__e2eCopied = t; return Promise.resolve(); }, true)`);
    await app.click('.fin-pr-copy');
    const copied = await app.waitFor<string>(`window.__e2eCopied`, { message: '复制了命令' });
    expect(copied.startsWith(`gh pr create --base main --head ${BRANCH} --title "feat: e2e 收尾提交" --body `)).toBe(true);

    expect(await app.eval<boolean>(`document.querySelector('.fin-pr-compare').disabled`)).toBe(true);
    await app.eval(`(() => { const s = document.querySelector('.fin-remote'); s.value = 'github';
      s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await app.waitFor(`document.querySelector('.fin-pr-compare')?.disabled === false`, { message: 'GitHub 远端可打开比较页' });
    await app.click('.fin-pr-compare');
    const log = path.join(app.root, 'open-external.jsonl');
    const line = await app.until(() => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '') || undefined,
      { message: '记录了外部链接' });
    const url = (JSON.parse(line.split('\n').pop()!) as { url: string }).url;
    expect(url).toBe(`https://github.com/e2e/demo/compare/main...${BRANCH}?expand=1`);
    await app.shot('finish-pr');
  });

  it('合并回主工作区：主分支出现合并提交，之后没有可合并的提交', async () => {
    await app.click('.fin-merge');
    await app.waitVisible('#confirm-backdrop');
    const msg = await confirmText();
    expect(msg).toContain(`工作目录：${fs.realpathSync.native(repo)}`);
    expect(msg).toContain(`git merge --no-ff -m "Merge branch '${BRANCH}'" ${BRANCH}`);
    expect(await clickConfirm('合并')).toBe(true);
    await app.until(() => git(repo, 'log', '-1', '--format=%s').trim() === `Merge branch '${BRANCH}'`, { message: '主分支有合并提交' });
    await app.waitFor(`document.querySelector('.fin-merge')?.title === '没有需要合并的提交'`, { message: '合并后按钮置灰' });
    expect(fs.readFileSync(path.join(repo, 'c.txt'), 'utf8')).toBe('new\n');
  });
});
