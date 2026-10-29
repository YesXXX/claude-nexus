import { describe, expect, it } from 'vitest';
import { useApp } from './harness';
import { createSessionViaForm, mkWorkDir, runTurn } from './fixtures';

/**
 * CLAUDE_PANEL_USAGE=0 关闭上下文统计：会话不带上下文摘要，属性面板不显示上下文节，
 * 读取设置得到默认值，保存设置返回关闭提示。
 */

const app = useApp({ env: { CLAUDE_PANEL_TRANSCRIPT_ROOT: '{claude}/projects', CLAUDE_PANEL_USAGE: '0' } });

describe('关闭上下文统计', () => {
  it('跑完一轮后界面没有上下文元素', async () => {
    const id = await createSessionViaForm(app, 'off', mkWorkDir(app, 'off'));
    await runTurn(app, id, 'hello');
    await new Promise(r => setTimeout(r, 1200));
    expect((await app.session(id))?.usage).toBeUndefined();
    expect(await app.exists('.usage-sec')).toBe(false);
  });

  it('设置读到默认值，保存返回关闭提示', async () => {
    const s = await app.eval<{ contextWarnPct: number }>('window.panelApi.usage.getSettings()');
    expect(s.contextWarnPct).toBe(80);
    const r = await app.eval<{ ok: boolean; error?: string }>('window.panelApi.usage.setSettings({ contextWarnPct: 70, contextDangerPct: 90, windows: {} })');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('CLAUDE_PANEL_USAGE=0');
    expect(app.logs()).not.toContain('上下文统计已启用');
  });
});
