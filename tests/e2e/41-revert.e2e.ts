import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { q, useApp } from './harness';
import { createSessionViaForm, git, initGitRepo, switchChangesScope, waitOutput, writeFiles } from './fixtures';

/**
 * 撤销单个文件（仓库视角）：在「仅未提交」口径下撤销一个修改文件，文件回到 HEAD、横幅出现、备份写在 <HOME>/undo/；
 * 点横幅「恢复」后文件与撤销前逐字节一致；未跟踪文件的确认框写明将删除。
 */

const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('撤销单个文件', () => {
  const app = useApp();
  let id = '';
  let repo = '';
  let editedSha = '';

  const confirmText = () => app.text('#confirm-message');
  const clickConfirm = (text: string) => app.eval<boolean>(`(() => {
    const b = [...document.querySelectorAll('#confirm-buttons button')].find(x => x.textContent.trim() === ${q(text)});
    if (!b) return false; b.click(); return true; })()`);
  const rowBtn = (name: string) => app.eval<boolean>(`(() => {
    const b = document.querySelector(${q(`.chg-row[title="${name}"] .rv-row-btn`)});
    if (!b) return false; b.click(); return true; })()`);

  it('准备：会话在改过文件的仓库里，打开改动页', async () => {
    repo = initGitRepo(app, 'proj-revert', { 'a.txt': 'one\r\ntwo\r\nthree\r\n', 'keep.txt': 'keep\n' });
    // 面板里的 git 读仓库配置：固定换行处理，避免全局 autocrlf 影响逐字节比对
    git(repo, 'config', 'core.autocrlf', 'false');
    id = await createSessionViaForm(app, '撤销用例', repo);
    await waitOutput(app, id, 'mock-claude 已启动');
    writeFiles(repo, { 'a.txt': 'one\r\nTWO changed\r\nthree\r\nfour\r\n', 'note.md': '临时笔记\n' });
    editedSha = sha(path.join(repo, 'a.txt'));
    expect(await app.postHook(id, { hook_event_name: 'Stop' })).toBe(200);
    await app.until(async () => (await app.session(id))?.changes?.files === 2, { message: '改动摘要为 2 个文件' });
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    await switchChangesScope(app, 'repo');
    await app.waitFor(`document.querySelectorAll('.chg-row').length === 2`, { message: '列表 2 个文件' });
    await app.waitFor(`document.querySelectorAll('.chg-row .rv-row-btn').length === 2`, { message: '每行都有撤销按钮' });
  });

  it('确认框写明口径、提交与将执行的命令；取消后文件不变', async () => {
    const head = git(repo, 'rev-parse', '--short=7', 'HEAD').trim();
    expect(await rowBtn('a.txt')).toBe(true);
    await app.waitVisible('#confirm-backdrop');
    const msg = await confirmText();
    expect(msg).toContain(`口径：仅未提交 · 将恢复到 HEAD 提交 ${head} 的版本`);
    expect(msg).toContain(`将执行：git restore --source=${head} --staged --worktree -- a.txt`);
    expect(msg).toContain('当前内容会先备份，可在撤销后「恢复」。');
    expect(msg).not.toContain('Claude 正在运行');
    expect(await app.eval<boolean>(`document.querySelector('#confirm-backdrop').classList.contains('danger')`)).toBe(true);
    expect(await clickConfirm('取消')).toBe(true);
    await app.waitHidden('#confirm-backdrop');
    expect(sha(path.join(repo, 'a.txt'))).toBe(editedSha);
  });

  it('撤销修改文件：文件等于 HEAD，横幅出现，undo 目录下有备份', async () => {
    await app.click('.chg-row[title="a.txt"]');
    await app.waitFor(`document.querySelector('.rv-head-btn') !== null`, { message: 'diff 头部有撤销按钮' });
    await app.click('.rv-head-btn');
    await app.waitVisible('#confirm-backdrop');
    expect(await clickConfirm('撤销此文件')).toBe(true);
    await app.waitFor(`(document.querySelector('.rv-bar:not([hidden]) .rv-bar-text')?.textContent ?? '').startsWith('已撤销 a.txt · ')`,
      { message: '横幅出现' });
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('one\r\ntwo\r\nthree\r\n');
    expect(git(repo, 'status', '--porcelain', '--', 'a.txt').trim()).toBe('');
    const undo = path.join(app.home, 'undo', id);
    const dirs = fs.readdirSync(undo);
    expect(dirs).toHaveLength(1);
    expect(fs.existsSync(path.join(undo, dirs[0], 'manifest.json'))).toBe(true);
    await app.waitFor(`document.querySelectorAll('.chg-row').length === 1`, { message: '列表只剩 note.md' });
    expect(await app.eval(`window.panelApi.revert.last(${q(id)}).then(e => e && e.paths)`)).toEqual(['a.txt']);
    await app.shot('revert-banner');
  });

  it('点横幅「恢复」：文件与撤销前逐字节一致，横幅消失', async () => {
    await app.click('.rv-bar .rv-restore');
    await app.waitFor(`document.querySelector('.rv-bar').hidden === true`, { message: '横幅消失' });
    expect(sha(path.join(repo, 'a.txt'))).toBe(editedSha);
    await app.waitFor(`document.querySelectorAll('.chg-row').length === 2`, { message: 'a.txt 回到列表' });
    expect(await app.eval(`window.panelApi.revert.last(${q(id)})`)).toBeNull();
  });

  it('未跟踪文件：右键菜单撤销，确认框写明将删除', async () => {
    const opened = await app.eval<boolean>(`(() => {
      const row = document.querySelector('.chg-row[title="note.md"]');
      if (!row) return false;
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
      return true; })()`);
    expect(opened).toBe(true);
    await app.waitVisible('.rv-menu');
    await app.click('.rv-menu .rv-menu-item');
    await app.waitVisible('#confirm-backdrop');
    const msg = await confirmText();
    expect(msg).toContain('将删除该文件（未被 git 跟踪）');
    expect(msg).not.toContain('将执行：');
    await app.shot('revert-confirm-untracked');
    expect(await clickConfirm('撤销此文件')).toBe(true);
    await app.until(() => !fs.existsSync(path.join(repo, 'note.md')), { message: 'note.md 被删除' });
    await app.waitFor(`(document.querySelector('.rv-bar:not([hidden]) .rv-bar-text')?.textContent ?? '').startsWith('已撤销 note.md')`,
      { message: '横幅换成 note.md' });
    await app.click('.rv-bar .rv-restore');
    await app.until(() => fs.existsSync(path.join(repo, 'note.md')), { message: 'note.md 恢复' });
    expect(fs.readFileSync(path.join(repo, 'note.md'), 'utf8')).toBe('临时笔记\n');
  });
});
