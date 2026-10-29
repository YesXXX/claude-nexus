import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { q, useApp } from './harness';
import {
  createSessionViaForm, initGitRepo, mkWorkDir, switchChangesScope, waitOutput, waitStatus, writeFiles,
} from './fixtures';

/**
 * 本会话改动：会话目录不是 git 仓库，Claude 又改了另一个仓库里的文件。
 * 改动页默认按 Claude 实际动过的文件列出，按目录分组并写明完整地址；
 * 有改前快照的文件可撤销与恢复，没有改前内容的只能查看；仓库视角作为第二选项。
 */

/** 统一成长路径、小写、反斜杠后比较：临时目录可能是 8.3 短路径，文件可能已被删除 */
const norm = (p: string): string => {
  let head = path.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(head)) {
    const up = path.dirname(head);
    if (up === head) break;
    tail.unshift(path.basename(head));
    head = up;
  }
  const real = fs.existsSync(head) ? fs.realpathSync.native(head) : head;
  return path.join(real, ...tail).toLowerCase();
};

describe('本会话改动', () => {
  const app = useApp({ env: { CLAUDE_PANEL_MOCK_NO_PERMISSION: '1' } });
  let id = '';
  let cwd = '';
  let other = '';
  let outside = '';

  const rowTitles = () => app.eval<string[]>(`[...document.querySelectorAll('.chg-list .chg-row')].map(r => r.title)`);
  const rowSel = (abs: string) => `.chg-list .chg-row[title=${q(abs)}]`;
  const groups = () => app.eval<Array<{ kind: string; root: string; out: boolean; count: string }>>(
    `[...document.querySelectorAll('.chg-list .chg-group')].map(g => ({
      kind: g.querySelector('.chg-group-kind').textContent,
      root: g.dataset.root,
      out: !!g.querySelector('.chg-tag.warn'),
      count: g.querySelector('.chg-group-count').textContent,
    }))`);
  const tagsOf = (abs: string) => app.eval<string[]>(
    `[...(document.querySelector(${q(rowSel(abs))})?.querySelectorAll('.chg-tag') ?? [])].map(t => t.textContent)`);
  const hasRevertBtn = (abs: string) => app.eval<boolean>(`!!document.querySelector(${q(`${rowSel(abs)} .rv-row-btn`)})`);
  const clickConfirm = (text: string) => app.eval<boolean>(`(() => {
    const b = [...document.querySelectorAll('#confirm-buttons button')].find(x => x.textContent.trim() === ${q(text)});
    if (!b) return false; b.click(); return true; })()`);

  it('准备：会话目录不是仓库，Claude 新建、修改、删除文件并改动另一个仓库', async () => {
    cwd = mkWorkDir(app, 'plain-dir');
    writeFiles(cwd, { 'old.txt': 'old\n' });
    other = initGitRepo(app, 'other-repo', { 'src/x.ts': 'const x = 1;\n' });
    outside = path.join(other, 'src', 'x.ts');
    id = await createSessionViaForm(app, '本会话改动用例', cwd);
    await waitOutput(app, id, 'mock-claude 已启动');
    const task = ['write notes.md 第一行', `edit ${outside} 跨仓库追加`, 'sh gen/out.txt 由命令生成', 'rm old.txt'].join('\n');
    expect(await app.eval<boolean>(`window.panelApi.input(${q(id)}, ${q(`\x1b[200~${task}\x1b[201~`)})`)).toBe(true);
    await new Promise(r => setTimeout(r, 100));
    expect(await app.eval<boolean>(`window.panelApi.input(${q(id)}, '\\r')`)).toBe(true);
    await waitOutput(app, id, '回合结束', 20_000);
    await waitStatus(app, id, 'completed');
    expect(fs.readFileSync(outside, 'utf8')).toBe('const x = 1;\n跨仓库追加\n');
    expect(fs.existsSync(path.join(cwd, 'old.txt'))).toBe(false);
    const sc = await app.until(async () => {
      const x = (await app.session(id))?.sessionChanges;
      return x && x.files === 4 ? x : undefined;
    }, { timeout: 20_000, message: '本会话改动为 4 个文件' });
    expect(sc).toMatchObject({ files: 4, additions: 3, deletions: 0, roots: 2 });
    await app.waitFor(`(document.querySelector('#tab-changes-stat')?.textContent ?? '').replace(/\\s+/g, ' ').trim() === '4 +3 −0'`,
      { message: '标签统计为 4 +3 −0' });
    await app.waitFor(`(document.querySelector('#inspector .chg-sum')?.textContent ?? '').includes('本会话 4 个文件')`,
      { message: '属性面板显示本会话改动' });
  });

  it('改动页默认本会话改动：按目录分组，标明普通目录、git 仓库与工作目录外，行与 diff 标题是完整地址', async () => {
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 4`, { message: '列表 4 个文件' });
    expect((await app.text('#changes-host .chg-toolbar')).replace(/\s+/g, ' ')).toContain('跨 2 个目录');

    const g = await groups();
    expect(g.map(x => [x.kind, x.out, x.count])).toEqual([['普通目录', false, '3'], ['git 仓库', true, '1']]);
    expect(norm(g[0].root)).toBe(norm(cwd));
    expect(norm(g[1].root)).toBe(norm(other));

    const titles = (await rowTitles()).map(norm);
    expect(titles).toEqual([
      path.join(cwd, 'gen', 'out.txt'), path.join(cwd, 'notes.md'), path.join(cwd, 'old.txt'), outside,
    ].map(norm));
    const [outTxt, notes, old, xts] = await rowTitles();
    expect(await tagsOf(outTxt)).toEqual(['Bash']);
    expect(await tagsOf(old)).toEqual(['Bash', '无改前内容']);
    expect(await tagsOf(notes)).toEqual([]);

    // 有改前快照的才能撤销
    expect(await hasRevertBtn(notes)).toBe(true);
    expect(await hasRevertBtn(outTxt)).toBe(true);
    expect(await hasRevertBtn(xts)).toBe(true);
    expect(await hasRevertBtn(old)).toBe(false);

    await app.click(rowSel(xts));
    await app.waitFor(`(document.querySelector('.chg-diff-path')?.dataset.addr ?? '') === ${q(xts)}`, { message: 'diff 标题为完整地址' });
    await app.waitFor(`[...document.querySelectorAll('.chg-diff-scroll .chg-ln.add .chg-txt')].some(e => e.textContent === '跨仓库追加')`,
      { message: 'x.ts 的 diff 已渲染' });
    expect(await app.count('.chg-diff-head .chg-copy-path')).toBe(1);

    await app.click(rowSel(old));
    await app.waitFor(`[...document.querySelectorAll('.chg-diff-scroll .chg-notice')].some(n => n.textContent.includes('没有改前内容'))`,
      { message: '删除且无改前内容的文件给出说明' });
    await app.shot('session-changes');
  });

  it('撤销跨仓库文件：恢复为首次修改前的内容，横幅写完整地址；恢复后回到撤销前', async () => {
    const xts = (await rowTitles())[3];
    await app.click(rowSel(xts));
    await app.waitFor(`document.querySelector('.rv-head-btn') !== null`, { message: 'diff 头部有撤销按钮' });
    await app.click('.rv-head-btn');
    await app.waitVisible('#confirm-backdrop');
    const msg = await app.text('#confirm-message');
    expect(msg).toContain('将恢复为本会话首次修改前的内容');
    expect(msg).toContain(`文件：${xts}`);
    expect(msg).not.toContain('将执行');
    expect(await clickConfirm('撤销此文件')).toBe(true);
    await app.waitFor(`(document.querySelector('.rv-bar:not([hidden]) .rv-bar-text')?.textContent ?? '').startsWith(${q(`已撤销 ${xts}`)})`,
      { message: '横幅出现' });
    expect(fs.readFileSync(outside, 'utf8')).toBe('const x = 1;\n');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 3`, { message: '列表剩 3 个文件' });
    expect(await app.count('.chg-list .chg-group')).toBe(1);
    expect(fs.readdirSync(path.join(app.home, 'undo-session', id))).toHaveLength(1);

    await app.click('.rv-bar .rv-restore');
    await app.waitFor(`document.querySelector('.rv-bar').hidden === true`, { message: '横幅消失' });
    expect(fs.readFileSync(outside, 'utf8')).toBe('const x = 1;\n跨仓库追加\n');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 4`, { message: 'x.ts 回到列表' });
  });

  it('撤销本会话新建的文件：确认框写明删除，撤销后文件不存在', async () => {
    const notes = (await rowTitles())[1];
    const btn = await app.eval<boolean>(`(() => {
      const b = document.querySelector(${q(`${rowSel(notes)} .rv-row-btn`)});
      if (!b) return false; b.click(); return true; })()`);
    expect(btn).toBe(true);
    await app.waitVisible('#confirm-backdrop');
    expect(await app.text('#confirm-message')).toContain('将删除该文件（本会话新建）');
    expect(await clickConfirm('撤销此文件')).toBe(true);
    await app.until(() => !fs.existsSync(path.join(cwd, 'notes.md')), { message: 'notes.md 被删除' });
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 3`, { message: '列表剩 3 个文件' });
    expect(await app.eval(`window.panelApi.sessionChanges.last(${q(id)}).then(e => e && e.scope)`)).toBe('session');
  });

  it('仓库视角是第二选项：会话目录不是仓库时没有文件；切回本会话改动恢复分组列表', async () => {
    await switchChangesScope(app, 'repo');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 0
      && !!document.querySelector('#changes-host .chg-state-msg')`, { message: '仓库视角没有文件并给出说明' });
    expect(await app.count('.chg-list .chg-group')).toBe(0);
    await switchChangesScope(app, 'session');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 3`, { message: '回到本会话改动' });
    expect(await app.count('.chg-list .chg-group')).toBe(2);
    expect(app.exceptions()).toEqual([]);
  });

  const rowNames = () => app.eval<string[]>(`[...document.querySelectorAll('.chg-list .chg-row .chg-name')].map(n => n.textContent)`);
  const setSearch = async (text: string) => {
    await app.fill('.chg-search', text);
    // 搜索输入有防抖，等列表按新词重绘
    await new Promise(r => setTimeout(r, 300));
  };

  it('搜索：/ 聚焦搜索框，按文件名过滤并显示匹配数，Esc 清空恢复', async () => {
    await app.press('Escape');
    await app.waitVisible('#term-card');
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 3`, { message: '列表 3 个文件' });
    await app.focus('.chg-list');
    await app.press('Slash');
    expect(await app.eval(`document.activeElement === document.querySelector('.chg-search')`)).toBe(true);

    await setSearch('x.ts');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 1`, { message: '只剩匹配的一行' });
    expect(await rowNames()).toEqual(['x.ts']);
    expect(await app.text('.chg-search-info')).toBe('1 / 3');

    await setSearch('不存在的文件');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 0`, { message: '无匹配' });
    expect(await app.text('.chg-list .chg-state-msg')).toBe('没有匹配的文件');
    expect(await app.visible('.chg-search')).toBe(true);

    await app.press('Escape');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 3`, { message: '清空后恢复全部' });
    expect(await app.eval(`document.querySelector('.chg-search').value`)).toBe('');
    expect(await app.text('.chg-search-info')).toBe('');
    // 搜索框里按 / 是普通输入，不会重复触发聚焦热键
    expect(await app.visible('#changes-host')).toBe(true);
  });

  it('折叠分组：点组头收起该组的行，组头仍在；状态刷新后保持；再点展开', async () => {
    const head = '.chg-list .chg-group:first-child';
    await app.click(head);
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 1`, { message: '普通目录组已折叠' });
    expect(await app.count('.chg-list .chg-group')).toBe(2);
    expect(await rowNames()).toEqual(['x.ts']);
    // 折叠后选中落到仍可见的文件
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row.sel').length === 1`, { message: '选中停在可见文件' });

    await app.click('#changes-host .chg-icon-btn[title^="刷新改动"]');
    await new Promise(r => setTimeout(r, 400));
    expect(await app.count('.chg-list .chg-row')).toBe(1);

    await app.click(head);
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 3`, { message: '展开后恢复' });
  });

  it('清除单个文件：行内 ✕ 直接清除，磁盘上的改前快照随之回收，文件本身不受影响', async () => {
    const outTxt = (await rowTitles())[0];
    const blobDir = path.join(app.home, 'changesets', id, 'blobs');
    const blobsBefore = fs.existsSync(blobDir) ? fs.readdirSync(blobDir).length : 0;
    const ok = await app.eval<boolean>(`(() => {
      const b = document.querySelector(${q(`${rowSel(outTxt)} .chg-row-clear`)});
      if (!b) return false; b.click(); return true; })()`);
    expect(ok).toBe(true);
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 2`, { message: '列表剩 2 个文件' });
    expect(await rowTitles()).not.toContain(outTxt);
    expect(fs.existsSync(outTxt)).toBe(true);
    const sc = await app.until(async () => {
      const x = (await app.session(id))?.sessionChanges;
      return x && x.files === 2 ? x : undefined;
    }, { message: '本会话改动摘要为 2 个文件' });
    expect(sc.files).toBe(2);
    if (blobsBefore > 0 && fs.existsSync(blobDir)) {
      expect(fs.readdirSync(blobDir).length).toBeLessThanOrEqual(blobsBefore);
    }
  });

  it('按分组清除：组头 ✕ 先确认，取消不清；确认后只清该目录的记录', async () => {
    // 按组头下标取（行与组头同为 div，不能用 nth-of-type）；此时第二个组头是工作目录外的仓库
    const clickGroupClear = (index: number) => app.eval<boolean>(`(() => {
      const b = document.querySelectorAll('.chg-list .chg-group')[${index}]?.querySelector('.chg-group-clear');
      if (!b) return false; b.click(); return true; })()`);

    expect(await clickGroupClear(1)).toBe(true);
    await app.waitVisible('#confirm-backdrop');
    expect(await app.text('#confirm-message')).toContain('不能再撤销到改前');
    expect(await clickConfirm('取消')).toBe(true);
    await app.waitHidden('#confirm-backdrop');
    expect(await app.count('.chg-list .chg-row')).toBe(2);

    expect(await clickGroupClear(1)).toBe(true);
    await app.waitVisible('#confirm-backdrop');
    expect(await clickConfirm('清除')).toBe(true);
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 1`, { message: '工作目录外的分组被清掉' });
    expect(await app.count('.chg-list .chg-group')).toBe(1);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('清除全部：工具栏按钮确认后记录清空，标签角标消失；之后再改文件重新记录', async () => {
    await app.click('#changes-host .chg-clear-btn');
    await app.waitVisible('#confirm-backdrop');
    expect(await app.text('#confirm-message')).toContain('全部');
    expect(await clickConfirm('清除')).toBe(true);
    await app.waitFor(`!!document.querySelector('#changes-host .chg-state-msg')
      && document.querySelectorAll('.chg-list .chg-row').length === 0`, { message: '列表为空并显示占位' });
    expect(await app.text('#changes-host .chg-state-msg')).toBe('暂无改动');
    await app.waitFor(`(document.querySelector('#tab-changes-stat')?.textContent ?? '').trim() === ''`, { message: '标签统计消失' });
    expect(await app.visible('#changes-host .chg-clear-btn')).toBe(false);
    expect(fs.existsSync(path.join(app.home, 'changesets', id, 'manifest.json'))).toBe(false);

    const fresh = path.join(cwd, 'again.txt');
    expect(await app.postHook(id, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: fresh } })).toBe(200);
    fs.writeFileSync(fresh, 'hello\n');
    expect(await app.postHook(id, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: fresh } })).toBe(200);
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 1`, { message: '新改动重新出现在列表' });
    expect(await rowNames()).toEqual(['again.txt']);
    expect(app.exceptions()).toEqual([]);
  });
});
