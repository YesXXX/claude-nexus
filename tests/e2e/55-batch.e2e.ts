import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { q, useApp } from './harness';
import { clickButton, git, initGitRepo, waitStatus } from './fixtures';

/**
 * 批量派发：表单「并行方案数」派发 3 个方案（各自独立工作区、标签 #1～#3、首条提示词以粘贴块送达），
 * 对比视图自动打开并显示每个方案相对基线的改动；保留 #2 后其余方案结束、工作区删除；
 * 重启后从命令面板打开批次对比并删除记录；另测全部放弃后批次显示已结束。
 * mock 每轮把任务首行追加进工作目录下的 notes.txt，回合内不请求权限。
 */

const PS = '\x1b[200~';
const PE = '\x1b[201~';
const LABEL = '批量用例';

interface BatchInfo { id: string; status: string; sessionIds: string[]; indexes: Record<string, number>; keptSessionId?: string }

describe('批量派发', () => {
  const app = useApp({
    env: {
      CLAUDE_PANEL_MOCK_NO_PERMISSION: '1',
      CLAUDE_PANEL_MOCK_TURN_MS: '300',
      CLAUDE_PANEL_MOCK_EDIT: 'notes.txt',
      CLAUDE_PANEL_MOCK_INPUT_LOG: '{root}/mock-input.log',
    },
  });
  const inputs = (): string[] => {
    const f = path.join(app.root, 'mock-input.log');
    return fs.existsSync(f)
      ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => (JSON.parse(l) as { data: string }).data)
      : [];
  };
  const batches = (): Promise<BatchInfo[]> => app.eval<BatchInfo[]>('window.panelApi.batch.list()');
  const confirmTitle = (t: string) => app.waitFor(
    `!document.querySelector('#confirm-backdrop').hidden && document.querySelector('#confirm-title')?.textContent === ${q(t)}`,
    { message: `确认框「${t}」` });
  let repo = '';
  let ids: string[] = [];
  const wtPaths: string[] = [];

  /** 回到首页、填好表单并打开独立工作区，方案数设为 n */
  const fillBatchForm = async (label: string, n: number, prompt: string): Promise<void> => {
    if (!(await app.visible('#main-empty'))) {
      await app.click('#btn-new');
      await app.waitVisible('#main-empty');
    }
    await app.fill('#form-cwd', repo);
    await app.waitVisible('#wt-row');
    await app.waitFor(`document.querySelector('#wt-on')?.disabled === false`, { message: '工作区开关可用' });
    if (!(await app.eval<boolean>(`document.querySelector('#wt-on').checked`))) await app.click('#wt-on');
    await app.waitVisible('#wt-count');
    await app.fill('#wt-count', String(n));
    await app.fill('#form-label', label);
    await app.eval(`(() => { const t = document.querySelector('#form-prompt'); t.value = ${q(prompt)};
      t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  };

  it('方案数大于 1 时提示改为派发，首条提示词必填', async () => {
    repo = initGitRepo(app, 'proj-batch', { 'README.md': 'batch e2e\n' });
    await fillBatchForm(LABEL, 3, '');
    await app.waitFor(`document.querySelector('.home-hint')?.textContent === 'Enter 派发 3 个方案'`, { message: '提示改为派发' });
    expect(await app.visible('#batch-note')).toBe(true);
    expect(await app.text('#batch-note')).toContain('3 倍');
    expect(await app.eval<boolean>(`document.querySelector('#wt-branch').disabled`)).toBe(true);
    await app.focus('#form-label');
    await app.press('Enter');
    await app.waitFor(`document.querySelector('#form-error')?.textContent === '批量派发需要填写首条提示词'`, { message: '提示词必填' });
    expect((await app.list()).length).toBe(0);
    await app.fill('#wt-count', '1');
    await app.waitFor(`document.querySelector('.home-hint')?.textContent === ''`, { message: '方案数 1 时恢复单个新建（提示位留空）' });
  });

  it('派发 3 个方案：独立工作区、标签 #1～#3、提示词以粘贴块送达，对比视图自动打开', async () => {
    await fillBatchForm(LABEL, 3, '实现排序\n要求稳定');
    await app.focus('#form-prompt');
    await app.press('Control+Enter');
    ids = await app.until(async () => {
      const list = (await app.list()).filter(s => s.label.startsWith(`${LABEL} #`));
      return list.length === 3 ? list.sort((a, b) => a.label.localeCompare(b.label)).map(s => s.id) : undefined;
    }, { timeout: 40_000, message: '3 个方案会话出现' });
    const sessions = await Promise.all(ids.map(id => app.session(id)));
    expect(sessions.map(s => s?.label)).toEqual([`${LABEL} #1`, `${LABEL} #2`, `${LABEL} #3`]);
    for (const s of sessions) {
      expect(s?.worktree?.path).toBeTruthy();
      wtPaths.push(String(s?.worktree?.path));
    }
    expect(new Set(wtPaths).size).toBe(3);
    for (const p of wtPaths) expect(fs.existsSync(p)).toBe(true);
    const [b] = await batches();
    expect(b.status).toBe('active');
    expect([...b.sessionIds].sort()).toEqual([...ids].sort());
    expect(sessions.every(s => (s as unknown as { batchId?: string }).batchId === b.id)).toBe(true);

    await app.waitVisible('#batch-backdrop');
    await app.waitFor(`document.querySelectorAll('#batch-cols .batch-col').length === 3`, { message: '对比视图 3 列' });
    for (const id of ids) await waitStatus(app, id, 'completed', 30_000);
    await app.until(() => inputs().filter(d => d === `${PS}实现排序\r要求稳定${PE}`).length === 3 ? true : undefined,
      { message: '3 个方案都以粘贴块收到提示词' });
    await app.waitFor(`(document.querySelector('#batch-meta')?.textContent ?? '').includes('3/3 已完成首轮')`,
      { timeout: 20_000, message: '页头显示 3/3 已完成首轮' });
    await app.waitFor(`[...document.querySelectorAll('#batch-cols .batch-col')].every(c => (c.querySelector('.batch-sum')?.textContent ?? '').includes('1 个文件'))`,
      { timeout: 20_000, message: '每列显示 1 个文件的改动' });
    expect(await app.text('#batch-cols')).toContain('notes.txt');
    expect(await app.text('#batch-meta')).toContain('进行中');
    for (const id of ids) expect((await app.session(id))?.batchId).toBeTruthy();
    await app.shot('batch-compare');
  });

  it('查看改动跳到该方案的改动标签；状态分区的批次标记重新打开对比', async () => {
    await clickButton(app, '#batch-cols .batch-col[data-index="1"]', '查看改动');
    await app.waitHidden('#batch-backdrop');
    await app.waitVisible('#changes-host');
    expect(await app.eval(`document.querySelector('[data-role="parent"].sel')?.getAttribute('data-session-id')`)).toBe(ids[0]);
    // 改动页默认收起属性面板，手动展开后再点批次标记
    await app.waitHidden('#inspector');
    await app.click('#btn-inspector');
    await app.waitVisible('#inspector');
    expect((await app.text('#inspector .status-sec .batch-marker')).trim()).toBe('⧉ 批次方案 #1');
    await app.click('#inspector .status-sec .batch-marker');
    await app.waitVisible('#batch-backdrop');
    await app.waitFor(`document.querySelectorAll('#batch-cols .batch-col').length === 3`, { message: '对比视图重新打开' });
  });

  it('保留 #2：确认列出其余方案的改动，二次确认后结束其余会话并删除工作区', async () => {
    await clickButton(app, '#batch-cols .batch-col[data-index="2"]', '保留此方案');
    await confirmTitle('保留方案 #2？');
    const msg = await app.text('#confirm-message');
    expect(msg).toContain('#1：1 个未提交文件');
    expect(msg).toContain('#3：1 个未提交文件');
    await clickButton(app, '#confirm-buttons', '保留并清理其余');
    await confirmTitle('这些方案有未保存的改动');
    await clickButton(app, '#confirm-buttons', '仍然删除');
    await app.until(async () => {
      const left = (await app.list()).map(s => s.id);
      return !left.includes(ids[0]) && !left.includes(ids[2]) && left.includes(ids[1]) ? true : undefined;
    }, { timeout: 30_000, message: '#1、#3 从列表移除' });
    await app.until(() => !fs.existsSync(wtPaths[0]) && !fs.existsSync(wtPaths[2]) ? true : undefined,
      { timeout: 30_000, message: '#1、#3 的工作区被删除' });
    expect(fs.existsSync(wtPaths[1])).toBe(true);
    // 工作区删掉之后还要删分支，批次状态在整个流程结束后才写回
    const b = await app.until(async () => {
      const [x] = await batches();
      return x?.status === 'resolved' ? x : undefined;
    }, { timeout: 30_000, message: '批次状态变为已保留' });
    expect(b.keptSessionId).toBe(ids[1]);
    await app.waitFor(`(document.querySelector('#batch-meta')?.textContent ?? '').includes('已保留 #2')`, { message: '页头显示已保留 #2' });
    await app.waitFor(`!!document.querySelector('#batch-cols .batch-col.kept[data-index="2"]')`, { message: '保留列高亮' });
    expect(await app.visible('#batch-discard-all')).toBe(false);
    await app.click('#batch-close');
    await app.waitHidden('#batch-backdrop');
    expect(git(repo, 'branch', '--list').split('\n').filter(l => l.trim()).length).toBe(2);
  });

  it('重启后从命令面板打开批次对比，可删除记录', async () => {
    await app.restart();
    await app.blur();
    await app.press('Control+K');
    await app.waitVisible('#palette-backdrop');
    await app.type('打开批次对比');
    const title = `打开批次对比：${LABEL}`;
    await app.waitFor(`document.querySelector('#palette-list .pal-i.on .pt')?.textContent.trim() === ${q(title)}`,
      { message: '批次条目出现并选中' });
    expect(await app.text('#palette-list .pal-i.on')).toContain('已保留 #2');
    await app.press('Enter');
    await app.waitHidden('#palette-backdrop');
    await app.waitVisible('#batch-backdrop');
    await app.waitFor(`(document.querySelector('#batch-meta')?.textContent ?? '').includes('已保留 #2')`, { message: '重启后仍是已保留' });
    await app.waitVisible('#batch-forget');
    await app.click('#batch-forget');
    await confirmTitle('删除批次记录？');
    await clickButton(app, '#confirm-buttons', '删除记录');
    await app.waitHidden('#batch-backdrop');
    await app.until(async () => (await batches()).length === 0 ? true : undefined, { message: '批次记录删除' });
    expect((await app.list()).some(s => s.id === ids[1])).toBe(true);
  });

  it('全部放弃：两个方案都结束、工作区删除，批次显示已结束', async () => {
    await fillBatchForm('放弃用例', 2, '随便试试');
    await app.focus('#form-prompt');
    await app.press('Control+Enter');
    await app.waitVisible('#batch-backdrop');
    await app.waitFor(`document.querySelectorAll('#batch-cols .batch-col').length === 2`, { timeout: 40_000, message: '对比视图 2 列' });
    const two = (await app.list()).filter(s => s.label.startsWith('放弃用例 #'));
    expect(two.length).toBe(2);
    for (const s of two) await waitStatus(app, s.id, 'completed', 30_000);
    const paths = await Promise.all(two.map(async s => String((await app.session(s.id))?.worktree?.path)));
    await app.waitVisible('#batch-discard-all');
    await app.click('#batch-discard-all');
    await confirmTitle('放弃「放弃用例」的全部方案？');
    await clickButton(app, '#confirm-buttons', '全部放弃');
    await confirmTitle('这些方案有未保存的改动');
    await clickButton(app, '#confirm-buttons', '仍然删除');
    await app.until(async () => !(await app.list()).some(s => s.label.startsWith('放弃用例 #')) ? true : undefined,
      { timeout: 30_000, message: '两个方案都从列表移除' });
    await app.until(() => paths.every(p => !fs.existsSync(p)) ? true : undefined, { timeout: 30_000, message: '两个工作区都被删除' });
    await app.waitFor(`(document.querySelector('#batch-meta')?.textContent ?? '').includes('已结束')`, { message: '页头显示已结束' });
    expect((await batches()).find(b => b.sessionIds.includes(two[0].id))?.status).toBe('ended');
    await app.click('#batch-close');
    await app.waitHidden('#batch-backdrop');
    expect(await app.exceptions()).toEqual([]);
  });
});
