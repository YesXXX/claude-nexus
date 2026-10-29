import { describe, expect, it } from 'vitest';
import { q, useApp } from './harness';
import {
  createSessionViaForm, mkWorkDir, runTurn, sendLine, terminalFocusedExpr, waitOutput, waitStatus, writeSubagentTranscript,
} from './fixtures';

/**
 * 终端内搜索：Ctrl+F 在终端卡片右上角打开搜索框，显示「当前/总数」，无结果与正则无效时标红；
 * Enter / Shift+Enter / F3 在匹配间跳转；Esc 关闭并把焦点还给终端；子代理只读终端同样可搜。
 */

describe('终端内搜索', () => {
  const app = useApp();
  let id = '';
  const box = '#main-pane .tsearch';
  const count = () => app.text(`${box} .tsearch-count`);
  const isBad = () => app.eval<boolean>(`document.querySelector(${q(box)})?.classList.contains('bad') === true`);
  const typeQuery = async (text: string, scope = box) => {
    await app.fill(`${scope} .tsearch-input`, text);
  };
  const countParts = async (scope = box): Promise<[number, number]> => {
    const t = await app.until(async () => {
      const s = await app.text(`${scope} .tsearch-count`);
      return /^\d+\/\d+$/.test(s) ? s : '';
    }, { message: '计数显示为 当前/总数' });
    const [a, b] = t.split('/').map(Number);
    return [a, b];
  };

  it('vendor 中带有搜索插件', async () => {
    expect(await app.eval<boolean>(`typeof window.SearchAddon === 'function'`)).toBe(true);
  });

  it('Ctrl+F 打开搜索框，输入后显示当前/总数', async () => {
    id = await createSessionViaForm(app, '搜索用例', mkWorkDir(app, 'proj-search'));
    await waitOutput(app, id, 'mock-claude 已启动');
    await runTurn(app, id, 'zebra-alpha');
    await runTurn(app, id, 'zebra-beta');
    await app.focus('#terminal-host .xterm-helper-textarea');
    await app.waitFor(terminalFocusedExpr(), { message: '终端获得焦点' });
    await app.press('Control+F');
    await app.waitVisible(box);
    await app.waitFor(`document.activeElement?.classList.contains('tsearch-input') === true`, { message: '焦点在搜索框' });
    await app.type('zebra');
    const [cur, total] = await countParts();
    expect(total).toBeGreaterThanOrEqual(4);
    expect(cur).toBeGreaterThanOrEqual(1);
    expect(await isBad()).toBe(false);
    await app.shot('term-search-open');
  });

  it('Enter / Shift+Enter / F3 在匹配间跳转', async () => {
    const [a] = await countParts();
    await app.press('Enter');
    await app.until(async () => (await countParts())[0] !== a, { message: 'Enter 跳到下一个' });
    const [b] = await countParts();
    await app.press('Shift+Enter');
    await app.until(async () => (await countParts())[0] === a, { message: 'Shift+Enter 回到上一个' });
    await app.press('F3');
    await app.until(async () => (await countParts())[0] === b, { message: 'F3 跳到下一个' });
    await app.press('Shift+F3');
    await app.until(async () => (await countParts())[0] === a, { message: 'Shift+F3 回到上一个' });
  });

  it('权限栏出现导致终端改变行数后，跳转从当前匹配继续', async () => {
    await app.press('Enter');
    await app.press('Enter');
    const [i] = await countParts();
    await sendLine(app, id, 'zebra-gamma');
    await waitStatus(app, id, 'waiting_permission');
    await app.waitVisible('#permission-bar');
    await app.until(async () => (await countParts())[1] >= 10, { message: '新输出的匹配计入总数' });
    await new Promise(r => setTimeout(r, 400));
    expect((await countParts())[0]).toBe(i);
    await app.focus(`${box} .tsearch-input`);
    await app.press('Enter');
    await app.until(async () => (await countParts())[0] === i + 1, { message: '跳到原匹配的下一个' });
    await sendLine(app, id, 'y');
    await waitStatus(app, id, 'completed');
  });

  it('区分大小写与全词开关生效，无结果时标红', async () => {
    await typeQuery('ZEBRA');
    await countParts();
    await app.click(`${box} .tsearch-case`);
    expect(await app.eval(`document.querySelector('${box} .tsearch-case').getAttribute('aria-pressed')`)).toBe('true');
    await app.until(async () => (await count()) === '无结果', { message: '区分大小写后无结果' });
    expect(await isBad()).toBe(true);
    await app.click(`${box} .tsearch-case`);
    await countParts();
    expect(await isBad()).toBe(false);
    await typeQuery('zebr');
    await countParts();
    await app.click(`${box} .tsearch-word`);
    await app.until(async () => (await count()) === '无结果', { message: '全词匹配后无结果' });
    await app.click(`${box} .tsearch-word`);
    await countParts();
  });

  it('正则模式：合法表达式可搜，语法错误提示正则无效', async () => {
    await app.click(`${box} .tsearch-regex`);
    await typeQuery('zebra-(alpha|beta)');
    const [, total] = await countParts();
    expect(total).toBeGreaterThanOrEqual(2);
    await typeQuery('zebra-(');
    await app.until(async () => (await count()) === '正则无效', { message: '提示正则无效' });
    expect(await isBad()).toBe(true);
    await app.shot('term-search-bad-regex');
    await app.click(`${box} .tsearch-regex`);
    // 关掉正则后按字面搜「zebra-(」，终端里没有这段文本
    await app.until(async () => (await count()) === '无结果', { message: '按字面搜索无结果' });
  });

  it('Esc 关闭搜索框，焦点回到终端；再次打开保留上次查询', async () => {
    await app.focus(`${box} .tsearch-input`);
    await app.press('Escape');
    await app.waitHidden(box);
    await app.waitFor(terminalFocusedExpr(), { message: '焦点回到终端' });
    expect(await app.visible('#main-pane')).toBe(true);
    await app.press('Control+F');
    await app.waitVisible(box);
    expect(await app.eval<string>(`document.querySelector('${box} .tsearch-input').value`)).toBe('zebra-(');
    await app.press('Escape');
    await app.waitHidden(box);
  });

  it('子代理只读终端同样可以搜索', async () => {
    const agentId = 'e2e0search';
    const transcript = writeSubagentTranscript(app, agentId, [
      { type: 'user', message: { role: 'user', content: '子代理搜索任务' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'needle-one needle-two' }] } },
    ]);
    await app.postHook(id, {
      hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'Explore', agent_transcript_path: transcript,
    });
    const kid = `[data-role="child"][data-agent-id="${agentId}"]`;
    await app.waitFor(`!!document.querySelector(${q(kid)})`, { message: '子代理行出现' });
    await app.click(kid);
    await app.waitVisible('#subagent-pane');
    await app.until(async () => (await app.text('#subagent-pane .xterm-rows')).includes('needle-two'), { message: '子代理输出' });
    await app.focus('#subagent-terminal-host .xterm-helper-textarea');
    await app.press('Control+F');
    const sbox = '#subagent-pane .tsearch';
    await app.waitVisible(sbox);
    expect(await app.visible(box)).toBe(false);
    await typeQuery('needle', sbox);
    const [, total] = await countParts(sbox);
    expect(total).toBe(2);
    await app.press('Escape');
    await app.waitHidden(sbox);
    expect(await app.visible('#subagent-pane')).toBe(true);
  });

  it('Ctrl+Alt+F 作为备用键同样打开', async () => {
    await app.blur();
    await app.press('Escape');
    await app.waitVisible('#main-pane');
    await app.focus('#terminal-host .xterm-helper-textarea');
    await app.press('Control+Alt+F');
    await app.waitVisible(box);
    await app.press('Escape');
    await app.waitHidden(box);
    expect(await app.exceptions()).toEqual([]);
  });
});
