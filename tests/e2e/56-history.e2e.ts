import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { q, useApp } from './harness';
import { clickButton, createSessionViaForm, mkWorkDir, recordOf, sendLine, waitOutput, waitStatus } from './fixtures';

/**
 * 会话历史面板：结束的会话带首条与最近提示词进入历史；Ctrl+Shift+H 打开面板，
 * 多词搜索、目录与结束状态过滤；固定、存为模板、续接、删除、在此目录新建；
 * 命令面板搜索提示词打开详情；保留策略按新上限清理、清空保留固定的；记录目录不可用时显示降级横幅。
 */

const A = '登录修复';
const B = '接口重构';

describe('会话历史面板', () => {
  const app = useApp({ env: { CLAUDE_PANEL_MOCK_NO_PERMISSION: '1', CLAUDE_PANEL_MOCK_TURN_MS: '200' } });
  let idA = '';
  let idB = '';
  let cwdA = '';

  const waitItems = (ids: string[], message: string): Promise<unknown> => app.waitFor(
    `JSON.stringify([...document.querySelectorAll('#history-list .hist-item')].map(li => li.dataset.record)) === ${q(JSON.stringify(ids))}`,
    { message });
  const setSearch = async (text: string): Promise<void> => {
    await app.eval(`(() => { const i = document.querySelector('#history-search'); i.value = ${q(text)};
      i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  };
  const setSelect = async (sel: string, value: string): Promise<void> => {
    await app.eval(`(() => { const s = document.querySelector(${q(sel)}); s.value = ${q(value)};
      s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  };
  const pick = async (id: string): Promise<void> => {
    await app.click(`#history-list .hist-item[data-record="${id}"]`);
    await app.waitFor(`document.querySelector('#history-detail')?.dataset.record === ${q(id)}`, { message: '详情切换' });
  };
  const openByHotkey = async (): Promise<void> => {
    await app.blur();
    await app.press('Control+Shift+H');
    await app.waitVisible('#history-backdrop');
  };
  const closePanel = async (): Promise<void> => {
    await app.click('#history-close');
    await app.waitHidden('#history-backdrop');
  };
  const turn = async (id: string, text: string): Promise<void> => {
    await sendLine(app, id, text);
    await app.until(async () => (await recordOf(app, id))?.lastPrompt === text ? true : undefined, { message: `记录收到「${text}」` });
    await waitStatus(app, id, 'completed', 20_000);
  };
  const end = async (id: string): Promise<void> => {
    await app.eval(`window.panelApi.kill(${q(id)})`);
    await app.until(async () => (await recordOf(app, id))?.state === 'ended' ? true : undefined, { message: '记录转为已结束' });
  };

  it('结束的会话带首条与最近提示词进入历史，Ctrl+Shift+H 打开面板', async () => {
    cwdA = mkWorkDir(app, 'proj-web');
    idA = await createSessionViaForm(app, A, cwdA);
    await waitOutput(app, idA, 'mock-claude 已启动');
    await turn(idA, 'Fix login redirect bug');
    await turn(idA, '补充单元测试');
    idB = await createSessionViaForm(app, B, mkWorkDir(app, 'proj-api'));
    await waitOutput(app, idB, 'mock-claude 已启动');
    await turn(idB, 'Refactor api utils');
    await end(idA);
    await end(idB);
    const ra = await recordOf(app, idA);
    expect(ra?.firstPrompt).toBe('Fix login redirect bug');
    expect(ra?.lastPrompt).toBe('补充单元测试');

    await openByHotkey();
    await waitItems([idB, idA], '两条历史，最近结束的在前');
    expect(await app.text('#history-count')).toBe('共 2 条');
    await pick(idA);
    expect(await app.text('#history-first-prompt')).toBe('Fix login redirect bug');
    expect(await app.text('#history-last-prompt')).toBe('补充单元测试');
    expect(await app.text('#history-detail')).toContain('主动结束');
    await app.shot('history-panel');
  });

  it('多词搜索、目录、时间范围与结束状态过滤', async () => {
    await setSearch('LOGIN redirect');
    await waitItems([idA], '两个词都命中 A');
    await setSearch('login api');
    await waitItems([], 'AND 组合没有命中');
    expect(await app.text('#history-list')).toContain('没有符合条件的历史');
    await setSearch('utils');
    await waitItems([idB], '最近一条提示词也参与搜索');
    await setSearch('');
    await setSelect('#history-cwd', cwdA);
    await waitItems([idA], '按目录过滤');
    await setSelect('#history-cwd', '');
    await app.click('#history-range .hist-seg[data-range="today"]');
    await waitItems([idB, idA], '今天的两条');
    await setSelect('#history-kind', 'error');
    await waitItems([], '没有异常退出的');
    await setSelect('#history-kind', '');
    await app.click('#history-range .hist-seg[data-range="all"]');
    await waitItems([idB, idA], '恢复全部');
  });

  it('固定排到最前，存为模板，续接后会话回到列表', async () => {
    await pick(idA);
    await app.click('#history-pin');
    await waitItems([idA, idB], '固定的排在前面');
    expect((await recordOf(app, idA))?.pinned).toBe(true);
    await app.waitFor(`document.querySelector('#history-pin')?.textContent === '取消固定'`, { message: '按钮变为取消固定' });

    await app.click('#history-save-template');
    await app.until(async () => {
      const list = await app.eval<Array<{ name: string; body: string }>>('window.panelApi.templates.list()');
      return list.some(t => t.name === A && t.body === 'Fix login redirect bug') ? true : undefined;
    }, { message: '模板已保存' });

    await pick(idB);
    await app.waitFor(`document.querySelector('#history-resume')?.disabled === false`, { timeout: 15_000, message: '续接可用' });
    await app.click('#history-resume');
    await app.waitHidden('#history-backdrop');
    await app.until(async () => (await app.session(idB)) ? true : undefined, { timeout: 20_000, message: 'B 回到列表' });
    await waitStatus(app, idB, ['running', 'waiting_input', 'completed'], 20_000);
    await end(idB);
  });

  it('删除只删记录；在此目录新建回到首页并预填目录', async () => {
    await openByHotkey();
    await waitItems([idA, idB], '两条历史');
    await pick(idB);
    await app.click('#history-delete');
    await app.waitVisible('#confirm-buttons');
    await clickButton(app, '#confirm-buttons', '删除');
    await waitItems([idA], 'B 被删除');
    expect(await recordOf(app, idB)).toBeNull();
    await app.click('#history-new-here');
    await app.waitHidden('#history-backdrop');
    await app.waitVisible('#main-empty');
    expect(await app.eval<string>(`document.querySelector('#form-cwd').value`)).toBe(cwdA);
  });

  it('命令面板按提示词搜索历史，回车打开详情；导航轨按钮可打开', async () => {
    await app.blur();
    await app.press('Control+K');
    await app.waitVisible('#palette-backdrop');
    expect(await app.eval<boolean>(`[...document.querySelectorAll('#palette-list .pt')].some(x => x.textContent.startsWith('历史：'))`)).toBe(false);
    await app.type('redirect');
    // 同名模板（上一步存的）排在历史分组前面，按方向键移到历史条目
    await app.waitFor(`[...document.querySelectorAll('#palette-list .pt')].some(x => x.textContent === ${q(`历史：${A}`)})`,
      { message: '历史条目出现' });
    for (let i = 0; i < 5; i++) {
      if (await app.text('#palette-list .pal-i.on .pt') === `历史：${A}`) break;
      await app.press('ArrowDown');
    }
    expect(await app.text('#palette-list .pal-i.on .pt')).toBe(`历史：${A}`);
    await app.press('Enter');
    await app.waitHidden('#palette-backdrop');
    await app.waitVisible('#history-backdrop');
    await app.waitFor(`document.querySelector('#history-detail-title')?.textContent === ${q(A)}`, { message: '打开该条详情' });
    await closePanel();
    await app.click('#rail-history');
    await app.waitVisible('#history-backdrop');
    await closePanel();
  });

  it('保留策略按新上限清理，清空可保留固定的；工作区提示跳到清理入口', async () => {
    const now = Date.now();
    const dir = path.join(app.home, 'records');
    const work = app.work;
    await app.restart({
      between: () => {
        for (let i = 0; i < 25; i++) {
          const id = `fake${String(i).padStart(2, '0')}`;
          const t = now - (i + 1) * 3_600_000;
          const r: Record<string, unknown> = {
            version: 1, id, label: `旧会话 ${i}`, cwd: work, createdAt: t - 60_000, updatedAt: t, lastActiveAt: t,
            endedAt: t, state: 'ended', endReason: 'killed', lastStatus: 'completed', claudeSessionIds: [], turns: 1, resumeCount: 0,
          };
          if (i === 0) r.worktree = { repoRoot: work, path: path.join(work, 'wt-gone'), branch: 'nexus/old', baseRef: 'main' };
          fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(r));
        }
      },
    });
    await openByHotkey();
    await app.waitFor(`document.querySelector('#history-count')?.textContent === '共 26 条'`, { message: '共 26 条' });
    await pick('fake00');
    await app.waitVisible('#history-wt-hint');
    await app.click('#history-wt-clean');
    await app.waitHidden('#history-backdrop');
    await app.waitVisible('#palette-backdrop');
    expect(await app.eval<string>(`document.querySelector('#palette-input').value`)).toContain('清理工作区');
    await app.press('Escape');
    await app.waitHidden('#palette-backdrop');

    await openByHotkey();
    await app.click('#history-policy-edit');
    await app.waitVisible('#history-policy-form');
    await app.fill('#history-max-count', '20');
    await app.click('#history-policy-save');
    await app.waitFor(`document.querySelector('#history-count')?.textContent === '共 21 条'`, { message: '按 20 条清理，固定的不计' });
    expect(await app.text('#history-policy')).toContain('保留最近 20 条');
    expect(await recordOf(app, 'fake24')).toBeNull();
    expect((await recordOf(app, idA))?.pinned).toBe(true);

    await app.click('#history-clear');
    await app.waitVisible('#confirm-buttons');
    await clickButton(app, '#confirm-buttons', '清空，保留 1 条固定的');
    await waitItems([idA], '只剩固定的');
    await closePanel();
    expect(await app.exceptions()).toEqual([]);
  });

  it('记录目录不可用时显示降级横幅，新建会话不受影响', async () => {
    const dir = path.join(app.home, 'records');
    await app.restart({
      between: () => {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.writeFileSync(dir, 'blocked');
      },
    });
    await openByHotkey();
    await app.waitVisible('#history-banner');
    expect(await app.text('#history-banner')).toContain('会话历史不可用');
    expect(await app.eval<boolean>(`document.querySelector('#history-search').disabled`)).toBe(true);
    expect(await app.eval<boolean>(`document.querySelector('#history-clear').disabled`)).toBe(true);
    await app.shot('history-degraded');
    await closePanel();
    const id = await createSessionViaForm(app, '降级时新建', mkWorkDir(app, 'proj-degraded'));
    await waitOutput(app, id, 'mock-claude 已启动');
    await app.eval(`window.panelApi.kill(${q(id)})`);
    await app.until(async () => !(await app.session(id)) ? true : undefined, { message: '会话结束' });
    await app.restart({ between: () => { fs.rmSync(dir, { force: true }); } });
    expect(await app.exceptions()).toEqual([]);
  });
});
