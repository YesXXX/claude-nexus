import { describe, it, expect } from 'vitest';
import { useApp } from './harness';
import { createSessionViaForm, mkWorkDir, selectedSessionId, terminalFocusedExpr, waitOutput } from './fixtures';

describe('命令面板', () => {
  const app = useApp();
  const labels = ['调色甲', '调色乙', '调色丙'];
  const ids: string[] = [];

  /** 命令面板当前列出的条目标题 */
  const titles = () => app.eval<string[]>(
    `[...document.querySelectorAll('#palette-list .pal-i .pt')].map(el => (el.textContent ?? '').trim())`);

  /** 高亮条目的标题 */
  const highlighted = () => app.eval<string>(
    `(document.querySelector('#palette-list .pal-i.on .pt')?.textContent ?? '').trim()`);

  const paletteOpen = () => app.visible('#palette-backdrop');

  it('新建三个会话后回到首页', async () => {
    for (const [i, label] of labels.entries()) {
      ids.push(await createSessionViaForm(app, label, mkWorkDir(app, `pal-${i}`)));
      await waitOutput(app, ids[i], 'mock-claude 已启动');
    }
    // 回到首页：命令面板里不再出现针对当前会话的命令，过滤结果只含会话
    await app.blur();
    await app.press('Control+N');
    await app.waitVisible('#main-empty');
  });

  it('Ctrl+K 打开命令面板，输入框获得焦点', async () => {
    await app.press('Control+K');
    await app.waitVisible('#palette-backdrop');
    expect(await app.eval(`document.activeElement?.id`)).toBe('palette-input');
    expect((await titles()).length).toBeGreaterThan(labels.length);
  });

  it('输入关键字过滤，方向键移动高亮，回车切换到对应会话', async () => {
    await app.type('调色');
    await app.waitFor(`document.querySelectorAll('#palette-list .pal-i').length === 3`, { message: '过滤后只剩三个会话' });
    const order = await titles();
    expect([...order].sort()).toEqual([...labels].sort());
    expect(await highlighted()).toBe(order[0]);

    await app.press('ArrowDown');
    await app.press('ArrowDown');
    expect(await highlighted()).toBe(order[2]);
    // 已在末尾，继续向下不越界
    await app.press('ArrowDown');
    expect(await highlighted()).toBe(order[2]);
    await app.press('ArrowUp');
    expect(await highlighted()).toBe(order[1]);

    await app.press('Enter');
    await app.waitHidden('#palette-backdrop');
    const want = ids[labels.indexOf(order[1])];
    await app.until(async () => (await selectedSessionId(app)) === want, { message: `切换到 ${order[1]}` });
    expect((await app.text('#pane-label')).trim()).toBe(order[1]);
  });

  it('Esc 关闭命令面板且不改变选中会话', async () => {
    const before = await selectedSessionId(app);
    await app.blur();
    await app.press('Control+K');
    await app.waitVisible('#palette-backdrop');
    await app.press('Escape');
    await app.waitHidden('#palette-backdrop');
    expect(await selectedSessionId(app)).toBe(before);
  });

  it('终端内 Ctrl+K 留给终端，Ctrl+Shift+K 打开命令面板', async () => {
    const id = (await selectedSessionId(app))!;
    await app.focus('#main-pane .xterm-helper-textarea');
    await app.waitFor(terminalFocusedExpr(), { message: '终端获得焦点' });
    const len = (await app.output(id)).length;
    await app.press('Control+K');
    // Ctrl+K 作为控制字符进入终端（mock 回显输入），面板保持关闭
    await app.until(async () => (await app.output(id)).length > len, { message: 'Ctrl+K 送达终端' });
    expect(await paletteOpen()).toBe(false);

    await app.press('Control+Shift+K');
    await app.waitVisible('#palette-backdrop');
    await app.press('Escape');
    await app.waitHidden('#palette-backdrop');
  });
});
