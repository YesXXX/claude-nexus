import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { q, useApp } from './harness';
import { createSessionViaForm, initGitRepo, switchChangesScope, waitOutput, writeFiles } from './fixtures';

/**
 * diff 左右分栏：工具栏与 V 键切换、两侧对齐与空白占位、长行换行等高、切换时按行号保持滚动、
 * 窄窗口临时回退统一视图、各类提示与元信息行、分栏下的批注、偏好重启后保留。
 */

const LONG = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
const OLD_A = ['a', 'b', 'c', 'd', 'e', LONG, 'f', ''].join('\n');
const NEW_A = ['a', 'B', 'e', LONG, 'f', 'g', ''].join('\n');

// 每 10 行改一行，足够长以便滚动
const scrollFile = (bump: boolean): string =>
  Array.from({ length: 400 }, (_, i) => (bump && i % 10 === 5 ? `line ${i} changed` : `line ${i}`)).join('\n') + '\n';

/** 大屏视口下 diff 区宽于分栏门槛，窄视口下低于门槛（改动页自动收起属性面板，窄视口要再窄一些） */
const WIDE_VIEW = 1700;
const NARROW_VIEW = 1100;

const hugeFile = (bump: number): string =>
  Array.from({ length: 6000 }, (_, i) => `row ${i} v${bump}`).join('\n') + '\n';

describe('diff 左右分栏', () => {
  const app = useApp();
  let repo = '';
  let sid = '';

  const select = async (p: string): Promise<void> => {
    await app.click(`.chg-list .chg-row[title=${JSON.stringify(p)}]`);
    await app.waitFor(`(document.querySelector('.chg-diff-path')?.dataset.addr ?? '').replace(/\\\\/g, '/').endsWith(${JSON.stringify(`/${p}`)})
      && !!document.querySelector('.chg-diff-scroll .chg-code, .chg-diff-scroll .chg-placeholder')`, { message: `diff 显示 ${p}` });
  };
  const isSplit = () => app.eval<boolean>(`!!document.querySelector('.chg-diff-scroll .chg-split')`);
  const pref = () => app.eval<string | null>(`localStorage.getItem('nexus.diff.view')`);
  const notices = () => app.eval<string[]>(`[...document.querySelectorAll('.chg-diff-scroll .chg-notice')].map(n => n.textContent)`);

  /** 首个可见且带新行号的行 */
  const firstVisibleNew = () => app.eval<string | undefined>(`(() => {
    const sc = document.querySelector('.chg-diff-scroll');
    const rows = [...sc.querySelectorAll('.chg-ln[data-n]')];
    const top = sc.getBoundingClientRect().top;
    return rows.find(r => r.getBoundingClientRect().bottom > top + 0.5)?.dataset.n;
  })()`);

  it('准备仓库与会话，打开改动页', async () => {
    repo = initGitRepo(app, 'proj-split', {
      'a.txt': OLD_A,
      'scroll.txt': scrollFile(false),
      'nonl.txt': 'x\ny',
      'gbk.txt': 'plain\n',
      'bin.dat': 'base\n',
      'huge.txt': hugeFile(0),
    });
    writeFiles(repo, { 'a.txt': NEW_A, 'scroll.txt': scrollFile(true), 'nonl.txt': 'x\nz', 'huge.txt': hugeFile(1) });
    // 「你好」的 GBK 字节，不是合法 UTF-8；带 NUL 的内容 git 按二进制处理
    fs.writeFileSync(path.join(repo, 'gbk.txt'), Buffer.from([0x70, 0x6c, 0x61, 0x69, 0x6e, 0x0a, 0xc4, 0xe3, 0xba, 0xc3, 0x0a]));
    fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
    // 默认窗口下 diff 区不到 640px，按大屏宽度排版才能看到分栏
    await app.viewport(WIDE_VIEW);
    sid = await createSessionViaForm(app, '分栏用例', repo);
    await waitOutput(app, sid, 'mock-claude 已启动');
    expect(await app.postHook(sid, { hook_event_name: 'Stop' })).toBe(200);
    await app.until(async () => (await app.session(sid))?.changes?.files === 6, { timeout: 20_000, message: '改动摘要为 6 个文件' });
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    await switchChangesScope(app, 'repo');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 6`, { message: '改动列表 6 行' });
    expect(await pref()).toBeNull();
  });

  it('工具栏切到分栏：删多于增时右侧留空白占位，两侧逐行对齐', async () => {
    await select('a.txt');
    expect(await isSplit()).toBe(false);
    expect(await app.eval(`document.querySelector('.chg-view-seg [data-view=unified]').classList.contains('on')`)).toBe(true);
    await app.click('.chg-view-seg [data-view=split]');
    await app.waitFor(`!!document.querySelector('.chg-diff-scroll .chg-split')`, { message: '出现分栏' });
    expect(await pref()).toBe('split');
    expect(await app.eval(`document.querySelector('.chg-view-seg [data-view=split]').classList.contains('on')`)).toBe(true);

    // b、c、d 删，B 增：b 与 B 配对，c、d 右侧为空
    expect(await app.count('.chg-diff-scroll .chg-half.r.k-empty')).toBe(2);
    expect(await app.count('.chg-diff-scroll .chg-half.l.k-empty')).toBe(1);
    const pair = await app.eval<string[]>(`(() => {
      const row = [...document.querySelectorAll('.chg-diff-scroll .chg-ln.split')]
        .find(r => r.querySelector('.chg-half.l .chg-txt')?.textContent === 'b');
      return row ? [...row.querySelectorAll('.chg-half')].map(h => h.className + '|' + h.querySelector('.chg-txt').textContent) : [];
    })()`);
    expect(pair).toEqual(['chg-half l k-del|b', 'chg-half r k-add|B']);

    const misaligned = await app.eval<number>(`[...document.querySelectorAll('.chg-diff-scroll .chg-ln.split')].filter(r => {
      const [l, rr] = r.querySelectorAll('.chg-half');
      return l.getBoundingClientRect().top !== rr.getBoundingClientRect().top || l.offsetHeight !== rr.offsetHeight;
    }).length`);
    expect(misaligned).toBe(0);
    // 两套行号：左旧右新
    const nums = await app.eval<string[]>(`(() => {
      const row = [...document.querySelectorAll('.chg-diff-scroll .chg-ln.split')]
        .find(r => r.querySelector('.chg-half.r .chg-txt')?.textContent === 'g');
      return row ? [row.querySelector('.chg-half.l .chg-no').textContent, row.querySelector('.chg-half.r .chg-no').textContent] : [];
    })()`);
    expect(nums).toEqual(['', '6']);
  });

  it('长行在两侧自动换行并保持等高', async () => {
    const r = await app.eval<{ long: number; short: number; l: number; rr: number }>(`(() => {
      const rows = [...document.querySelectorAll('.chg-diff-scroll .chg-ln.split')];
      const long = rows.find(x => x.querySelector('.chg-half.r .chg-txt')?.textContent === ${q(LONG)});
      const short = rows.find(x => x.querySelector('.chg-half.r .chg-txt')?.textContent === 'a');
      const [l, rr] = long.querySelectorAll('.chg-half');
      return { long: long.offsetHeight, short: short.offsetHeight, l: l.offsetHeight, rr: rr.offsetHeight };
    })()`);
    expect(r.long).toBeGreaterThan(r.short * 1.5);
    expect(r.l).toBe(r.rr);
    expect(await app.eval(`document.querySelector('.chg-diff-scroll').scrollWidth <= document.querySelector('.chg-diff-scroll').clientWidth`)).toBe(true);
    await app.shot('split-a');
  });

  it('按 V 切换视图，首个可见行号不变，选中文件不变', async () => {
    await select('scroll.txt');
    expect(await isSplit()).toBe(true);
    // 滚到某个上下文行顶边稍下（避开缩放下的小数像素），切换前后它都应是首个可见行
    await app.eval(`(() => {
      const sc = document.querySelector('.chg-diff-scroll');
      const row = sc.querySelector('.chg-ln[data-n="205"]');
      sc.scrollTop = row.offsetTop + 2;
      sc.focus();
      return true;
    })()`);
    const before = await firstVisibleNew();
    expect(before).toBe('205');
    await app.press('v');
    await app.waitFor(`!document.querySelector('.chg-diff-scroll .chg-split')`, { message: 'V 切回统一' });
    expect(await pref()).toBe('unified');
    expect(await firstVisibleNew()).toBe(before);
    expect((await app.eval<string>(`document.querySelector('.chg-diff-path').dataset.addr`)).replace(/\\/g, '/')).toMatch(/\/scroll\.txt$/);
    await app.press('v');
    await app.waitFor(`!!document.querySelector('.chg-diff-scroll .chg-split')`, { message: 'V 切到分栏' });
    expect(await firstVisibleNew()).toBe(before);
  });

  it('diff 区过窄时暂按统一显示并提示，偏好不变，放宽后恢复分栏', async () => {
    await select('a.txt');
    expect(await isSplit()).toBe(true);
    const wide = await app.eval<number>(`document.querySelector('.chg-diff-scroll').clientWidth`);
    expect(wide).toBeGreaterThan(664);
    await app.viewport(NARROW_VIEW);
    await app.waitFor(`!document.querySelector('.chg-diff-scroll .chg-split')
      && !!document.querySelector('.chg-diff-scroll .chg-ln')`, { message: '过窄回退统一' });
    expect((await notices()).some(t => t.includes('diff 区不足 640px'))).toBe(true);
    expect(await pref()).toBe('split');
    expect(await app.text('.chg-view-seg [data-view=split]')).toBe('分栏');
    expect(await app.eval(`document.querySelector('.chg-view-seg').classList.contains('narrow')`)).toBe(true);
    await app.shot('split-narrow');
    await app.viewport(WIDE_VIEW);
    await app.waitFor(`!!document.querySelector('.chg-diff-scroll .chg-split')`, { message: '放宽后恢复分栏' });
    expect((await notices()).some(t => t.includes('diff 区不足 640px'))).toBe(false);
    expect(await app.text('.chg-view-seg [data-view=split]')).toBe('分栏');
  });

  it('二进制、非 UTF-8、无换行元信息、截断提示在分栏下正常显示', async () => {
    await select('bin.dat');
    expect(await app.text('.chg-diff-scroll .chg-placeholder')).toContain('二进制文件');
    expect(await isSplit()).toBe(false);

    await select('gbk.txt');
    expect((await notices()).some(t => t.includes('不是 UTF-8'))).toBe(true);
    expect(await isSplit()).toBe(true);

    await select('nonl.txt');
    const meta = await app.eval<string[]>(`[...document.querySelectorAll('.chg-diff-scroll .chg-ln.split.meta')].map(r => r.textContent)`);
    expect(meta.length).toBeGreaterThan(0);
    expect(meta.join('')).toContain('No newline');

    await select('huge.txt');
    await app.waitFor(`[...document.querySelectorAll('.chg-diff-scroll .chg-notice')].some(n => n.textContent.includes('diff 过大'))`,
      { message: '截断提示' });
    expect(await isSplit()).toBe(true);
  });

  it('分栏下在右侧行号栏添加批注，标记画在右栏', async () => {
    await select('a.txt');
    const down = await app.eval<boolean>(`(() => {
      const half = [...document.querySelectorAll('.chg-diff-scroll .chg-half.r')].find(h => h.querySelector('.chg-txt')?.textContent === 'g');
      if (!half) return false;
      half.querySelector('.chg-no').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      return true; })()`);
    expect(down).toBe(true);
    await app.eval(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })), true`);
    await app.waitFor(`document.activeElement?.classList.contains('ann-input') === true`, { message: '批注输入框获得焦点' });
    expect(await app.text('.ann-card-title')).toContain('a.txt:6');
    await app.type('分栏里的批注');
    await app.press('Control+Enter');
    await app.waitFor(`document.querySelector('.ann-note .ann-note-body')?.textContent === '分栏里的批注'`, { message: '行下出现批注摘要' });
    const list = await app.eval<Array<{ side: string; start: number; end: number }>>(
      `window.panelApi.annotations.list(${q(sid)}).then(r => r.items)`);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ side: 'new', start: 6, end: 6 });
    const bar = await app.eval<string>(`(() => {
      const row = document.querySelector('.chg-diff-scroll .chg-ln.ann-has');
      return row ? getComputedStyle(row.querySelector('.chg-half.r .chg-no')).boxShadow : '';
    })()`);
    expect(bar).toContain('inset');
    await app.shot('split-annotation');
  });

  it('偏好重启后保留', async () => {
    await app.restart();
    expect(await pref()).toBe('split');
    await app.viewport(WIDE_VIEW);
    const id = await createSessionViaForm(app, '分栏重启', repo);
    await waitOutput(app, id, 'mock-claude 已启动');
    expect(await app.postHook(id, { hook_event_name: 'Stop' })).toBe(200);
    await app.until(async () => (await app.session(id))?.changes?.files === 6, { timeout: 20_000, message: '重启后改动摘要为 6 个文件' });
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    await switchChangesScope(app, 'repo');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 6`, { message: '改动列表 6 行' });
    await select('a.txt');
    expect(await isSplit()).toBe(true);
    expect(await app.eval(`document.querySelector('.chg-view-seg [data-view=split]').classList.contains('on')`)).toBe(true);
    expect(app.exceptions()).toEqual([]);
  });
});
