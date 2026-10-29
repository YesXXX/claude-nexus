import { describe, it, expect } from 'vitest';
import { useApp, q } from './harness';
import { clickButton, clickPaneMenu, createSessionViaForm, mkWorkDir, recordOf, rowSel, runTurn, waitOutput, waitStatus } from './fixtures';

describe('会话历史', () => {
  const app = useApp();
  const label = '历史续接用例';
  let id = '';
  let claudeId = '';

  /** 经页头「结束会话」并确认，等会话从列表移除、记录转为已结束 */
  async function endViaUi(): Promise<void> {
    await clickPaneMenu(app, 'end-session');
    await app.waitVisible('#confirm-buttons');
    await clickButton(app, '#confirm-buttons', '结束会话');
    await app.until(async () => !(await app.session(id)), { message: '会话从列表移除' });
    await app.waitFor(`!document.querySelector(${q(rowSel(id))})`, { message: '列表行消失' });
    await app.until(async () => (await recordOf(app, id))?.state === 'ended', { message: '记录转为已结束' });
  }

  /** 首页「最近结束」里该会话的条目带可点的续接按钮 */
  async function waitRecentResumable(): Promise<void> {
    if (!(await app.visible('#main-empty'))) await app.click('#btn-new');
    await app.waitVisible('#main-empty');
    await app.waitVisible(`#recent-ended .re-item[data-record="${id}"]`);
    await app.waitFor(`!!document.querySelector(${q(`#recent-ended .re-item[data-record="${id}"] .re-resume`)})`,
      { message: '最近结束条目可续接' });
  }

  async function expectResumed(): Promise<void> {
    const s = await waitStatus(app, id, 'running', 20_000);
    expect(s.claudeSessionId).toBe(claudeId);
    expect(s.label).toBe(label);
    await waitOutput(app, id, '已续接');
    await app.until(async () => (await recordOf(app, id))?.state === 'live', { message: '记录回到进行中' });
    await app.waitFor(`!!document.querySelector(${q(rowSel(id))})`, { message: '列表行回来' });
  }

  it('结束会话后进入首页「最近结束」', async () => {
    id = await createSessionViaForm(app, label, mkWorkDir(app, 'proj-history'));
    claudeId = String((await app.session(id))?.claudeSessionId ?? '');
    await runTurn(app, id, 'history-e2e');
    await endViaUi();
    const rec = await recordOf(app, id);
    expect(rec).toMatchObject({ state: 'ended', endReason: 'killed', claudeSessionId: claudeId, label });
    await waitRecentResumable();
    const text = await app.text(`#recent-ended .re-item[data-record="${id}"]`);
    expect(text).toContain(label);
    expect(text).toContain('刚刚');
  });

  it('命令面板「历史」分组可找到并续接，沿用原面板会话 id', async () => {
    await app.blur();
    await app.press('Control+K');
    await app.waitVisible('#palette-backdrop');
    await app.type(label);
    const title = `续接「${label}」`;
    await app.waitFor(`[...document.querySelectorAll('#palette-list .pal-i .pt')].some(el => el.textContent.trim() === ${q(title)})`,
      { message: '历史条目出现' });
    const labs = await app.eval<string[]>(`[...document.querySelectorAll('#palette-list .pal-lab')].map(el => el.textContent.trim())`);
    expect(labs).toContain('历史');
    expect(await app.eval(`document.querySelector('#palette-list .pal-i.on .pt')?.textContent.trim()`)).toBe(title);
    await app.press('Enter');
    await app.waitHidden('#palette-backdrop');
    await expectResumed();
    await app.until(async () => (await recordOf(app, id))?.resumeCount === 1, { message: '续接次数为 1' });
    // 续接成功后从「最近结束」消失
    await app.waitFor(`!document.querySelector(${q(`#recent-ended .re-item[data-record="${id}"]`)})`,
      { message: '最近结束条目移除' });
  });

  it('再次结束后从首页「最近结束」点续接', async () => {
    await app.click(rowSel(id));
    await app.waitVisible('#main-pane');
    await endViaUi();
    await waitRecentResumable();
    await app.click(`#recent-ended .re-item[data-record="${id}"] .re-resume`);
    await expectResumed();
    await app.until(async () => (await recordOf(app, id))?.resumeCount === 2, { message: '续接次数为 2' });
    expect(await app.eval(`document.querySelector('[data-role="parent"].sel')?.getAttribute('data-session-id')`)).toBe(id);
  });
});
