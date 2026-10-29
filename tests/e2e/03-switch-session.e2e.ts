import { describe, it, expect } from 'vitest';
import { useApp } from './harness';
import { createSessionViaForm, isRowSelected, mkWorkDir, rowSel, selectedSessionId, terminalFocusedExpr, waitOutput } from './fixtures';

describe('切换会话', () => {
  const app = useApp();
  const labels = ['切换甲', '切换乙', '切换丙'];
  const idByLabel = new Map<string, string>();

  /** 侧栏中父会话行的显示顺序（即 Ctrl+数字与 J/K 使用的顺序） */
  const order = () => app.eval<string[]>(
    `[...document.querySelectorAll('[data-role="parent"]')].map(el => el.getAttribute('data-session-id'))`);

  const labelOf = (id: string) => [...idByLabel].find(([, v]) => v === id)?.[0] ?? '';

  /** 等详情页标题变为目标会话，并且只有它的行带选中样式 */
  async function expectSelected(id: string): Promise<void> {
    await app.waitFor(`(document.querySelector('#pane-label')?.textContent ?? '').trim() === ${JSON.stringify(labelOf(id))}`,
      { message: `#pane-label 变为 ${labelOf(id)}` });
    expect(await isRowSelected(app, id)).toBe(true);
    expect(await app.count('[data-role="parent"].sel')).toBe(1);
    expect(await selectedSessionId(app)).toBe(id);
  }

  it('新建三个会话', async () => {
    for (const label of labels) {
      const id = await createSessionViaForm(app, label, mkWorkDir(app, label));
      idByLabel.set(label, id);
      await waitOutput(app, id, 'mock-claude 已启动');
    }
    expect(await app.count('[data-role="parent"]')).toBe(3);
  });

  it('点击列表行切换', async () => {
    const ids = await order();
    for (const id of [ids[1], ids[0]]) {
      await app.click(rowSel(id));
      await expectSelected(id);
    }
  });

  it('Ctrl+数字直达对应序号的会话', async () => {
    const ids = await order();
    await app.press('Control+1');
    await expectSelected(ids[0]);
    await app.press('Control+3');
    await expectSelected(ids[2]);
  });

  it('焦点不在终端时 J/K 上下切换', async () => {
    const ids = await order();
    await app.click(rowSel(ids[0]));
    await expectSelected(ids[0]);
    // 鼠标点选不把焦点交给终端；热键切换会把焦点异步交给终端，J/K 在终端里是普通输入，等它落定后再移开
    let viaHotkey = false;
    for (const [key, want] of [['j', ids[1]], ['j', ids[2]], ['k', ids[1]]] as const) {
      if (viaHotkey) await app.waitFor(terminalFocusedExpr(), { message: '热键切换后终端获得焦点' });
      await app.blur();
      await app.press(key);
      await expectSelected(want);
      viaHotkey = true;
    }
  });

  it('终端内按 J 是普通输入，不切换会话', async () => {
    const before = (await selectedSessionId(app))!;
    await app.waitFor(terminalFocusedExpr(), { message: '终端获得焦点' });
    const len = (await app.output(before)).length;
    await app.press('j');
    await app.until(async () => (await app.output(before)).slice(len).includes('j'), { message: '终端回显 j' });
    expect(await selectedSessionId(app)).toBe(before);
  });
});
