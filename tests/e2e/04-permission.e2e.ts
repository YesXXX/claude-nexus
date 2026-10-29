import { describe, it, expect } from 'vitest';
import { useApp } from './harness';
import { createSessionViaForm, mkWorkDir, recordStatuses, terminalFocusedExpr, waitOutput, waitStatus } from './fixtures';

describe('审批', () => {
  const app = useApp();
  let id = '';
  let statuses: () => Promise<string[]>;

  it('提交任务后进入等待权限并显示审批条', async () => {
    id = await createSessionViaForm(app, '审批用例', mkWorkDir(app, 'proj-perm'));
    await waitOutput(app, id, 'mock-claude 已启动');
    await app.waitFor(terminalFocusedExpr(), { message: '终端获得焦点' });
    await app.type('perm-e2e');
    await app.press('Enter');
    const s = await waitStatus(app, id, 'waiting_permission');
    expect((s.pendingAction as { toolName?: string } | undefined)?.toolName).toBe('Bash');
    await app.waitVisible('#permission-bar');
    expect(await app.text('#permission-bar')).toContain('Bash');
    expect(await app.text('#permission-bar')).toContain('echo perm-e2e');
  });

  it('按 Y 允许后依次进入运行中与已完成', async () => {
    statuses = await recordStatuses(app, id);
    // 焦点在终端时 Y 由面板拦截发出审批，不会作为字符进入终端
    await app.waitFor(terminalFocusedExpr(), { message: '终端获得焦点' });
    await app.press('y');
    await waitStatus(app, id, 'completed');
    const seen = await statuses();
    expect(seen).toContain('running');
    expect(seen.indexOf('running')).toBeLessThan(seen.lastIndexOf('completed'));
    await app.waitHidden('#permission-bar');
  });

  it('终端缓冲含执行的命令与回合结束提示', async () => {
    const out = await waitOutput(app, id, '回合结束');
    expect(out).toContain('$ echo perm-e2e');
  });

  it('通知只写日志，未弹出系统通知', async () => {
    const prefix = '通知仅记录（未弹出系统通知）：';
    await app.until(() => app.logs().includes(`${prefix}🔐 「审批用例」请求授权`), { message: '日志含审批通知' });
    await app.until(() => app.logs().includes(`${prefix}✅ 「审批用例」已搞定`), { message: '日志含完成通知' });
    expect(app.logs()).not.toContain('系统通知已 show()');
  });
});
