import { describe, it, expect } from 'vitest';
import { useApp } from './harness';
import { createSessionViaForm, isRowSelected, mkWorkDir, rowSel, selectedSessionId, waitOutput, waitStatus } from './fixtures';

describe('事件驱动的状态与收件箱', () => {
  const app = useApp();
  const ids: Record<'wait' | 'done' | 'run', string> = { wait: '', done: '', run: '' };

  /** 过滤片上的计数：标签 → 数字 */
  const filterCounts = () => app.eval<Record<string, number>>(`Object.fromEntries(
    [...document.querySelectorAll('#sidebar-filters button')].map(b => {
      const n = b.querySelector('.n');
      const label = (b.textContent ?? '').replace(n?.textContent ?? '', '').trim();
      return [label, Number(n?.textContent ?? NaN)];
    }))`);

  /** 分组头：分组键 → 计数，按显示顺序拼接 */
  const groupCounts = () => app.eval<string>(`[...document.querySelectorAll('#session-list .gh')]
    .map(g => g.dataset.group + ':' + g.querySelector('.c').textContent).join('|')`);

  it('新建三个会话，初始均为运行中', async () => {
    ids.wait = await createSessionViaForm(app, '等输入', mkWorkDir(app, 'hook-wait'));
    ids.done = await createSessionViaForm(app, '已完成', mkWorkDir(app, 'hook-done'));
    ids.run = await createSessionViaForm(app, '仍运行', mkWorkDir(app, 'hook-run'));
    for (const id of Object.values(ids)) await waitOutput(app, id, 'mock-claude 已启动');
    expect((await app.list()).map(s => s.status)).toEqual(['running', 'running', 'running']);
    expect(await app.visible('#inbox-badge')).toBe(false);
  });

  it('POST Notification 与 Stop 后状态、收件箱角标与过滤计数正确', async () => {
    expect(await app.postHook(ids.wait, { hook_event_name: 'Notification', message: 'Claude is waiting for your input' })).toBe(200);
    expect(await app.postHook(ids.done, { hook_event_name: 'Stop' })).toBe(200);
    await waitStatus(app, ids.wait, 'waiting_input');
    await waitStatus(app, ids.done, 'completed');
    expect((await app.session(ids.run))?.status).toBe('running');

    await app.waitVisible('#inbox-badge');
    await app.waitFor(`document.querySelector('#inbox-badge')?.textContent === '1'`, { message: '收件箱角标为 1' });
    // 会话不足 9 个时筛选条不常驻，分组头带计数
    expect(await app.visible('#sidebar-filters')).toBe(false);
    await app.until(async () => (await groupCounts()) === 'input:1|running:1|done:1',
      { message: '分组计数 等待输入1 运行中1 已完成1' });
  });

  it('命令面板筛选待处理：筛选条出现并只显示等待输入的会话，再点取消', async () => {
    await app.blur();
    await app.press('Control+K');
    await app.waitVisible('#palette-backdrop');
    await app.fill('#palette-input', '筛选：待处理');
    await app.waitFor(`document.querySelector('#palette-list .pal-i.on .pt')?.textContent === '筛选：待处理'`, { message: '面板有筛选命令' });
    await app.press('Enter');
    await app.waitFor(`document.querySelectorAll('[data-role="parent"]').length === 1`, { message: '过滤后只剩一行' });
    expect(await app.exists(rowSel(ids.wait))).toBe(true);
    // 筛选生效时筛选条出现，计数为 0 的筛选片不显示
    await app.waitVisible('#sidebar-filters');
    await app.until(async () => {
      const c = await filterCounts();
      return c['全部'] === 3 && c['待处理'] === 1 && c['运行中'] === 1 && c['已完成'] === 1;
    }, { message: '过滤计数 全部3 待处理1 运行中1 已完成1' });
    // 再点一次取消过滤，筛选条随之收起
    await app.eval(`[...document.querySelectorAll('#sidebar-filters button')].find(b => b.textContent.includes('待处理')).click()`);
    await app.waitFor(`document.querySelectorAll('[data-role="parent"]').length === 3`, { message: '取消过滤后三行' });
    await app.waitHidden('#sidebar-filters');
  });

  it('点击收件箱按钮跳到等待输入的会话', async () => {
    await app.click(rowSel(ids.run));
    await app.until(async () => (await selectedSessionId(app)) === ids.run, { message: '先选中运行中的会话' });
    await app.click('#btn-inbox');
    await app.until(async () => (await selectedSessionId(app)) === ids.wait, { message: '跳到等待输入的会话' });
    expect(await isRowSelected(app, ids.wait)).toBe(true);
    await app.waitFor(`(document.querySelector('#pane-label')?.textContent ?? '').trim() === '等输入'`,
      { message: '#pane-label 为等输入' });
  });

  it('等待中的会话收到 Stop 后角标消失', async () => {
    expect(await app.postHook(ids.wait, { hook_event_name: 'Stop' })).toBe(200);
    await waitStatus(app, ids.wait, 'completed');
    await app.waitHidden('#inbox-badge');
  });
});
