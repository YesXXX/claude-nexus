import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { q, useApp } from './harness';
import { clickButton, mkWorkDir, rowSel, sendLine, waitOutput, waitStatus } from './fixtures';

/**
 * 首条提示词：新建表单填写多行提示词，Claude 就绪（SessionStart、粘贴模式、输出静默）后以一次粘贴加单独回车发出；
 * 目录信任确认期间不会误按键，确认后才提交；30 秒内没就绪转为未发送，可插入到输入框由用户回车。
 * 另测 panelApi.sendPrompt 的插入与拒绝。mock 把收到的原始输入逐块写进实例临时目录下的记录文件。
 */

const PS = '\x1b[200~';
const PE = '\x1b[201~';

describe('首条提示词', () => {
  const app = useApp({ env: { CLAUDE_PANEL_MOCK_INPUT_LOG: '{root}/mock-input.log' } });
  const inputLog = () => path.join(app.root, 'mock-input.log');
  const inputs = (): string[] => (fs.existsSync(inputLog())
    ? fs.readFileSync(inputLog(), 'utf8').split('\n').filter(Boolean).map(l => (JSON.parse(l) as { data: string }).data)
    : []);
  /** 属性面板状态分区（只在该会话被选中时存在） */
  const statusSel = (id: string): string => `#inspector .status-sec[data-session-id="${id}"]`;
  const promptState = (id: string) => app.eval<string | null>(
    `document.querySelector(${q(`${statusSel(id)} [data-role="prompt-state"]`)})?.dataset.state ?? null`);

  /** 通过表单新建，提示词框里用 Ctrl+Enter 提交，返回新会话 id */
  const createWithPrompt = async (label: string, cwd: string, prompt: string): Promise<string> => {
    const before = new Set((await app.list()).map(s => s.id));
    if (!(await app.visible('#main-empty'))) {
      await app.click('#btn-new');
      await app.waitVisible('#main-empty');
    }
    await app.fill('#form-cwd', cwd);
    await app.fill('#form-label', label);
    await app.focus('#form-prompt');
    await app.eval(`(() => { const t = document.querySelector('#form-prompt'); t.value = ${q(prompt)};
      t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await app.press('Control+Enter');
    const id = await app.until(async () => (await app.list()).find(s => !before.has(s.id) && s.label === label)?.id,
      { timeout: 20_000, message: `新会话「${label}」出现` });
    await app.waitFor(`!!document.querySelector(${q(rowSel(id))})`, { message: '新会话行' });
    return id;
  };

  it('多行提示词在就绪后一次粘贴、单独回车，只提交一次；表单随之清空', async () => {
    const id = await createWithPrompt('首条提示词用例', mkWorkDir(app, 'proj-prompt'), '第一行任务\n第二行说明\n第三行');
    expect(await app.eval<string>(`document.querySelector('#form-prompt').value`)).toBe('');
    await waitOutput(app, id, '收到任务（3 行）："第一行任务"', 20_000);
    await waitStatus(app, id, 'waiting_permission');
    const data = inputs();
    const pi = data.indexOf(`${PS}第一行任务\r第二行说明\r第三行${PE}`);
    expect(pi).toBeGreaterThanOrEqual(0);
    expect(data[pi + 1]).toBe('\r');
    // ConPTY 改尺寸时会重绘整屏，原始输出里同一行可能出现两次，提交次数以输入记录与会话状态为准
    expect(data.filter(d => d.includes('第一行任务'))).toHaveLength(1);
    expect((await app.session(id))?.pendingPrompt).toBeUndefined();
    expect(await promptState(id)).toBeNull();
    await sendLine(app, id, 'y');
    await waitStatus(app, id, 'completed');
    await new Promise(r => setTimeout(r, 1000));
    expect((await app.session(id))?.status).toBe('completed');
    expect(inputs().slice(pi + 1).join('')).toBe('\ry\r');
  });

  it('sendPrompt：不提交只写入输入框，提交时回车；等待审批与参数错误时拒绝并说明原因', async () => {
    const id = await app.until(async () => (await app.list()).find(s => s.label === '首条提示词用例')?.id);
    const r1 = await app.eval<{ ok: boolean }>(`window.panelApi.sendPrompt(${q(id)}, '插入的第一行\\n插入的第二行', false)`);
    expect(r1).toEqual({ ok: true });
    await app.until(() => inputs().includes(`${PS}插入的第一行\r插入的第二行${PE}`), { message: '插入的粘贴块' });
    await new Promise(r => setTimeout(r, 500));
    expect((await app.session(id))?.status).toBe('completed');
    await sendLine(app, id, '');
    await waitOutput(app, id, '收到任务（2 行）："插入的第一行"');
    await waitStatus(app, id, 'waiting_permission');
    const r2 = await app.eval<{ ok: boolean; reason?: string }>(`window.panelApi.sendPrompt(${q(id)}, 'x', true)`);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain('确认权限');
    await sendLine(app, id, 'y');
    await waitStatus(app, id, 'completed');
    const r3 = await app.eval<{ ok: boolean }>(`window.panelApi.sendPrompt(${q(id)}, '单行直接提交', true)`);
    expect(r3).toEqual({ ok: true });
    await waitOutput(app, id, '收到任务："单行直接提交"');
    await sendLine(app, id, 'n');
    await waitStatus(app, id, 'completed');
    const bad = await app.eval<{ ok: boolean; reason?: string }>(`window.panelApi.sendPrompt(${q(id)}, 42, true)`);
    expect(bad).toEqual({ ok: false, reason: '参数无效' });
    const missing = await app.eval<{ ok: boolean; reason?: string }>(`window.panelApi.sendPrompt('no-such-id', 'x', true)`);
    expect(missing).toEqual({ ok: false, reason: '会话不存在' });
  });

  it('目录信任确认：确认前不注入任何按键，确认后才提交首条提示词', async () => {
    for (const s of await app.list()) await app.eval(`window.panelApi.kill(${q(s.id)})`);
    await app.restart({ env: { CLAUDE_PANEL_MOCK_TRUST: '1' } });
    const id = await createWithPrompt('信任确认用例', mkWorkDir(app, 'proj-trust'), '信任后才执行');
    await waitOutput(app, id, 'Do you trust the files in this folder?');
    const before = inputs().length;
    await app.waitFor(`document.querySelector(${q(`${statusSel(id)} [data-role="prompt-state"]`)})?.dataset.state === 'waiting'`,
      { message: '状态分区显示提示词待发送' });
    await new Promise(r => setTimeout(r, 2500));
    expect(inputs().slice(before).filter(d => d.includes('信任后才执行'))).toEqual([]);
    expect(await app.output(id)).not.toContain('收到任务');
    await sendLine(app, id, '');
    await waitOutput(app, id, '收到任务："信任后才执行"', 20_000);
    const after = inputs().slice(before);
    expect(after.filter(d => d === `${PS}信任后才执行${PE}`)).toHaveLength(1);
    expect(after.filter(d => d.includes('信任后才执行'))).toHaveLength(1);
    await app.waitFor(`!document.querySelector(${q(`${statusSel(id)} [data-role="prompt-state"]`)})`, { message: '待发送标记消失' });
    await app.shot('initial-prompt-trust');
  });

  it('30 秒内未就绪：状态分区标红，页头可插入到输入框，用户回车后提交', async () => {
    const id = await createWithPrompt('未就绪用例', mkWorkDir(app, 'proj-timeout'), '超时后插入\n第二行');
    await waitOutput(app, id, 'Do you trust the files in this folder?');
    await app.until(async () => (await app.session(id))?.pendingPrompt?.state === 'failed',
      { timeout: 40_000, message: '首条提示词转为未发送' });
    await app.click(rowSel(id));
    await app.waitFor(`document.querySelector(${q(`${statusSel(id)} [data-role="prompt-state"]`)})?.dataset.state === 'failed'`,
      { message: '状态分区显示提示词未发送' });
    await app.waitVisible('#main-pane [data-role="prompt-pending"]');
    await app.shot('initial-prompt-failed');
    // 先确认信任让输入框就绪，再插入
    await sendLine(app, id, '');
    await waitOutput(app, id, '已信任此目录');
    await app.until(async () => (await app.session(id))?.pasteMode === true, { message: '粘贴模式开启' });
    await app.click('#main-pane [data-role="prompt-pending"]');
    await app.waitVisible('#confirm-buttons');
    await clickButton(app, '#confirm-buttons', '插入到输入框');
    await app.until(() => inputs().includes(`${PS}超时后插入\r第二行${PE}`), { message: '插入的粘贴块' });
    await app.until(async () => !(await app.session(id))?.pendingPrompt, { message: '未发送状态清除' });
    await new Promise(r => setTimeout(r, 300));
    expect(await app.output(id)).not.toContain('收到任务');
    await sendLine(app, id, '');
    await waitOutput(app, id, '收到任务（2 行）："超时后插入"');
    await app.waitHidden('#main-pane [data-role="prompt-pending"]');
    expect(await app.exceptions()).toEqual([]);
  });
});
