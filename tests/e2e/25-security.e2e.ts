import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { useApp } from './harness';
import { createSessionViaForm, mkWorkDir, waitOutput } from './fixtures';

/**
 * 安全防护：
 * - 页面里点到的外部链接（验证输出里的 OSC 8 超链接会被渲染成 <a>）不会把主窗口导航走，改由系统浏览器打开；
 * - window.open 一律拒绝；内联脚本被内容安全策略拦下；
 * - hook 上报缺令牌或类型不对时被拒绝，不会伪造出会话状态。
 */
describe('安全防护', () => {
  const app = useApp({ env: { CLAUDE_PANEL_OPEN_EXTERNAL_LOG: '{root}/open-external.jsonl' } });
  const opened = (): string[] => {
    const f = path.join(app.root, 'open-external.jsonl');
    return fs.existsSync(f)
      ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => (JSON.parse(l) as { url: string }).url)
      : [];
  };

  it('点击输出里的外部链接：窗口留在面板页面，链接交给系统浏览器', async () => {
    const before = await app.eval<string>('location.href');
    // 与验证输出弹窗相同的渲染方式：ansi_up 把 OSC 8 超链接转成 <a href>
    await app.eval(`(() => {
      const au = new window.AnsiUp();
      au.escape_html = true;
      const pre = document.createElement('pre');
      pre.id = 'e2e-osc8';
      pre.style.cssText = 'position:fixed;left:40%;top:40%;z-index:99999;background:#000;padding:8px';
      pre.innerHTML = au.ansi_to_html('FAIL see \\x1b]8;;https://example.com/osc8\\x07docs\\x1b]8;;\\x07');
      document.body.appendChild(pre);
    })()`);
    expect(await app.exists('#e2e-osc8 a[href="https://example.com/osc8"]')).toBe(true);
    await app.click('#e2e-osc8 a');
    await app.until(() => opened().includes('https://example.com/osc8'), { message: '外部链接交给系统浏览器' });
    expect(await app.eval<string>('location.href')).toBe(before);
    expect(await app.exists('#app')).toBe(true);
    expect(app.logs()).toContain('拦截窗口内导航');
    await app.eval(`document.getElementById('e2e-osc8')?.remove()`);
  });

  it('window.open 被拒绝，网页地址同样交给系统浏览器', async () => {
    const win = await app.eval<boolean>(`window.open('https://example.com/popup') === null`);
    expect(win).toBe(true);
    await app.until(() => opened().includes('https://example.com/popup'), { message: '新窗口链接交给系统浏览器' });
  });

  it('内容安全策略禁止内联脚本', async () => {
    expect(await app.exists('meta[http-equiv="Content-Security-Policy"]')).toBe(true);
    const ran = await app.eval<boolean>(`(() => {
      const s = document.createElement('script');
      s.textContent = 'window.__e2eInline = true';
      document.body.appendChild(s);
      s.remove();
      return window.__e2eInline === true;
    })()`);
    expect(ran).toBe(false);
  });

  it('hook 上报缺令牌或 Content-Type 不对被拒绝，会话状态不变', async () => {
    const id = await createSessionViaForm(app, '安全用例', mkWorkDir(app, 'proj-sec'));
    await waitOutput(app, id, 'mock-claude 已启动');
    const status = (await app.session(id))?.status;
    const forged = { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', tool_name: 'Bash' };
    expect(await app.postHook(id, forged, { token: null })).toBe(401);
    expect(await app.postHook(id, forged, { token: 'f'.repeat(48) })).toBe(401);
    expect(await app.postHook(id, forged, { contentType: 'text/plain' })).toBe(415);
    await new Promise(r => setTimeout(r, 500));
    expect((await app.session(id))?.status).toBe(status);
    expect(app.logs()).toContain('令牌缺失或不匹配');
    expect(await app.exceptions()).toEqual([]);
  });
});
