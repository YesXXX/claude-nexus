import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { q, useApp } from './harness';
import { createWorktreeSession, git, initGitRepo, rowSel, selectedSessionId, waitOutput, writeFiles } from './fixtures';

/**
 * 合并冲突：预检提示会冲突并给出「让本会话先在工作区里把基线合进来」；照样合并后弹出三选一，
 * 选择开解决冲突的会话：新会话以主工作区为工作目录并被选中，Claude 就绪后面板以一次粘贴加单独回车发出提示词
 * （核对 pty 写入追踪）；回到工作区会话放弃合并，主工作区回到合并前。
 */

const BRANCH = 'e2e/conflict';

interface TraceLine { t: number; id: string; data: string }

describe('合并冲突与解决冲突的会话', () => {
  const app = useApp({ env: { CLAUDE_PANEL_PTY_TRACE: '{root}/pty-trace.jsonl' } });
  let id = '';
  let repo = '';
  let wtPath = '';
  let conflictId = '';

  const confirmText = () => app.text('#confirm-message');
  const clickConfirm = (text: string) => app.eval<boolean>(`(() => {
    const b = [...document.querySelectorAll('#confirm-buttons button')].find(x => x.textContent.trim() === ${q(text)});
    if (!b) return false; b.click(); return true; })()`);
  const trace = (): TraceLine[] => {
    const file = path.join(app.root, 'pty-trace.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as TraceLine);
  };
  const mergeHead = () => fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'));

  it('准备：工作区与主分支改了同一行，预检提示会冲突', async () => {
    repo = initGitRepo(app, 'proj-conflict', { 'a.txt': 'one\ntwo\n' });
    git(repo, 'config', 'core.autocrlf', 'false');
    ({ id, wtPath } = await createWorktreeSession(app, '冲突用例', repo, BRANCH));
    writeFiles(wtPath, { 'a.txt': 'one\nWORKTREE\n' });
    git(wtPath, 'commit', '-q', '-am', 'feat: 工作区改第二行');
    writeFiles(repo, { 'a.txt': 'one\nMAIN\n' });
    git(repo, 'commit', '-q', '-am', 'feat: 主分支改第二行');

    await app.waitVisible('#tab-finish');
    await app.press('Control+Shift+F');
    await app.waitVisible('#finish-host');
    await app.waitFor(`!!document.querySelector('#finish-host .fin-precheck.warn')`, { timeout: 20_000, message: '预检提示会冲突' });
    expect(await app.text('.fin-precheck')).toBe('预检：会冲突（a.txt）');
    expect(await app.visible('.fin-merge-in-wt')).toBe(true);
    expect(await app.eval<boolean>(`document.querySelector('.fin-merge').disabled`)).toBe(false);
    await app.shot('finish-precheck-conflict');
  });

  it('合并冲突后选择开解决冲突的会话：新会话在主工作区并被选中', async () => {
    await app.click('.fin-merge');
    await app.waitVisible('#confirm-backdrop');
    expect(await confirmText()).toContain('⚠ 预检有冲突：a.txt');
    expect(await clickConfirm('合并')).toBe(true);
    await app.waitFor(`(document.querySelector('#confirm-message')?.textContent ?? '').includes('现在处于合并中状态')`,
      { timeout: 20_000, message: '冲突后弹出三选一' });
    const buttons = await app.eval<string[]>(`[...document.querySelectorAll('#confirm-buttons button')].map(b => b.textContent.trim())`);
    expect(buttons).toEqual(expect.arrayContaining(['稍后手动处理', '放弃合并', '开一个解决冲突的会话']));
    expect(await confirmText()).toContain('a.txt');
    expect(mergeHead()).toBe(true);

    const before = new Set((await app.list()).map(s => s.id));
    expect(await clickConfirm('开一个解决冲突的会话')).toBe(true);
    const created = await app.until(async () => (await app.list()).find(s => !before.has(s.id)),
      { timeout: 20_000, message: '解决冲突的会话出现' });
    conflictId = created.id;
    expect(created.label).toBe('解决冲突：冲突用例');
    expect(fs.realpathSync.native(created.cwd)).toBe(fs.realpathSync.native(repo));
    expect(created.worktree).toBeFalsy();
    await app.waitFor(`!!document.querySelector(${q(rowSel(conflictId))})`, { message: '新会话的列表行' });
    await app.until(async () => (await selectedSessionId(app)) === conflictId, { message: '新会话被选中' });
  });

  it('Claude 就绪后以一次粘贴加单独回车发出提示词', async () => {
    await waitOutput(app, conflictId, 'mock-claude 已启动');
    const pair = await app.until(() => {
      const mine = trace().filter(l => l.id === conflictId);
      const i = mine.findIndex(l => l.data.startsWith('\x1b[200~'));
      return i >= 0 && mine[i + 1] ? [mine[i], mine[i + 1]] as const : undefined;
    }, { timeout: 30_000, message: '追踪里出现发给新会话的粘贴与回车' });
    const [paste, enter] = pair;
    expect(paste.data.endsWith('\x1b[201~')).toBe(true);
    expect(paste.data).toContain('a.txt');
    expect(paste.data).toContain(BRANCH);
    expect(paste.data).not.toContain('\n');
    expect(enter.data).toBe('\r');
    expect(enter.t - paste.t).toBeGreaterThanOrEqual(25);
    // 粘贴之前除终端获得 / 失去焦点的上报外，面板没有向新会话写过别的内容
    const mine = trace().filter(l => l.id === conflictId);
    const earlier = mine.slice(0, mine.findIndex(l => l.data === paste.data));
    expect(earlier.filter(l => l.data !== '\x1b[I' && l.data !== '\x1b[O')).toEqual([]);
  });

  it('回到工作区会话放弃合并：主工作区回到合并前', async () => {
    await app.click(rowSel(id));
    await app.until(async () => (await selectedSessionId(app)) === id, { message: '选中工作区会话' });
    if (!(await app.visible('#finish-host'))) {
      await app.waitVisible('#tab-finish');
      await app.click('#tab-finish');
    }
    await app.waitVisible('#finish-host');
    await app.waitFor(`!!document.querySelector('#finish-host .fin-abort')`, { timeout: 20_000, message: '出现放弃合并' });
    expect(await app.text('.fin-main')).toBe('主工作区：合并中');
    expect(await app.visible('.fin-conflict-session')).toBe(true);
    await app.shot('finish-merging');
    await app.click('.fin-abort');
    await app.waitVisible('#confirm-backdrop');
    expect(await confirmText()).toContain('git merge --abort');
    expect(await clickConfirm('放弃合并')).toBe(true);
    await app.until(() => !mergeHead(), { timeout: 20_000, message: 'MERGE_HEAD 消失' });
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('one\nMAIN\n');
    await app.waitFor(`!document.querySelector('#finish-host .fin-abort')`, { message: '放弃合并按钮消失' });
    expect(await app.text('.fin-log-sec .fin-log-row .fin-log-cmd')).toContain('git merge --abort');
  });
});
