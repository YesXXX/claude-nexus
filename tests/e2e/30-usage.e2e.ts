import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { q, useApp } from './harness';
import { createSessionViaForm, mkWorkDir, rowSel, runTurn } from './fixtures';

/**
 * 上下文：mock 在显式指定的 transcript 根目录下写带用量的对话记录，
 * 断言属性面板「上下文」节、窗口覆盖、上下文告警与上下文设置；界面上不出现任何金额。
 * 每轮 opus-5 的上下文为 121000，即 1M 窗口的 12%；未知模型按默认 200k 窗口即 61%。
 */

const app = useApp({ env: { CLAUDE_PANEL_TRANSCRIPT_ROOT: '{claude}/projects' } });

interface Usage {
  state: string;
  context?: { pct: number; level: string; used: number; window: number; windowSource: string };
}

async function usageOf(id: string): Promise<Usage | undefined> {
  return (await app.session(id))?.usage as Usage | undefined;
}

/** 等主进程统计到满足条件的上下文，返回该摘要 */
async function waitUsage(id: string, pred: (u: Usage) => boolean, message: string): Promise<Usage> {
  return app.until(async () => {
    const u = await usageOf(id);
    return u && pred(u) ? u : undefined;
  }, { timeout: 15_000, message });
}

async function newSession(label: string, task: string): Promise<string> {
  const id = await createSessionViaForm(app, label, mkWorkDir(app, label));
  await runTurn(app, id, task);
  return id;
}

async function selectRow(id: string): Promise<void> {
  await app.click(rowSel(id));
  await app.waitFor(`document.querySelector('.usage-sec')?.dataset.sessionId === ${q(id)}`, { message: `上下文节切到 ${id}` });
}

describe('上下文', () => {
  let a = '';
  let b = '';
  let c = '';

  it('一轮后属性面板显示上下文占用，摘要与界面都不含金额', async () => {
    a = await newSession('usage-a', 'hello');
    const u = await waitUsage(a, x => x.state === 'ok' && !!x.context, 'A 的上下文统计完成');
    expect(u.context).toMatchObject({ used: 121_000, window: 1_000_000, pct: 12, level: 'ok' });
    expect(Object.keys(u).sort()).toEqual(['context', 'state', 'updatedAt']);
    const root = path.join(app.claude, 'projects');
    expect(fs.readdirSync(root).length).toBeGreaterThan(0);
    await selectRow(a);
    await app.waitFor(`(document.querySelector('.usage-sec')?.textContent ?? '').includes('121,000 / 1,000,000（12%）')`,
      { message: '上下文节显示已用与窗口' });
    expect(await app.eval(`document.querySelector('.usage-sec .uc-fill').style.width`)).toBe('12%');
    expect(await app.text('.usage-sec h4')).toContain('上下文');
    expect(await app.text('#inspector')).not.toMatch(/\$\d|\$\?/);
    expect(await app.exists(`${rowSel(a)} .usage-metric`)).toBe(false);
    await app.eval(`document.querySelector('.usage-sec').scrollIntoView({ block: 'start' })`);
    await app.shot('属性面板-上下文节');
  });

  it('第二轮上下文取最近一条，不累加', async () => {
    await runTurn(app, a, 'again');
    await new Promise(r => setTimeout(r, 500));
    const u = await waitUsage(a, x => !!x.context, 'A 的上下文');
    expect(u.context?.pct).toBe(12);
  });

  it('上下文越过提醒阈值时占用条变黄，并发出上下文告警', async () => {
    b = await newSession('usage-b', 'big task');
    const u = await waitUsage(b, x => x.state === 'ok' && (x.context?.pct ?? 0) > 50, 'B 的上下文统计完成');
    expect(u.context).toMatchObject({ pct: 85, level: 'warn' });
    await selectRow(b);
    await app.waitFor(`document.querySelector('.usage-sec .uc')?.classList.contains('lv-warn') === true`, { message: 'B 的占用条为黄色' });
    expect(await app.text('.usage-sec')).toContain('窗口来源：');
    await app.until(() => app.logs().includes('「usage-b」上下文已用 85%'), { message: '上下文告警写入日志' });
  });

  it('未知模型按默认 200k 窗口；在上下文设置里填窗口覆盖后无需新回合立即重算', async () => {
    c = await newSession('usage-c', 'unknown model');
    const u = await waitUsage(c, x => x.state === 'ok' && !!x.context, 'C 的上下文统计完成');
    expect(u.context).toMatchObject({ window: 200_000, pct: 61, windowSource: 'default' });
    await selectRow(c);
    await app.click('.usage-sec .usage-hbtn');
    await app.waitVisible('#usage-settings-backdrop');
    expect(await app.text('#usage-settings-backdrop')).not.toMatch(/预算|单价|USD/);
    await app.click('#usage-settings-backdrop .us-add');
    await app.eval(`(() => {
      const rows = [...document.querySelectorAll('#us-windows .us-window:not(.us-head)')];
      rows[rows.length - 1].dataset.e2e = 'target'; return true; })()`);
    await app.fill('[data-e2e="target"] .us-key', 'mock-unknown-*');
    await app.fill('[data-e2e="target"] input:not(.us-key)', '1000000');
    await app.shot('上下文设置-窗口覆盖');
    await app.click('#us-save');
    await app.waitHidden('#usage-settings-backdrop');
    const after = await waitUsage(c, x => x.context?.windowSource === 'setting', 'C 按窗口覆盖重算');
    expect(after.context).toMatchObject({ window: 1_000_000, pct: 12 });
    await app.waitFor(`(document.querySelector('.usage-sec')?.textContent ?? '').includes('（12%）')`, { message: '上下文节按新窗口显示' });
    const saved = await app.eval<{ windows: Record<string, number> }>('window.panelApi.usage.getSettings()');
    expect(saved.windows).toEqual({ 'mock-unknown-*': 1_000_000 });
  });

  it('子代理不影响主线程的上下文占用', async () => {
    const d = await newSession('usage-d', 'sub task');
    const u = await waitUsage(d, x => x.state === 'ok' && !!x.context, 'D 的上下文统计完成');
    expect(u.context?.pct).toBe(12);
  });

  it('未选中会话时属性面板不显示用量或金额', async () => {
    await app.click('#btn-new');
    await app.waitVisible('#main-empty');
    expect(await app.exists('.usage-today')).toBe(false);
    expect(await app.exists('.usage-sec')).toBe(false);
    expect(await app.text('#inspector')).not.toMatch(/\$\d|\$\?|今日/);
  });

  it('上下文设置拒绝非法输入且不保存，命令面板可打开设置', async () => {
    await app.blur();
    await app.press('Control+K');
    await app.waitVisible('#palette-backdrop');
    await app.type('上下文设置');
    await app.waitFor(`(document.querySelector('#palette-list .pal-i')?.textContent ?? '').includes('上下文设置')`, { message: '命令面板首项为上下文设置' });
    await app.press('Enter');
    await app.waitVisible('#usage-settings-backdrop');
    await app.waitFor(`document.activeElement?.id === 'us-warn'`, { message: '黄档输入框获得焦点' });
    await app.fill('#us-warn', '96');
    await app.click('#us-save');
    await app.waitFor(`(document.querySelector('#us-error')?.textContent ?? '').length > 0`, { message: '显示错误' });
    expect(await app.text('#us-error')).toContain('上下文黄档必须小于红档');
    expect(await app.visible('#usage-settings-backdrop')).toBe(true);
    await app.press('Escape');
    await app.waitHidden('#usage-settings-backdrop');
    const s = await app.eval<{ contextWarnPct: number }>('window.panelApi.usage.getSettings()');
    expect(s.contextWarnPct).toBe(80);
  });
});
