import { describe, it, expect } from 'vitest';
import { q, useApp } from './harness';
import { createSessionViaForm, initGitRepo, rowSel, switchChangesScope, waitOutput, writeFiles } from './fixtures';

/**
 * 忽略空白差异开关：改动页工具栏按钮与单键 I 切换（焦点不在终端 / 输入框时），
 * 开启后 diff 重新拉取（相当于 git diff -w），只剩空白变化的文件给出「忽略空白后没有差异」说明；
 * 文件列表与增删统计不受影响；偏好存 localStorage，重载后保留；命令面板也能开关。
 * 两个数据源都覆盖：本会话改动（改前快照对比）与仓库视角（git diff）。
 */

describe('忽略空白差异', () => {
  const app = useApp();
  let sid = '';

  const stored = () => app.eval<string | null>(`localStorage.getItem(${q('nexus.diff.ignoreWs')})`);
  const wsOn = () => app.eval<boolean>(`document.querySelector('.chg-ws-btn')?.classList.contains('on')`);
  const hasLines = () => app.eval<boolean>(`!!document.querySelector('.chg-diff-scroll .chg-ln')`);
  /** 点击本会话视角的列表行（行的 title 是完整地址） */
  const clickSessionRow = (suffix: string): Promise<boolean> => app.eval<boolean>(
    `(() => { const row = [...document.querySelectorAll('.chg-list .chg-row')]
      .find(r => (r.title ?? '').replace(/\\\\/g, '/').endsWith(${q(suffix)}));
      if (!row) return false; row.click(); return true; })()`);
  /** 点击仓库视角的列表行（行的 title 是仓库内相对路径） */
  const clickRepoRow = (name: string): Promise<boolean> => app.eval<boolean>(
    `(() => { const row = [...document.querySelectorAll('.chg-list .chg-row')]
      .find(r => (r.title ?? '') === ${q(name)}); if (!row) return false; row.click(); return true; })()`);

  it('准备：仓库与会话（仓库视角的空白改动 + 本会话的空白改动）', async () => {
    const repo = initGitRepo(app, 'proj-ws', { 'ws.txt': 'x\n', 'real.txt': 'v1\n', 's.txt': 'x\n' });
    // 仓库视角：外部把 ws.txt 只改成多了个空格，real.txt 有实质内容变化
    writeFiles(repo, { 'ws.txt': ' x\n', 'real.txt': 'v2\n' });
    sid = await createSessionViaForm(app, '忽略空白用例', repo);
    await waitOutput(app, sid, 'mock-claude 已启动');
    // 本会话视角：模拟 Edit 工具把 s.txt 也只改成多了个空格
    const s = `${repo}\\s.txt`;
    expect(await app.postHook(sid, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: s } })).toBe(200);
    writeFiles(repo, { 's.txt': ' x\n' });
    expect(await app.postHook(sid, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: s } })).toBe(200);
    expect(await app.postHook(sid, { hook_event_name: 'Stop' })).toBe(200);
    await app.until(async () => (await app.session(sid))?.sessionChanges?.files === 1, { message: '本会话改动 1 个文件' });
    // 仓库视角算上全部未提交改动：外部的 ws.txt / real.txt 与会话改的 s.txt 共 3 个
    await app.until(async () => (await app.session(sid))?.changes?.files === 3, { message: '仓库改动 3 个文件' });
  });

  it('本会话视角：I 开关忽略空白，仅空白变化的文件差异消失并给提示，统计不变', async () => {
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    await app.until(() => clickSessionRow('/s.txt'), { message: '点击 s.txt 列表行' });
    await app.waitFor(`!!document.querySelector('.chg-diff-scroll .chg-ln.del')`, { message: 's.txt 的 diff 已渲染' });

    expect(await stored()).toBeNull();
    expect(await wsOn()).toBe(false);
    expect(await hasLines()).toBe(true);

    await app.focus('.chg-list');
    await app.press('i');
    await app.waitFor(`document.querySelector('.chg-ws-btn')?.classList.contains('on')`, { message: '忽略空白按钮点亮' });
    expect(await stored()).toBe('1');
    await app.waitFor(`document.querySelector('.chg-diff-scroll .chg-placeholder')?.textContent.includes('忽略空白后没有差异')`,
      { message: 's.txt 显示仅空白变化说明' });
    expect(await hasLines()).toBe(false);
    // 列表行与统计不受影响：s.txt 仍计 1 增 1 删
    expect(await app.eval(`document.querySelector('.chg-list .chg-row .chg-add')?.textContent`)).toBe('+1');
    expect(await app.eval(`document.querySelector('.chg-list .chg-row .chg-del')?.textContent`)).toBe('−1');

    await app.press('i');
    await app.until(async () => (await hasLines()), { message: '关闭后差异行恢复' });
    expect(await stored()).toBe('0');
    expect(await wsOn()).toBe(false);
  });

  it('仓库视角同样生效：ws.txt 给提示，real.txt 照常显示差异，统计保持原口径', async () => {
    await switchChangesScope(app, 'repo');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 3`, { message: '仓库改动 3 行' });

    await app.focus('.chg-list');
    await app.press('i');
    await app.waitFor(`document.querySelector('.chg-ws-btn')?.classList.contains('on')`, { message: '开启忽略空白' });
    await app.until(() => clickRepoRow('ws.txt'), { message: '点击 ws.txt 列表行' });
    await app.waitFor(`document.querySelector('.chg-diff-scroll .chg-placeholder')?.textContent.includes('忽略空白后没有差异')`,
      { message: 'ws.txt 显示仅空白变化说明' });
    expect(await hasLines()).toBe(false);
    // 实质内容变化的文件照常显示
    await app.until(() => clickRepoRow('real.txt'), { message: '点击 real.txt 列表行' });
    await app.until(async () => (await app.text('.chg-diff-scroll .chg-ln.add .chg-txt')).includes('v2'), { message: 'real.txt 仍有差异' });

    // 列表统计按原口径：ws.txt 仍计 1 增 1 删，工具栏合计 3 增 3 删
    expect(await app.eval(`document.querySelector('.chg-list .chg-row[data-index="2"] .chg-add')?.textContent`)).toBe('+1');
    expect(await app.eval(`document.querySelector('.chg-list .chg-row[data-index="2"] .chg-del')?.textContent`)).toBe('−1');
    expect(await app.text('.chg-summary')).toContain('+3');
    expect(await app.text('.chg-summary')).toContain('−3');

    await app.press('i');
    await app.until(() => clickRepoRow('ws.txt'), { message: '回到 ws.txt' });
    await app.until(async () => (await hasLines()), { message: '关闭后 ws.txt 差异行恢复' });
  });

  it('偏好持久化：重载后仍开启；命令面板里的开关命令同样可用', async () => {
    await app.focus('.chg-list');
    await app.press('i');
    await app.waitFor(`document.querySelector('.chg-ws-btn')?.classList.contains('on')`, { message: '开启忽略空白' });

    // 重载后回到默认的本会话视角，按持久化的口径拉取 diff
    await app.reload();
    await app.click(rowSel(sid));
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    await app.focus('.chg-list');
    await app.waitFor(`document.querySelector('.chg-ws-btn')?.classList.contains('on') === true`, { message: '重载后按钮仍点亮' });
    expect(await stored()).toBe('1');
    await app.until(() => clickSessionRow('/s.txt'), { message: '点击 s.txt 列表行' });
    await app.waitFor(`document.querySelector('.chg-diff-scroll .chg-placeholder')?.textContent.includes('忽略空白后没有差异')`,
      { message: '重载后 s.txt 仍按忽略空白口径显示' });

    await app.blur();
    await app.press('Control+K');
    await app.waitVisible('#palette-backdrop');
    // 查询词带「开关」，避开会话名「忽略空白用例」对结果的干扰
    await app.type('开关忽略空白');
    await app.waitFor(`document.querySelector('#palette-list .pal-i .pt')?.textContent.includes('开关忽略空白差异')`,
      { message: '面板里有开关命令' });
    expect(await app.eval(`document.querySelector('#palette-list .pal-i .ps')?.textContent`)).toContain('当前：开');
    await app.press('Enter');
    await app.waitHidden('#palette-backdrop');
    await app.until(async () => (await stored()) === '0', { message: '面板命令关掉忽略空白' });
    await app.until(async () => !(await wsOn()), { message: '按钮同步熄灭' });
    await app.until(async () => (await hasLines()), { message: '差异行恢复' });
    expect(await app.exceptions()).toEqual([]);
  });
});
