import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { q, useApp } from './harness';
import {
  createSessionViaForm, initGitRepo, sendLine, switchChangesScope, terminalFocusedExpr, waitOutput, waitStatus, writeFiles,
} from './fixtures';

/**
 * 改动批注：在 diff 行号栏添加、编辑、删除批注，批注标记出现在文件行、标签与会话行；
 * 会话等待权限时只能排队，本轮结束后以一次粘贴加单独回车发给 Claude；重启后批注仍在。
 */

const INPUT_LOG = path.join(os.tmpdir(), `nexus-e2e-input-${process.pid}-${Date.now()}.jsonl`);

describe('改动批注', () => {
  const app = useApp({ env: { CLAUDE_PANEL_MOCK_INPUT_LOG: INPUT_LOG } });
  let id = '';
  let repo = '';

  afterAll(() => { try { fs.rmSync(INPUT_LOG, { force: true }); } catch { /* 清理失败不影响结果 */ } });

  const anns = () => app.eval<Array<{ id: string; side: string; start: number; end: number; comment: string; status: string }>>(
    `window.panelApi.annotations.list(${q(id)}).then(r => r.items)`);

  /** 在 diff 中正文为 text 的行上按下行号栏（新行号那一格） */
  const gutterDown = (text: string, shift = false) => app.eval<boolean>(`(() => {
    const row = [...document.querySelectorAll('.chg-diff-scroll .chg-ln')].find(r => r.querySelector('.chg-txt')?.textContent === ${q(text)});
    if (!row) return false;
    row.querySelectorAll('.chg-no')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, shiftKey: ${shift} }));
    return true; })()`);
  const gutterOver = (text: string) => app.eval<boolean>(`(() => {
    const row = [...document.querySelectorAll('.chg-diff-scroll .chg-ln')].find(r => r.querySelector('.chg-txt')?.textContent === ${q(text)});
    if (!row) return false;
    row.querySelectorAll('.chg-no')[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return true; })()`);
  const mouseUp = () => app.eval(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })), true`);
  const editorFocused = () => app.waitFor(`document.activeElement?.classList.contains('ann-input') === true`, { message: '批注输入框获得焦点' });
  const confirmButtons = () => app.eval<string[]>(
    `[...document.querySelectorAll('#confirm-buttons button')].map(b => b.textContent.trim())`);
  const clickConfirm = (text: string) => app.eval<boolean>(`(() => {
    const b = [...document.querySelectorAll('#confirm-buttons button')].find(x => x.textContent.trim() === ${q(text)});
    if (!b) return false; b.click(); return true; })()`);

  it('准备：会话在改过文件的仓库里，打开改动页', async () => {
    repo = initGitRepo(app, 'proj-ann', { 'a.txt': 'one\ntwo\nthree\nfour\n' });
    id = await createSessionViaForm(app, '批注用例', repo);
    await waitOutput(app, id, 'mock-claude 已启动');
    writeFiles(repo, { 'a.txt': 'one\nTWO\nthree\nfour\nfive\n' });
    expect(await app.postHook(id, { hook_event_name: 'Stop' })).toBe(200);
    await app.until(async () => (await app.session(id))?.changes?.files === 1, { message: '改动摘要为 1 个文件' });
    await app.waitFor(terminalFocusedExpr(), { message: '终端获得焦点' });
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    // 批注按仓库内相对路径记录，只在仓库视角可用
    await switchChangesScope(app, 'repo');
    await app.waitFor(`[...document.querySelectorAll('.chg-diff-scroll .chg-ln.add .chg-txt')].some(e => e.textContent === 'TWO')`,
      { message: 'a.txt 的 diff 已渲染' });
  });

  it('点击行号栏写批注，Ctrl+Enter 保存，标记出现在文件行、标签与会话行', async () => {
    expect(await gutterDown('TWO')).toBe(true);
    await mouseUp();
    await editorFocused();
    expect(await app.text('.ann-card-title')).toContain('a.txt:2');
    await app.type('把 TWO 改回小写');
    await app.press('Control+Enter');
    await app.waitFor(`document.querySelector('.ann-note .ann-note-body')?.textContent === '把 TWO 改回小写'`, { message: '行下出现批注摘要' });
    expect(await app.count('.ann-card')).toBe(0);
    const list = await anns();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ side: 'new', start: 2, end: 2, status: 'pending' });
    await app.waitFor(`document.querySelector('.chg-row[title="a.txt"] .ann-row-mark')?.textContent === '◆1'`, { message: '文件行标记 ◆1' });
    await app.waitFor(`(document.querySelector('#tab-changes-stat')?.textContent ?? '').includes('◆1')`, { message: '标签带 ◆1' });
    await app.waitFor(`document.querySelector('#inspector .status-sec .ann-metric')?.textContent === '◆ 1 条批注待发送'`, { message: '状态分区显示待发送批注' });
    expect((await app.text('.ann-bar')).replace(/\s+/g, ' ')).toContain('批注 1 条待发送');
  });

  it('拖动选择行范围，Esc 取消编辑且不离开改动页', async () => {
    expect(await gutterDown('three')).toBe(true);
    expect(await gutterOver('five')).toBe(true);
    await mouseUp();
    await editorFocused();
    expect(await app.text('.ann-card-title')).toContain('a.txt:3-5');
    expect(await app.count('.chg-ln.ann-sel')).toBe(3);
    await app.press('Escape');
    await app.waitFor(`document.querySelectorAll('.ann-card').length === 0`, { message: '编辑卡片关闭' });
    expect(await app.count('.chg-ln.ann-sel')).toBe(0);
    expect(await app.visible('#changes-host')).toBe(true);
  });

  it('点击批注摘要即可编辑', async () => {
    await app.click('.ann-note .ann-note-body');
    await editorFocused();
    expect(await app.eval(`document.activeElement.value`)).toBe('把 TWO 改回小写');
    await app.fill('.ann-card .ann-input', '改回小写 two');
    await app.press('Control+Enter');
    await app.waitFor(`document.querySelector('.ann-note .ann-note-body')?.textContent === '改回小写 two'`, { message: '摘要更新' });
    expect((await anns())[0].comment).toBe('改回小写 two');
  });

  it('整个文件的批注可以添加并删除', async () => {
    await app.click('.ann-file-btn');
    await editorFocused();
    await app.type('补一个文件末尾换行说明');
    await app.press('Control+Enter');
    await app.waitFor(`document.querySelectorAll('.ann-file-zone .ann-note').length === 1`, { message: '顶部区出现文件批注' });
    expect((await anns()).map(a => a.side).sort()).toEqual(['file', 'new']);
    await app.waitFor(`document.querySelector('.chg-row[title="a.txt"] .ann-row-mark')?.textContent === '◆2'`, { message: '文件行标记 ◆2' });

    const ok = await app.eval<boolean>(`(() => {
      const b = [...document.querySelectorAll('.ann-file-zone .ann-note button')].find(x => x.textContent === '删');
      if (!b) return false; b.click(); return true; })()`);
    expect(ok).toBe(true);
    await app.waitVisible('#confirm-backdrop');
    expect(await clickConfirm('删除')).toBe(true);
    await app.until(async () => (await anns()).length === 1, { message: '只剩一条批注' });
    await app.waitFor(`document.querySelectorAll('.ann-file-zone .ann-note').length === 0`, { message: '文件批注已移除' });
  });

  it('会话正忙时可选立即发送或排队，默认焦点在排队', async () => {
    expect(await app.postHook(id, { hook_event_name: 'UserPromptSubmit', prompt: 'x' })).toBe(200);
    await app.until(async () => (await app.session(id))?.busy === true, { message: '会话忙碌' });
    await app.click('.ann-bar .ann-send');
    await app.waitVisible('.ann-send-modal');
    expect(await app.text('.ann-send-pre')).toContain('a.txt:2');
    expect(await app.text('.ann-send-pre')).toContain('改回小写 two');
    await app.click('.ann-send-go');
    await app.waitVisible('#confirm-backdrop');
    expect(await confirmButtons()).toEqual(['取消', '立即发送', '排队，本轮结束后发送']);
    expect(await app.eval(`document.activeElement?.textContent?.trim()`)).toBe('排队，本轮结束后发送');
    expect(await clickConfirm('取消')).toBe(true);
    await app.waitHidden('#confirm-backdrop');
    expect((await anns())[0].status).toBe('pending');
    expect(await app.postHook(id, { hook_event_name: 'Stop' })).toBe(200);
    await app.until(async () => (await app.session(id))?.busy === false, { message: '会话空闲' });
  });

  it('等待权限时只能排队；本轮结束后以一次粘贴加单独回车发出', async () => {
    await sendLine(app, id, 'task-a');
    await waitStatus(app, id, 'waiting_permission');
    await app.click('.ann-bar .ann-send');
    await app.waitVisible('.ann-send-modal');
    await app.click('.ann-send-go');
    await app.waitVisible('#confirm-backdrop');
    expect(await confirmButtons()).toEqual(['取消', '排队，本轮结束后发送']);
    expect(await clickConfirm('排队，本轮结束后发送')).toBe(true);
    await app.until(async () => (await anns())[0]?.status === 'queued', { message: '批注已排队' });
    await app.waitFor(`(document.querySelector('.ann-bar')?.textContent ?? '').includes('本轮结束后发送')`, { message: '横条显示排队' });
    await app.waitFor(`document.querySelector('#inspector .status-sec .ann-metric')?.textContent === '◆ 批注排队中'`, { message: '状态分区显示排队' });

    const before = fs.existsSync(INPUT_LOG) ? fs.readFileSync(INPUT_LOG, 'utf8').split('\n').filter(Boolean).length : 0;
    await sendLine(app, id, 'y');
    await waitOutput(app, id, '收到任务（', 20_000);
    await app.until(async () => (await anns())[0]?.status === 'sent', { message: '批注变为已发送' });

    const lines = fs.readFileSync(INPUT_LOG, 'utf8').split('\n').filter(Boolean).slice(before)
      .map(l => JSON.parse(l) as { t: number; data: string });
    const pi = lines.findIndex(l => l.data.startsWith('\x1b[200~') && l.data.endsWith('\x1b[201~'));
    expect(pi).toBeGreaterThanOrEqual(0);
    expect(lines[pi].data).toContain('改回小写 two');
    expect(lines[pi + 1]?.data).toBe('\r');
    // 注入器两次写入相隔 30ms；mock 读到的时间戳受 pty 转发影响会略有压缩，只要求明显分开
    expect(lines[pi + 1].t - lines[pi].t).toBeGreaterThanOrEqual(10);

    // 消息作为新任务进入权限等待，允许后本轮结束
    await waitStatus(app, id, 'waiting_permission');
    await sendLine(app, id, 'y');
    await waitStatus(app, id, 'completed');
    await app.waitFor(`(document.querySelector('.ann-bar')?.textContent ?? '').includes('批注 1 条已发送')`, { message: '横条显示已发送' });
    await app.waitFor(`!document.querySelector('#inspector .ann-metric')`, { message: '批注标记消失' });
  });

  it('抽屉列出已发送批注，重启后批注仍在', async () => {
    await app.click('.ann-bar .ann-view');
    await app.waitVisible('.ann-drawer');
    expect(await app.text('.ann-drawer-title')).toBe('批注（0）');
    expect(await app.text('.ann-sent-sep')).toBe('已发送（1）');
    await app.shot('annotations-drawer');
    await app.click('.ann-drawer-close');
    await app.waitHidden('.ann-drawer');

    await app.restart();
    const after = await app.until(async () => {
      const r = await app.eval<{ items: Array<{ comment: string; status: string }> }>(`window.panelApi.annotations.list(${q(id)})`);
      return r.items.length ? r.items : undefined;
    }, { message: '重启后读到批注' });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ comment: '改回小写 two', status: 'sent' });
    expect(app.exceptions()).toEqual([]);
  });
});
