import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { q, useApp } from './harness';
import { createSessionViaForm, initGitRepo, switchChangesScope, waitOutput, writeFiles } from './fixtures';

/**
 * 外部编辑器跳转：配置编辑器命令后，悬停 diff 行出现「:行号」按钮，点击按新侧行号在编辑器打开；
 * 删除行就近映射到相邻新侧行号；diff 头「打开」按钮带第一个 hunk 的行号；
 * 命令找不到时给出明确提示。测试用 node 存根脚本代替真实编辑器，把收到的参数写入文件断言。
 */

/** 存根脚本：把收到的参数按 JSON 行追加到 CLAUDE_E2E_EDITOR_OUT 指向的文件 */
const STUB = [
  'const fs = require("fs");',
  'const out = process.env.CLAUDE_E2E_EDITOR_OUT || "";',
  'if (out) fs.appendFileSync(out, JSON.stringify(process.argv.slice(2)) + "\\n");',
  '',
].join('\n');

/** 读回存根脚本收到的参数（每次一行 JSON 数组） */
function readJumps(out: string): string[][] {
  if (!fs.existsSync(out)) return [];
  return fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as string[]);
}

/** 完整地址可能与临时目录的短路径写法不同，比较时统一成正斜杠 */
const samePath = (a: string, b: string): boolean => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

describe('diff 跳外部编辑器', () => {
  const app = useApp({ env: { CLAUDE_E2E_EDITOR_OUT: '{root}/editor-jumps.json' } });
  const jumps = (): string[][] => readJumps(path.join(app.root, 'editor-jumps.json'));

  /** 点击文件名以指定后缀结尾的列表行 */
  const clickRowBySuffix = (suffix: string): Promise<boolean> => app.eval<boolean>(
    `(() => { const row = [...document.querySelectorAll('.chg-list .chg-row')]
      .find(r => (r.title ?? '').replace(/\\\\/g, '/').endsWith(${q(suffix)}));
      if (!row) return false; row.click(); return true; })()`);

  /** 等到存根脚本新收到的下一条参数（以当前条数为基线，避开上一次的旧记录） */
  const nextJump = (): Promise<string[] | undefined> => {
    const base = jumps().length;
    return app.until(() => (jumps().length > base ? jumps().at(-1) : undefined), { message: '存根脚本收到参数' });
  };

  /** 点跳转按钮并读回存根脚本新收到的参数 */
  const clickAndReadJump = (): Promise<string[] | undefined> => {
    const base = jumps().length;
    return app.click('.ejump-btn').then(() =>
      app.until(() => (jumps().length > base ? jumps().at(-1) : undefined), { message: '存根脚本收到参数' }));
  };

  it('准备：会话、改动与编辑器命令（node 存根脚本）', async () => {
    const repo = initGitRepo(app, 'proj-jump', { 'a.txt': 'l1\nl2\nl3\nl4\nl5\n', 'j.txt': 'j1\nj2\n' });
    fs.writeFileSync(path.join(app.root, 'editor-stub.js'), STUB);
    // 仓库视角的改动：外部修改 a.txt 第 3 行
    writeFiles(repo, { 'a.txt': 'l1\nl2\nL3\nl4\nl5\n' });
    const sid = await createSessionViaForm(app, '跳转用例', repo);
    await waitOutput(app, sid, 'mock-claude 已启动');
    // 本会话视角的改动：模拟 Edit 工具改 j.txt 第 2 行（先取快照再写入）
    const j = path.join(repo, 'j.txt');
    expect(await app.postHook(sid, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: j } })).toBe(200);
    writeFiles(repo, { 'j.txt': 'j1\nJ2\n' });
    expect(await app.postHook(sid, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: j } })).toBe(200);
    expect(await app.postHook(sid, { hook_event_name: 'Stop' })).toBe(200);
    await app.until(async () => (await app.session(sid))?.sessionChanges?.files === 1, { message: '本会话改动 1 个文件' });
    await app.until(async () => (await app.session(sid))?.changes?.files === 2, { message: '仓库改动 2 个文件' });

    const cmd = `node "${path.join(app.root, 'editor-stub.js')}" {file} {line}`;
    const r = await app.eval<{ ok: boolean; command?: string; error?: string }>(
      `window.panelApi.editor.setConfig(${q(cmd)})`);
    expect(r).toMatchObject({ ok: true, command: cmd });
  });

  it('本会话视角：悬停行出现「:行号」，点击按新侧行号在编辑器打开', async () => {
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    await app.until(() => clickRowBySuffix('/j.txt'), { message: '点击 j.txt 列表行' });
    await app.waitFor(`!!document.querySelector('.chg-diff-scroll .chg-ln.add[data-n="2"]')`, { message: 'j.txt 的 diff 已渲染' });

    await app.eval(`document.querySelector('.chg-diff-scroll .chg-ln.add[data-n="2"]').dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, cancelable: true }))`);
    await app.waitVisible('.ejump-overlay');
    expect(await app.text('.ejump-label')).toBe(':2');
    const got = await clickAndReadJump();
    expect(got?.[1]).toBe('2');
    expect(got && samePath(got[0], path.join(app.root, 'work', 'proj-jump', 'j.txt'))).toBe(true);
  });

  it('删除行就近映射到相邻新侧行号；diff 头「打开」带第一个 hunk 的行号', async () => {
    await switchChangesScope(app, 'repo');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 2`, { message: '仓库改动 2 行' });
    await app.click('.chg-list .chg-row[data-index="0"]');
    await app.waitFor(`!!document.querySelector('.chg-diff-scroll .chg-ln.add[data-n="3"]')`, { message: 'a.txt 的 diff 已渲染' });
    const a = path.join(app.root, 'work', 'proj-jump', 'a.txt');

    // 删除行没有新侧行号，映射到紧随其后的新增行（第 3 行）
    await app.eval(`document.querySelector('.chg-diff-scroll .chg-ln.del').dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, cancelable: true }))`);
    await app.waitVisible('.ejump-overlay');
    expect(await app.text('.ejump-label')).toBe(':3');
    let got = await clickAndReadJump();
    expect(got?.[1]).toBe('3');
    expect(got && samePath(got[0], a)).toBe(true);

    // 头部「打开」按钮带第一个 hunk 的起始行（这里是开头的上下文行，新侧第 1 行）
    await app.click('.chg-open');
    got = await nextJump();
    expect(got?.[1]).toBe('1');
    expect(got && samePath(got[0], a)).toBe(true);
  });

  it('命令找不到时给出明确提示；清除配置后不再出现悬停按钮', async () => {
    const bad = 'panel-e2e-missing-editor-xyz {file}';
    expect(await app.eval(`window.panelApi.editor.setConfig(${q(bad)})`)).toMatchObject({ ok: true });
    // 命令缓存在改动视图每次展示时刷新：切回终端再进改动页
    await app.press('Control+Shift+D');
    await app.waitVisible('#term-card');
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    await switchChangesScope(app, 'repo');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 2`, { message: '仓库改动 2 行' });
    await app.click('.chg-list .chg-row[data-index="0"]');
    await app.waitFor(`!!document.querySelector('.chg-diff-scroll .chg-ln')`, { message: 'diff 已渲染' });

    const before = jumps().length;
    await app.eval(`document.querySelector('.chg-diff-scroll .chg-ln.add[data-n="3"]').dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, cancelable: true }))`);
    await app.waitVisible('.ejump-overlay');
    await app.click('.ejump-btn');
    await app.waitFor(`document.querySelector('#toast-container')?.textContent.includes('找不到命令')`, { message: '找不到命令提示' });
    await new Promise(r => setTimeout(r, 500));
    expect(jumps().length).toBe(before);

    expect(await app.eval(`window.panelApi.editor.setConfig('')`)).toMatchObject({ ok: true, command: '' });
    await app.press('Control+Shift+D');
    await app.waitVisible('#term-card');
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 2`, { message: '仓库改动 2 行' });
    await app.click('.chg-list .chg-row[data-index="0"]');
    await app.waitFor(`!!document.querySelector('.chg-diff-scroll .chg-ln')`, { message: 'diff 已渲染' });
    // 未配置时悬停不出现按钮
    await app.eval(`document.querySelector('.chg-diff-scroll .chg-ln.add').dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, cancelable: true }))`);
    await new Promise(r => setTimeout(r, 200));
    expect(await app.eval(`document.querySelector('.ejump-overlay')?.hidden`)).toBe(true);
    expect(await app.exceptions()).toEqual([]);
  });
});
