import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { q, useApp, visibleExpr } from './harness';
import { clickButton, clickPaneMenu, createSessionViaForm, git, initGitRepo, rowSel, waitOutput } from './fixtures';

describe('独立工作区', () => {
  const app = useApp();
  const branch = 'e2e/wt-case';
  let id = '';
  let repo = '';
  let wtPath = '';

  /** 统一成真实长路径再比较（临时目录可能是 8.3 短名） */
  const real = (p: string) => fs.realpathSync.native(p).toLowerCase();

  it('工作目录是 git 仓库时出现独立工作区选项，勾选后新建会话', async () => {
    repo = initGitRepo(app, 'proj-wt', { 'README.md': 'worktree e2e\n' });
    id = await createSessionViaForm(app, '工作区用例', repo, async () => {
      await app.waitVisible('#wt-row');
      await app.waitFor(`document.querySelector('#wt-on')?.disabled === false`, { message: '工作区开关可用' });
      await app.click('#wt-on');
      await app.waitFor(visibleExpr('#wt-fields'), { message: '分支输入框出现' });
      await app.fill('#wt-branch', branch);
    });
    const s = (await app.session(id))!;
    expect(s.worktree?.branch).toBe(branch);
    wtPath = s.worktree!.path;
    expect(fs.existsSync(wtPath)).toBe(true);
    const rel = path.relative(real(path.join(repo, '.claude', 'worktrees')), real(wtPath));
    expect(rel && !rel.startsWith('..') && !path.isAbsolute(rel)).toBe(true);
    expect(real(s.cwd)).toBe(real(wtPath));
    expect(git(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch);
    await waitOutput(app, id, 'mock-claude 已启动');
  });

  it('详情页头与属性面板显示工作区分支，列表行只在悬停提示里带分支', async () => {
    await app.waitVisible('#pane-wt');
    expect((await app.text('#pane-wt')).trim()).toBe(`⑂ ${branch}`);
    expect(await app.text('#inspector')).toContain(branch);
    expect(await app.eval<string>(`document.querySelector(${q(rowSel(id))}).title`)).toContain(`独立工作区 ${branch}`);
  });

  it('结束会话并删除工作区后目录与分支消失', async () => {
    await clickPaneMenu(app, 'end-session');
    await app.waitVisible('#confirm-backdrop');
    await clickButton(app, '#confirm-buttons', '结束并删除工作区');
    await app.until(async () => !(await app.session(id)), { timeout: 20_000, message: '会话从列表移除' });
    await app.until(() => !fs.existsSync(wtPath), { timeout: 20_000, message: '工作区目录被删除' });
    // 先删目录、再删分支，目录消失时分支可能还没删
    await app.until(() => git(repo, 'branch', '--list', branch).trim() === '', { timeout: 20_000, message: '工作区分支被删除' });
    expect(await app.visible('#confirm-backdrop')).toBe(false);
  });
});
