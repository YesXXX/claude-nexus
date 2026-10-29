import { describe, it, expect } from 'vitest';
import { useApp, q } from './harness';
import { createSessionViaForm, mkWorkDir, rowSel, waitOutput, writeSubagentTranscript } from './fixtures';

describe('布局与偏好', () => {
  const app = useApp();
  const agentId = 'e2e0lay01';
  const kidSel = `[data-role="child"][data-agent-id="${agentId}"]`;
  let id = '';

  const chev = () => `${rowSel(id)} .chev`;
  const kidVisible = () => app.exists(kidSel);
  const inspectorShown = () => app.visible('#inspector');

  it('带子代理的父会话显示折叠按钮', async () => {
    id = await createSessionViaForm(app, '布局用例', mkWorkDir(app, 'proj-layout'));
    await waitOutput(app, id, 'mock-claude 已启动');
    const transcript = writeSubagentTranscript(app, agentId, [{ type: 'user', message: { role: 'user', content: '布局子任务' } }]);
    expect(await app.postHook(id, {
      hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'general-purpose', agent_transcript_path: transcript,
    })).toBe(200);
    await app.waitFor(`!!document.querySelector(${q(kidSel)})`, { message: '子代理行出现' });
    expect(await app.eval(`document.querySelector(${q(chev())})?.getAttribute('aria-expanded')`)).toBe('true');
  });

  it('折叠后隐藏子代理行，重载页面后保持折叠', async () => {
    await app.click(chev());
    await app.waitFor(`!document.querySelector(${q(kidSel)})`, { message: '折叠后子代理行隐藏' });
    expect(await app.eval(`document.querySelector(${q(chev())}).classList.contains('collapsed')`)).toBe(true);
    expect(await app.eval(`JSON.parse(localStorage.getItem('panel.collapsedSessions') ?? '[]')`)).toEqual([id]);

    await app.reload();
    await app.waitFor(`!!document.querySelector(${q(chev())})`, { message: '重载后父会话行出现' });
    expect(await kidVisible()).toBe(false);
    expect(await app.eval(`document.querySelector(${q(chev())}).getAttribute('aria-expanded')`)).toBe('false');
  });

  it('展开后子代理行恢复，重载页面后保持展开', async () => {
    await app.click(chev());
    await app.waitFor(`!!document.querySelector(${q(kidSel)})`, { message: '展开后子代理行出现' });
    await app.reload();
    await app.waitFor(`!!document.querySelector(${q(kidSel)})`, { message: '重载后子代理行仍在' });
    expect(await app.eval(`document.querySelector(${q(chev())}).getAttribute('aria-expanded')`)).toBe('true');
  });

  it('属性面板按钮切换显隐，重载页面后保持', async () => {
    expect(await inspectorShown()).toBe(true);
    expect(await app.eval(`document.querySelector('#btn-inspector').classList.contains('on')`)).toBe(true);

    await app.click('#btn-inspector');
    await app.waitHidden('#inspector');
    expect(await app.eval(`document.querySelector('#app').classList.contains('no-inspector')`)).toBe(true);
    expect(await app.eval(`document.querySelector('#btn-inspector').classList.contains('on')`)).toBe(false);

    await app.reload();
    expect(await inspectorShown()).toBe(false);
    await app.click('#btn-inspector');
    await app.waitVisible('#inspector');
    expect(await app.eval(`document.querySelector('#app').classList.contains('no-inspector')`)).toBe(false);
  });

  it('属性面板不再显示快捷键区', async () => {
    const titles = await app.eval<string[]>(
      `[...document.querySelectorAll('#inspector section h4')].map(h => (h.textContent ?? '').trim())`);
    expect(titles).not.toContain('快捷键');
  });

  it('会话行只显示状态图标与会话名，属性面板只显示有内容的分区，属性与对话默认折叠', async () => {
    await app.click(rowSel(id));
    const row = await app.eval<{ title: string; extra: number; hint: string }>(`(() => {
      const r = document.querySelector(${q(rowSel(id))});
      return {
        title: r.querySelector('.t').textContent,
        extra: r.querySelectorAll('.meta, .tm, .proj, .num, .wt-mark, .tagx').length,
        hint: r.title,
      };
    })()`);
    expect(row).toEqual({ title: '布局用例', extra: 0, hint: expect.stringContaining('proj-layout') });
    expect(await app.text(`${kidSel} .t`)).toContain('布局子任务');
    expect(await app.count(`${kidSel} .tagx, ${kidSel} .tm`)).toBe(0);

    // 刚建的会话：没有验证配置、改动与上下文数据，这几节不占位；子代理节因有子代理而显示
    await app.waitFor(`!!document.querySelector('#inspector .props-sec') && !!document.querySelector('#inspector .conv-sec')`, { message: '属性与对话分区出现' });
    const titles = await app.eval<string[]>(
      `[...document.querySelectorAll('#inspector > .sec')].map(s => ((s.querySelector(':scope > h4, :scope > summary')?.firstChild?.textContent) ?? '').trim())`);
    expect(titles[0]).toBe('状态');
    for (const t of ['自动验证', '改动', '上下文']) expect(titles.some(x => x.startsWith(t))).toBe(false);
    const at = (t: string): number => titles.findIndex(x => x.startsWith(t));
    const order = ['状态', '子代理', '属性', '对话'].map(at);
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(await app.eval<boolean[]>(`[...document.querySelectorAll('#inspector details.fold')].map(d => d.open)`)).toEqual([false, false]);
    // 展开状态记住：重绘后仍展开
    await app.click('#inspector .props-sec > summary');
    await app.waitFor(`document.querySelector('#inspector .props-sec')?.open === true`, { message: '属性展开' });
    await app.click(rowSel(id));
    await app.waitFor(`document.querySelector('#inspector .props-sec')?.open === true`, { message: '重绘后属性仍展开' });
    await app.click('#inspector .props-sec > summary');
    expect(await app.eval<string>(`document.querySelector('#inspector .status-sec .st-now').title`)).toContain('已持续');
    await app.shot('inspector-order');
    // 回到首页，后面的用例依靠「选中会话即离开设置页」
    await app.click('#btn-new');
    await app.waitVisible('#main-empty');
  });

  it('设置页快捷键分节列出全部热键', async () => {
    await app.click('#rail-settings');
    await app.waitVisible('#settings-page');
    expect(await app.eval(`document.querySelector('#rail-settings').classList.contains('on')`)).toBe(true);
    const pairs = await app.eval<string[][]>(`[...document.querySelectorAll('#settings-keys .set-key-row')]
      .map(r => [(r.querySelector('.set-key-label')?.textContent ?? '').trim(), r.dataset.keys ?? ''])`);
    expect(pairs).toEqual([
      ['新建会话', 'Ctrl N'],
      ['命令面板', 'Ctrl K'],
      ['命令面板（终端内）', 'Ctrl ⇧ K'],
      ['插入模板', 'Ctrl ⇧ T'],
      ['会话历史', 'Ctrl ⇧ H'],
      ['活动时间线', 'Ctrl ⇧ L'],
      ['设置', 'Ctrl ,'],
      ['切换会话', 'Ctrl 1~9'],
      ['上下切换', 'J K'],
      ['审批', 'Y N A'],
      ['聚焦待处理', 'Alt ⇧ C'],
      ['返回父会话', 'Esc'],
      ['终端 / 改动', 'Ctrl ⇧ D'],
      ['改动：统一 / 分栏', 'V'],
      ['改动：自动换行', 'W'],
      ['改动：专注审阅（Esc 退出）', 'F'],
      ['改动：收起 / 展开文件列表', 'B'],
      ['改动：忽略空白差异', 'I'],
      ['改动：搜索文件', '/'],
      ['终端 / 收尾', 'Ctrl ⇧ F'],
      ['窗格：最大化 / 还原', 'Ctrl ⇧ M'],
      ['窗格：移动焦点', 'Ctrl Alt ←↑↓→'],
      ['终端搜索', 'Ctrl F'],
      ['终端搜索（Ctrl+F 交给终端时）', 'Ctrl Alt F'],
      ['搜索：下一个 / 上一个', 'F3 ⇧ F3'],
    ]);
    await app.shot('settings-page');
    await app.click('#settings-back');
    await app.waitHidden('#settings-page');
    expect(await app.eval(`document.querySelector('#rail-settings').classList.contains('on')`)).toBe(false);
  });

  it('设置页分节导航与 Ctrl+, / Esc 开关', async () => {
    await app.blur();
    await app.press('Control+Comma');
    await app.waitVisible('#settings-page');
    const nav = await app.eval<string[]>(`[...document.querySelectorAll('#settings-nav .set-nav-i')].map(b => b.textContent.trim())`);
    expect(nav).toEqual(['外观', '会话续接', '会话历史', '会话预设', '改动与 diff', '每轮自动验证', '上下文', '远程通知', '快捷键', '版本与更新']);
    expect(await app.text('#settings-nav .set-nav-i.on')).toBe('外观');

    // 点导航滚到对应分节，高亮随之切换
    await app.click('#settings-nav .set-nav-i[data-key="settings-version"]');
    await app.waitFor(`document.querySelector('#settings-nav .set-nav-i.on')?.dataset.key === 'settings-version'`,
      { message: '导航高亮切到版本与更新' });
    await app.waitFor(`(() => { const c = document.querySelector('#settings-content');
      const s = document.querySelector('#settings-sec-settings-version');
      return Math.abs(c.scrollTop - s.offsetTop) < 4; })()`, { message: '内容滚到版本与更新' });
    await app.waitFor(`/^v\\d/.test(document.querySelector('#settings-version')?.textContent ?? '')`, { message: '显示当前版本' });

    // 设置页打开时单键热键不作用于背后的会话
    await app.focus('#settings-back');
    await app.press('j');
    expect(await app.visible('#settings-page')).toBe(true);

    await app.press('Escape');
    await app.waitHidden('#settings-page');
    await app.blur();
    await app.press('Control+Comma');
    await app.waitVisible('#settings-page');
    await app.press('Control+Comma');
    await app.waitHidden('#settings-page');
  });

  it('设置页修改即时生效：diff 视图与续接设置', async () => {
    await app.click('#rail-settings');
    await app.waitVisible('#settings-page');
    await app.click('#settings-diff-view .set-seg-b[data-value="split"]');
    expect(await app.eval(`localStorage.getItem('nexus.diff.view')`)).toBe('split');
    await app.click('#settings-diff-view .set-seg-b[data-value="unified"]');
    expect(await app.eval(`localStorage.getItem('nexus.diff.view')`)).toBe('unified');

    await app.waitFor(`!document.querySelector('#settings-on-quit .set-seg-b').disabled`, { message: '续接设置读取完成' });
    await app.click('#settings-on-quit .set-seg-b[data-value="end"]');
    await app.until(async () => (await app.eval<{ onQuit: string }>('window.panelApi.resumeSettingsGet()')).onQuit === 'end',
      { message: '退出策略已保存' });
    await app.click('#settings-on-quit .set-seg-b[data-value="ask"]');
    await app.until(async () => (await app.eval<{ onQuit: string }>('window.panelApi.resumeSettingsGet()')).onQuit === 'ask',
      { message: '退出策略已恢复' });

    // 选中会话即离开设置页
    await app.click(rowSel(id));
    await app.waitHidden('#settings-page');
    expect(await app.exceptions()).toEqual([]);
  });
});
