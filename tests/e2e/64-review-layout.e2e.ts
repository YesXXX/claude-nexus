import { describe, it, expect } from 'vitest';
import { useApp } from './harness';
import { createSessionViaForm, initGitRepo, switchChangesScope, waitOutput, writeFiles } from './fixtures';

/**
 * 改动页版面：切到改动标签自动收起属性面板、回终端恢复；专注审阅（F / Esc）；
 * 统一视图自动换行（W）；收起文件列表（B）与拖动分隔条调宽；diff 标题的上一个 / 下一个与位置。
 */

const LONG = Array.from({ length: 120 }, (_, i) => `token${i}`).join(' ');
const WIDE_VIEW = 1700;

describe('改动页版面', () => {
  const app = useApp();
  let sid = '';

  const appHas = (cls: string) => app.eval<boolean>(`document.querySelector('#app').classList.contains(${JSON.stringify(cls)})`);
  const pos = () => app.text('.chg-diff-head .chg-pos');
  const addr = () => app.eval<string>(`(document.querySelector('.chg-diff-path')?.dataset.addr ?? '').replace(/\\\\/g, '/')`);
  const stored = (key: string) => app.eval<string | null>(`localStorage.getItem(${JSON.stringify(key)})`);
  const listW = () => app.eval<number>(`Math.round(document.querySelector('.chg-list').getBoundingClientRect().width)`);

  it('准备仓库与会话', async () => {
    const repo = initGitRepo(app, 'proj-review', { 'a.txt': 'short\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    writeFiles(repo, { 'a.txt': `short\n${LONG}\n`, 'b.txt': 'b2\n', 'c.txt': 'c2\n' });
    await app.viewport(WIDE_VIEW);
    sid = await createSessionViaForm(app, '版面用例', repo);
    await waitOutput(app, sid, 'mock-claude 已启动');
    expect(await app.postHook(sid, { hook_event_name: 'Stop' })).toBe(200);
    await app.until(async () => (await app.session(sid))?.changes?.files === 3, { timeout: 20_000, message: '改动摘要为 3 个文件' });
    await app.waitVisible('#inspector');
  });

  it('切到改动标签自动收起属性面板，可临时展开；回到终端恢复原状', async () => {
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    await app.waitHidden('#inspector');
    expect(await appHas('no-inspector')).toBe(true);
    expect(await app.eval(`document.querySelector('#btn-inspector').classList.contains('on')`)).toBe(false);

    await app.click('#btn-inspector');
    await app.waitVisible('#inspector');
    await app.click('#btn-inspector');
    await app.waitHidden('#inspector');

    await app.focus('.chg-list');
    await app.press('Escape');
    await app.waitVisible('#term-card');
    await app.waitVisible('#inspector');
    expect(await app.eval(`document.querySelector('#btn-inspector').classList.contains('on')`)).toBe(true);

    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    await app.waitHidden('#inspector');
    await switchChangesScope(app, 'repo');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 3`, { message: '改动列表 3 行' });
  });

  it('diff 标题显示位置，上一个 / 下一个与 J / K 切换文件', async () => {
    await app.click('.chg-list .chg-row[data-index="0"]');
    await app.waitFor(`(document.querySelector('.chg-diff-path')?.dataset.addr ?? '').endsWith('a.txt')`, { message: '选中 a.txt' });
    expect(await pos()).toBe('1 / 3');
    expect(await app.eval(`document.querySelector('.chg-prev').disabled`)).toBe(true);
    expect(await app.eval(`document.querySelector('.chg-diff-head .chg-head-file').textContent`)).toBe('a.txt');

    await app.click('.chg-next');
    await app.waitFor(`(document.querySelector('.chg-diff-path')?.dataset.addr ?? '').endsWith('b.txt')`, { message: '下一个到 b.txt' });
    expect(await pos()).toBe('2 / 3');

    await app.focus('.chg-diff-scroll');
    await app.press('j');
    await app.until(async () => (await addr()).endsWith('/c.txt'), { message: 'J 切到 c.txt' });
    expect(await pos()).toBe('3 / 3');
    expect(await app.eval(`document.querySelector('.chg-next').disabled`)).toBe(true);
    await app.press('k');
    await app.until(async () => (await addr()).endsWith('/b.txt'), { message: 'K 回到 b.txt' });
    await app.click('.chg-list .chg-row[data-index="0"]');
    await app.waitFor(`(document.querySelector('.chg-diff-path')?.dataset.addr ?? '').endsWith('a.txt')
      && !!document.querySelector('.chg-diff-scroll .chg-ln.add')`, { message: '回到 a.txt' });
  });

  it('W 开关自动换行：长行折行不再横向滚动，续行标出 ↩', async () => {
    expect(await stored('nexus.diff.wrap')).toBeNull();
    const overflow = () => app.eval<boolean>(`(() => { const sc = document.querySelector('.chg-diff-scroll');
      return sc.scrollWidth > sc.clientWidth + 1; })()`);
    expect(await overflow()).toBe(true);
    await app.focus('.chg-list');
    await app.press('w');
    await app.waitFor(`document.querySelector('#changes-host').classList.contains('chg-wrap')`, { message: '开启换行' });
    expect(await stored('nexus.diff.wrap')).toBe('1');
    expect(await overflow()).toBe(false);
    const marks = await app.eval<{ long: number; short: number }>(`(() => {
      const rows = [...document.querySelectorAll('.chg-diff-scroll .chg-ln.add')];
      const h = r => parseFloat(getComputedStyle(r.querySelector('.chg-sign'), '::after').height) || 0;
      const long = rows.find(r => r.querySelector('.chg-txt').textContent.length > 200);
      const short = [...document.querySelectorAll('.chg-diff-scroll .chg-ln')].find(r => r.querySelector('.chg-txt')?.textContent === 'short');
      return { long: long ? h(long) : -1, short: short ? h(short) : -1 };
    })()`);
    expect(marks.long).toBeGreaterThan(0);
    expect(marks.short).toBe(0);
    expect(await app.eval(`document.querySelector('.chg-wrap-btn').classList.contains('on')`)).toBe(true);
    await app.shot('review-wrap');

    await app.press('w');
    await app.waitFor(`!document.querySelector('#changes-host').classList.contains('chg-wrap')`, { message: '关闭换行' });
    expect(await stored('nexus.diff.wrap')).toBe('0');
    expect(await overflow()).toBe(true);
  });

  it('B 收起 / 展开文件列表，拖动分隔条调宽并保存，双击恢复默认', async () => {
    expect(await listW()).toBe(240);
    await app.press('b');
    await app.waitHidden('.chg-list');
    expect(await stored('nexus.changes.listCollapsed')).toBe('1');
    expect(await app.eval(`document.querySelector('.chg-list-toggle').classList.contains('on')`)).toBe(false);
    await app.click('.chg-list-toggle');
    await app.waitVisible('.chg-list');
    expect(await stored('nexus.changes.listCollapsed')).toBe('0');

    await app.eval(`(() => {
      const sp = document.querySelector('.chg-splitter');
      const r = sp.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + 40;
      const ev = (type, cx) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1, clientX: cx, clientY: y, pointerType: 'mouse', isPrimary: true });
      sp.dispatchEvent(ev('pointerdown', x));
      sp.dispatchEvent(ev('pointermove', x + 60));
      sp.dispatchEvent(ev('pointermove', x + 100));
      sp.dispatchEvent(ev('pointerup', x + 100));
      return true;
    })()`);
    await app.until(async () => (await listW()) === 340, { message: '列表拖到 340px' });
    expect(await stored('nexus.changes.listW')).toBe('340');
    await app.eval(`document.querySelector('.chg-splitter').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await app.until(async () => (await listW()) === 240, { message: '双击恢复 240px' });
  });

  it('F 进入专注审阅，Esc 先退出专注再返回终端；离开改动页即退出专注', async () => {
    await app.focus('.chg-list');
    await app.press('f');
    await app.until(() => appHas('review-focus'), { message: '进入专注审阅' });
    await app.waitHidden('#list-col');
    await app.waitHidden('#inspector');
    expect(await app.text('.chg-focus-btn .chg-focus-text')).toBe('退出专注');
    await app.shot('review-focus');

    await app.press('Escape');
    await app.until(async () => !(await appHas('review-focus')), { message: 'Esc 退出专注' });
    await app.waitVisible('#list-col');
    expect(await app.visible('#changes-host')).toBe(true);
    expect(await app.text('.chg-focus-btn .chg-focus-text')).toBe('专注审阅');

    await app.press('f');
    await app.until(() => appHas('review-focus'), { message: '再次进入专注审阅' });
    await app.press('Control+Shift+D');
    await app.waitVisible('#term-card');
    expect(await appHas('review-focus')).toBe(false);
    await app.waitVisible('#list-col');
    await app.waitVisible('#inspector');
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    expect(await appHas('review-focus')).toBe(false);
  });
});
