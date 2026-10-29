import path from 'path';
import { describe, it, expect } from 'vitest';
import { q, useApp } from './harness';
import {
  createSessionViaForm, initGitRepo, switchChangesScope, terminalFocusedExpr, waitOutput, writeFiles,
} from './fixtures';

/**
 * 改动审阅：默认「本会话改动」视角按 Claude 动过的文件列出完整地址；「仓库视角」按 git 状态列出仓库内相对路径，
 * diff 标题拼上仓库根显示完整地址。
 */

describe('改动审阅', () => {
  const app = useApp();
  let id = '';
  let repo = '';

  /** 改动列表各行的悬停地址 */
  const rowPaths = () => app.eval<string[]>(
    `[...document.querySelectorAll('.chg-list .chg-row')].map(el => el.getAttribute('title'))`);

  /** 当前 diff 中各类行的文本 */
  const diffLines = (kind: string) => app.eval<string[]>(
    `[...document.querySelectorAll('.chg-diff-scroll .chg-ln.${kind} .chg-txt')].map(el => el.textContent)`);

  const diffPath = () => app.eval<string>(`document.querySelector('.chg-diff-path')?.dataset.addr ?? ''`);

  const diffPathIs = (p: string) => app.waitFor(
    `(document.querySelector('.chg-diff-path')?.dataset.addr ?? '') === ${q(p)}`, { message: `diff 标题为 ${p}` });

  const clickRow = (title: string) => app.click(`.chg-list .chg-row[title=${q(title)}]`);

  it('工作目录是干净的 git 仓库时没有改动统计', async () => {
    repo = initGitRepo(app, 'proj-changes', { 'a.txt': 'one\ntwo\nthree\n', 'keep.txt': 'keep\n' });
    id = await createSessionViaForm(app, '改动用例', repo);
    await waitOutput(app, id, 'mock-claude 已启动');
    const c = await app.until(async () => (await app.session(id))?.changes, { message: '会话带改动摘要' });
    expect(c.files).toBe(0);
    expect((await app.text('#tab-changes-stat')).trim()).toBe('');
  });

  it('Claude 用工具改文件后标签显示本会话改动统计', async () => {
    // 先上报 PreToolUse（面板在此时取改前快照），再改文件、上报 PostToolUse
    for (const [tool, file] of [['Edit', 'a.txt'], ['Write', 'new.txt']]) {
      expect(await app.postHook(id, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file } })).toBe(200);
    }
    writeFiles(repo, { 'a.txt': 'one\nTWO\nthree\n', 'new.txt': 'fresh\n' });
    for (const [tool, file] of [['Edit', 'a.txt'], ['Write', 'new.txt']]) {
      expect(await app.postHook(id, { hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { file_path: file } })).toBe(200);
    }
    expect(await app.postHook(id, { hook_event_name: 'Stop' })).toBe(200);
    const sc = await app.until(async () => {
      const x = (await app.session(id))?.sessionChanges;
      return x && x.files === 2 ? x : undefined;
    }, { message: '本会话改动摘要为 2 个文件' });
    expect(sc).toMatchObject({ files: 2, additions: 2, deletions: 1, roots: 1 });
    const c = await app.until(async () => {
      const x = (await app.session(id))?.changes;
      return x && x.files === 2 ? x : undefined;
    }, { message: '仓库视角摘要为 2 个文件' });
    expect(c).toMatchObject({ files: 2, additions: 2, deletions: 1 });
    await app.waitFor(`(document.querySelector('#tab-changes-stat')?.textContent ?? '').replace(/\\s+/g, ' ').trim() === '2 +2 −1'`,
      { message: '标签统计为 2 +2 −1' });
  });

  it('Ctrl+Shift+D 切到改动页，默认本会话改动：分组标题写明仓库根，行与 diff 标题是完整地址', async () => {
    // 新建后焦点在终端，该热键在终端内同样生效
    await app.waitFor(terminalFocusedExpr(), { message: '终端获得焦点' });
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    expect(await app.visible('#term-card')).toBe(false);
    expect(await app.eval(`document.querySelector('#tab-changes').classList.contains('on')`)).toBe(true);
    expect(await app.eval(`document.querySelector('.chg-scope [data-scope="session"]').classList.contains('on')`)).toBe(true);

    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 2`, { message: '改动列表两行' });
    const a = path.join(repo, 'a.txt');
    const fresh = path.join(repo, 'new.txt');
    expect((await rowPaths()).sort()).toEqual([a, fresh].sort());
    expect(await app.count('.chg-list .chg-group')).toBe(1);
    expect(await app.text('.chg-list .chg-group .chg-group-kind')).toBe('git 仓库');
    expect((await app.eval<string>(`document.querySelector('.chg-list .chg-group').dataset.root`)).toLowerCase()).toBe(repo.toLowerCase());
    expect(await app.text('.chg-list .chg-group .chg-group-count')).toBe('2');
    // 打开时自动选中第一个文件
    expect(await app.count('.chg-list .chg-row.sel')).toBe(1);

    await clickRow(a);
    await diffPathIs(a);
    await app.waitFor(`document.querySelectorAll('.chg-diff-scroll .chg-ln.add').length === 1`, { message: 'a.txt 一行新增' });
    expect(await diffLines('add')).toEqual(['TWO']);
    expect(await diffLines('del')).toEqual(['two']);
    expect(await diffLines('ctx')).toEqual(expect.arrayContaining(['one', 'three']));

    await clickRow(fresh);
    await diffPathIs(fresh);
    await app.waitFor(`document.querySelectorAll('.chg-diff-scroll .chg-ln.add').length === 1`, { message: 'new.txt 一行新增' });
    expect(await diffLines('add')).toEqual(['fresh']);
    expect(await diffLines('del')).toEqual([]);
  });

  it('切到仓库视角：行是仓库内相对路径，diff 标题拼上仓库根', async () => {
    await switchChangesScope(app, 'repo');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 2`, { message: '仓库视角两行' });
    expect(await app.count('.chg-list .chg-group')).toBe(0);
    expect((await rowPaths()).sort()).toEqual(['a.txt', 'new.txt']);
    await clickRow('a.txt');
    await app.waitFor(`(document.querySelector('.chg-diff-path')?.dataset.addr ?? '').endsWith('a.txt')`, { message: 'diff 标题为 a.txt' });
    const shown = await diffPath();
    expect(shown.toLowerCase().replace(/\//g, '\\')).toBe(path.join(repo, 'a.txt').toLowerCase());
    await app.waitFor(`document.querySelectorAll('.chg-diff-scroll .chg-ln.add').length === 1`, { message: 'a.txt 一行新增' });
    expect(await diffLines('add')).toEqual(['TWO']);
    await switchChangesScope(app, 'session');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-group').length === 1`, { message: '回到本会话改动' });
  });

  it('Esc 回到终端页', async () => {
    await app.press('Escape');
    await app.waitVisible('#term-card');
    expect(await app.visible('#changes-host')).toBe(false);
    expect(await app.eval(`document.querySelector('#tab-term').classList.contains('on')`)).toBe(true);
  });
});
