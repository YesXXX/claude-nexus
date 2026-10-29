import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { q, useApp } from './harness';
import { clickButton, clickPaneMenu, createSessionViaForm, exitSession, mkWorkDir, rowSel, runTurn, waitOutput, waitStatus } from './fixtures';

/**
 * 终端输出导出：页头「⋯」菜单「导出终端输出」与命令面板「导出终端输出」两个入口，三种格式。
 * 隔离实例设置 CLAUDE_PANEL_TEST_SAVE_DIR，主进程跳过保存对话框，直接写入实例临时目录。
 */

const ESC = '\x1b';

describe('终端输出导出', () => {
  const app = useApp({ env: { CLAUDE_PANEL_TEST_SAVE_DIR: '{root}/exports' } });
  const exportDir = () => path.join(app.root, 'exports');
  let id = '';
  let idleId = '';

  const toastTexts = () => app.eval<string[]>(
    `[...document.querySelectorAll('#toast-container .toast-title')].map(el => el.textContent ?? '')`);
  const waitToast = (part: string) => app.until(async () => (await toastTexts()).find(t => t.includes(part)),
    { message: `出现包含「${part}」的提示` });
  const clearToasts = () => app.eval(`document.querySelectorAll('#toast-container .toast').forEach(el => el.remove())`);
  const filesNow = () => (fs.existsSync(exportDir()) ? fs.readdirSync(exportDir()) : []);

  /** 在页头菜单点导出后选择格式，返回新写出的文件 */
  const exportVia = async (choice: string, before: string[]): Promise<string> => {
    await app.waitVisible('#confirm-buttons');
    await clickButton(app, '#confirm-buttons', choice);
    const msg = await waitToast('已导出到');
    const file = await app.until(async () => filesNow().find(f => !before.includes(f)), { message: '导出文件写出' });
    expect(msg).toContain(path.join(exportDir(), file));
    return path.join(exportDir(), file);
  };

  it('页头菜单导出「按屏幕重放」：无控制符、中文正常、文件名为 标签-时间.txt', async () => {
    id = await createSessionViaForm(app, '导出用例', mkWorkDir(app, 'proj-export'));
    await waitOutput(app, id, 'mock-claude 已启动');
    await runTurn(app, id, '导出中文任务甲');
    await runTurn(app, id, '导出中文任务乙');
    const before = filesNow();
    await clickPaneMenu(app, 'export-output');
    const file = await exportVia('纯文本（按屏幕重放，推荐）', before);
    expect(path.basename(file)).toMatch(/^导出用例-\d{8}-\d{4}\.txt$/);
    const body = fs.readFileSync(file, 'utf8');
    expect(body.includes(ESC)).toBe(false);
    expect(body.split('\n')[0]).toContain('按屏幕重放');
    expect(body).toContain('导出中文任务甲');
    expect(body).toContain('导出中文任务乙');
    expect(body).toContain('收到任务');
    await app.shot('term-export-done');
  });

  it('命令面板导出「直接去除控制符」', async () => {
    await clearToasts();
    const before = filesNow();
    await app.blur();
    await app.press('Control+K');
    await app.waitVisible('#palette-backdrop');
    await app.type('导出终端输出');
    await app.waitFor(`document.querySelector('#palette-list .pal-i.on .pt')?.textContent.trim() === '导出终端输出'`,
      { message: '命令面板条目高亮' });
    await app.press('Enter');
    await app.waitHidden('#palette-backdrop');
    const file = await exportVia('纯文本（直接去除控制符）', before);
    const body = fs.readFileSync(file, 'utf8');
    expect(body.includes(ESC)).toBe(false);
    expect(body.split('\n')[0]).toContain('直接去除控制符');
    expect(body).toContain('导出中文任务甲');
  });

  it('原始 ANSI 导出为 .log，内容与终端缓冲一致', async () => {
    await clearToasts();
    const before = filesNow();
    await clickPaneMenu(app, 'export-output');
    const file = await exportVia('原始 ANSI', before);
    expect(path.extname(file)).toBe('.log');
    const raw = await app.output(id);
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
  });

  it('格式选项一行放不下时纵向排列，按钮不超出弹窗', async () => {
    await clickPaneMenu(app, 'export-output');
    await app.waitVisible('#confirm-buttons');
    const layout = await app.eval<{ stacked: boolean; inside: boolean; lastText: string }>(`(() => {
      const box = document.querySelector('#confirm-buttons');
      const modal = box.closest('.modal').getBoundingClientRect();
      const btns = [...box.querySelectorAll('.btn')];
      const inside = btns.every(b => {
        const r = b.getBoundingClientRect();
        return r.left >= modal.left - 0.5 && r.right <= modal.right + 0.5;
      });
      const bottom = btns.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
      return { stacked: box.classList.contains('stacked'), inside, lastText: bottom.textContent.trim() };
    })()`);
    expect(layout).toEqual({ stacked: true, inside: true, lastText: '取消' });
    await app.shot('term-export-choice');
    await app.press('Escape');
    await app.waitHidden('#confirm-buttons');
  });

  it('取消格式选择不导出', async () => {
    const before = filesNow();
    await clickPaneMenu(app, 'export-output');
    await app.waitVisible('#confirm-buttons');
    await app.press('Escape');
    await app.waitHidden('#confirm-buttons');
    await new Promise(r => setTimeout(r, 300));
    expect(filesNow()).toEqual(before);
  });

  it('进程已退出但仍在列表中的会话可以导出', async () => {
    await clearToasts();
    await exitSession(app, id);
    const before = filesNow();
    await app.click(rowSel(id));
    await clickPaneMenu(app, 'export-output');
    const file = await exportVia('纯文本（按屏幕重放，推荐）', before);
    expect(fs.readFileSync(file, 'utf8')).toContain('导出中文任务乙');
  });

  it('定位文件只接受面板导出过的路径', async () => {
    const err = await app.eval<string>(`window.panelApi.revealExport(${q(path.join(app.root, 'not-exported.txt'))})`);
    expect(err).toBe('只能定位面板导出的文件');
    const bad = await app.eval<{ ok: boolean; error?: string }>(`window.panelApi.exportOutput(${q(id)}, 'html')`);
    expect(bad).toEqual({ ok: false, error: '参数无效' });
  });

  it('没有输出缓冲的会话（重启后待续接）提示无可导出的输出', async () => {
    idleId = await createSessionViaForm(app, '无缓冲用例', mkWorkDir(app, 'proj-export-idle'));
    await waitOutput(app, idleId, 'mock-claude 已启动');
    await runTurn(app, idleId, 'idle-turn');
    await app.eval(`window.panelApi.resumeSettingsSet({ onQuit: 'keep' })`);
    await app.restart();
    await waitStatus(app, idleId, 'suspended', 20_000);
    expect(await app.output(idleId)).toBe('');
    const r = await app.eval<{ ok: boolean; error?: string }>(`window.panelApi.exportOutput(${q(idleId)}, 'rendered')`);
    expect(r).toEqual({ ok: false, error: '无可导出的输出' });
    const before = filesNow();
    await app.waitFor(`!!document.querySelector(${q(rowSel(idleId))})`, { message: '待续接会话行' });
    await app.click(rowSel(idleId));
    await clickPaneMenu(app, 'export-output');
    await app.waitVisible('#confirm-buttons');
    await clickButton(app, '#confirm-buttons', '纯文本（按屏幕重放，推荐）');
    await waitToast('无可导出的输出');
    expect(filesNow()).toEqual(before);
    expect(await app.exceptions()).toEqual([]);
  });
});
