import { describe, it, expect } from 'vitest';
import { useApp } from './harness';
import { createSessionViaForm, isRowSelected, mkWorkDir, terminalFocusedExpr, waitOutput, xtermText } from './fixtures';

describe('表单新建会话', () => {
  const app = useApp();
  let id = '';

  it('填写标签与工作目录后回车，列表出现新会话并显示详情页', async () => {
    await app.waitVisible('#main-empty');
    const cwd = mkWorkDir(app, 'proj-create');
    id = await createSessionViaForm(app, '新建会话用例', cwd);
    expect(await app.count('[data-role="parent"][data-session-id]')).toBe(1);
    expect(await app.visible('#main-pane')).toBe(true);
    expect(await app.visible('#main-empty')).toBe(false);
    expect((await app.text('#pane-label')).trim()).toBe('新建会话用例');
    const s = await app.session(id);
    expect(s?.cwd.toLowerCase()).toBe(cwd.toLowerCase());
  });

  it('终端缓冲与界面终端都显示 mock-claude 启动提示', async () => {
    await waitOutput(app, id, 'mock-claude 已启动');
    await app.until(async () => (await xtermText(app)).includes('mock-claude 已启动'),
      { message: '.xterm-rows 显示 mock-claude 已启动' });
  });

  it('向终端输入任务后 mock 回显收到任务', async () => {
    // 新建后焦点自动落到终端输入区
    await app.waitFor(terminalFocusedExpr(), { message: '终端获得焦点' });
    await app.type('hello-e2e');
    await app.press('Enter');
    await waitOutput(app, id, '收到任务："hello-e2e"');
    await app.until(async () => (await xtermText(app)).includes('收到任务'), { message: '.xterm-rows 显示收到任务' });
  });

  it('列表行带选中样式', async () => {
    expect(await isRowSelected(app, id)).toBe(true);
  });
});
