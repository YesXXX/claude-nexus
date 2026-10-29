import { describe, it, expect } from 'vitest';
import { useApp, q } from './harness';
import { clickButton, createSessionViaForm, mkWorkDir, recordOf, rowSel, runTurn, waitOutput, waitStatus } from './fixtures';

describe('退出保留与启动恢复', () => {
  const app = useApp();
  const ids: string[] = [];
  const claudeIds: string[] = [];

  /** 待续接分组头（标题为「待续接」）的计数，没有该分组返回 null */
  const suspendedCount = () => app.eval<string | null>(`(() => {
    const h = [...document.querySelectorAll('.gh')].find(x => x.textContent.includes('待续接'));
    return h ? (h.querySelector('.c')?.textContent ?? '').trim() : null; })()`);

  it('两个会话各跑一轮，退出设置为保留', async () => {
    for (const [i, label] of ['保留甲', '保留乙'].entries()) {
      const id = await createSessionViaForm(app, label, mkWorkDir(app, `proj-keep-${i}`));
      ids.push(id);
      claudeIds.push(String((await app.session(id))?.claudeSessionId ?? ''));
      await runTurn(app, id, `keep-${i}`);
    }
    const saved = await app.eval<{ onQuit: string; onStartup: string }>(`window.panelApi.resumeSettingsSet({ onQuit: 'keep' })`);
    expect(saved).toMatchObject({ onQuit: 'keep', onStartup: 'ask' });
  });

  it('退出后重新打开：横幅提示保留了 2 个会话，侧栏「待续接」分组', async () => {
    await app.restart();
    await app.waitVisible('#restore-banner');
    expect(await app.text('#restore-banner .rb-text')).toBe('上次保留了 2 个会话');
    await app.until(async () => (await suspendedCount()) === '2', { message: '待续接分组计数为 2' });
    for (const [i, id] of ids.entries()) {
      const s = await waitStatus(app, id, 'suspended');
      expect(s.claudeSessionId).toBe(claudeIds[i]);
      expect(s.dormant).toBe(true);
      expect(await recordOf(app, id)).toMatchObject({ state: 'suspended', restoreReason: 'quit', claudeSessionId: claudeIds[i] });
    }
  });

  it('选中待续接的行显示终端区卡片，带续接与全新开始', async () => {
    await app.click(rowSel(ids[0]));
    await app.waitVisible(`.dormant-card[data-session="${ids[0]}"]`);
    expect(await app.exists(`.dormant-card[data-session="${ids[0]}"] .dc-resume`)).toBe(true);
    expect(await app.exists(`.dormant-card[data-session="${ids[0]}"] .dc-fresh`)).toBe(true);
  });

  it('横幅「全部续接」：两个会话沿用原 id 续接，横幅消失', async () => {
    await app.click('#restore-banner .rb-all');
    for (const [i, id] of ids.entries()) {
      const s = await waitStatus(app, id, 'running', 20_000);
      expect(s.claudeSessionId).toBe(claudeIds[i]);
      expect(s.dormant).toBeFalsy();
      await waitOutput(app, id, '已续接，历史 1 条');
      await app.until(async () => (await recordOf(app, id))?.state === 'live', { message: `记录 ${id} 回到进行中` });
    }
    await app.waitFor(`!document.querySelector('#restore-banner')`, { message: '横幅消失' });
    await app.until(async () => (await suspendedCount()) === null, { message: '待续接分组消失' });
    await app.waitFor(`!document.querySelector(${q(`.dormant-card[data-session="${ids[0]}"]`)})`, { message: '卡片消失' });
    expect(app.logs()).toContain(`--resume ${claudeIds[0]}`);
    expect(app.logs()).toContain(`--resume ${claudeIds[1]}`);
  });

  it('再次退出保留后，横幅「全部归档」把会话转入最近结束', async () => {
    await app.restart();
    await app.waitVisible('#restore-banner');
    await app.until(async () => (await suspendedCount()) === '2', { message: '再次保留 2 个会话' });
    await app.click('#restore-banner .rb-archive');
    await app.waitVisible('#confirm-buttons');
    await clickButton(app, '#confirm-buttons', '归档');
    await app.waitFor(`!document.querySelector('#restore-banner')`, { message: '横幅消失' });
    await app.until(async () => (await app.list()).length === 0, { message: '列表清空' });
    if (!(await app.visible('#main-empty'))) await app.click('#btn-new');
    await app.waitVisible('#main-empty');
    for (const id of ids) {
      await app.waitVisible(`#recent-ended .re-item[data-record="${id}"]`);
      expect(await recordOf(app, id)).toMatchObject({ state: 'ended' });
    }
  });
});
