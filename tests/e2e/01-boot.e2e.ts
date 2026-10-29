import { describe, it, expect } from 'vitest';
import { useApp } from './harness';

describe('启动与首页', () => {
  const app = useApp();

  it('首页新建表单可见', async () => {
    await app.waitVisible('#main-empty');
    expect(await app.visible('#main-pane')).toBe(false);
    expect(await app.visible('#new-session-form')).toBe(true);
  });

  it('检查更新按钮的悬停提示带当前版本号', async () => {
    const version = await app.waitFor<string>(
      `document.querySelector('#btn-update')?.dataset.version ?? ''`, { message: '#btn-update 带版本号' });
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(await app.eval<string>(`document.querySelector('#btn-update').title`)).toContain(`v${version}`);
  });

  it('日志记录了隔离实例运行', async () => {
    await app.until(() => app.logs().includes('隔离实例运行'), { message: '日志含「隔离实例运行」' });
    expect(app.logs()).toContain(app.home);
  });

  it('会话列表为空', async () => {
    expect(await app.list()).toEqual([]);
    expect(await app.count('[data-session-id]')).toBe(0);
  });
});
