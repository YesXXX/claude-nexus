import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { useApp } from './harness';
import { createSessionViaForm, mkWorkDir, waitOutput } from './fixtures';

/** 当前 html 上的皮肤与计算后的外框底色 */
const SKIN_STATE = `(() => ({
  skin: document.documentElement.dataset.skin ?? '',
  chrome: getComputedStyle(document.documentElement).getPropertyValue('--chrome').trim(),
}))()`;

/** 详情区可见终端的 xterm 视口底色（xterm 按主题 background 内联到 .xterm-viewport） */
const TERM_BG = `(() => {
  const vp = [...document.querySelectorAll('#main-pane .xterm-viewport')].find(e => e.getClientRects().length > 0);
  return vp ? getComputedStyle(vp).backgroundColor : '';
})()`;

describe('换肤', () => {
  const app = useApp();
  const file = () => path.join(app.home, 'appearance.json');

  it('首次启动为石墨，不创建偏好文件', async () => {
    await app.waitVisible('#main-empty');
    expect(await app.eval(SKIN_STATE)).toEqual({ skin: 'graphite', chrome: '#0e0e0e' });
    expect(await app.eval(`window.panelApi.appearance.get()`)).toEqual({ skin: 'graphite' });
    expect(fs.existsSync(file())).toBe(false);
  });

  it('IPC 不接受清单以外的皮肤', async () => {
    expect(await app.eval(`window.panelApi.appearance.set('light')`)).toEqual({ ok: false, skin: 'graphite' });
    expect(fs.existsSync(file())).toBe(false);
  });

  it('设置页「外观」点卡片即时换肤，已打开的终端跟着换色，偏好落盘', async () => {
    const id = await createSessionViaForm(app, '换肤终端', mkWorkDir(app, 'skin-term'));
    await waitOutput(app, id, 'mock-claude 已启动');
    await app.waitFor(`${TERM_BG} !== ''`, { message: '终端已渲染' });
    expect(await app.eval(TERM_BG)).toBe('rgb(13, 13, 13)');

    await app.blur();
    await app.press('Control+Comma');
    await app.waitVisible('#settings-skins');
    expect(await app.text('#settings-nav .set-nav-i.on')).toBe('外观');
    expect(await app.eval(`[...document.querySelectorAll('#settings-skins .skin-card')].map(c => c.dataset.skin)`))
      .toEqual(['graphite', 'midnight', 'warm']);
    expect(await app.eval(`document.querySelector('#settings-skins .skin-card.on')?.dataset.skin`)).toBe('graphite');

    await app.click('#settings-skins .skin-card[data-skin="warm"]');
    await app.waitFor(`document.documentElement.dataset.skin === 'warm'`, { message: '切到暖灰' });
    expect(await app.eval(SKIN_STATE)).toEqual({ skin: 'warm', chrome: '#161412' });
    expect(await app.eval(`document.querySelector('#settings-skins .skin-card.on')?.dataset.skin`)).toBe('warm');
    await app.until(() => fs.existsSync(file()) && JSON.parse(fs.readFileSync(file(), 'utf8')).skin === 'warm',
      { message: 'appearance.json 写入 warm' });
    await app.shot('skin-warm-settings');

    await app.press('Escape');
    await app.waitHidden('#settings-page');
    await app.waitFor(`${TERM_BG} === 'rgb(20, 18, 16)'`, { message: '终端底色换成暖灰' });
  });

  it('命令面板切换皮肤：当前皮肤置灰，选另一套即时生效', async () => {
    await app.blur();
    await app.press('Control+K');
    await app.waitVisible('#palette-backdrop');
    await app.fill('#palette-input', '切换皮肤');
    await app.waitFor(`document.querySelectorAll('#palette-list .pal-i').length === 3`, { message: '列出三套皮肤' });
    const rows = await app.eval<Array<[string, boolean]>>(`[...document.querySelectorAll('#palette-list .pal-i')]
      .map(r => [r.querySelector('.pt').textContent.trim(), r.classList.contains('off')])`);
    expect(rows).toEqual([['切换皮肤：石墨', false], ['切换皮肤：夜蓝', false], ['切换皮肤：暖灰', true]]);

    await app.fill('#palette-input', '切换皮肤：夜蓝');
    await app.waitFor(`document.querySelector('#palette-list .pal-i.on .pt')?.textContent === '切换皮肤：夜蓝'`, { message: '选中夜蓝' });
    await app.press('Enter');
    await app.waitFor(`document.documentElement.dataset.skin === 'midnight'`, { message: '切到夜蓝' });
    await app.waitFor(`${TERM_BG} === 'rgb(10, 14, 21)'`, { message: '终端底色换成夜蓝' });
    await app.until(() => JSON.parse(fs.readFileSync(file(), 'utf8')).skin === 'midnight', { message: 'appearance.json 写入 midnight' });
    await app.shot('skin-midnight');
  });

  // 渲染层脚本不写初始 data-skin，重启后能读到所选值说明是 preload 在页面脚本之前设好的
  it('重启后沿用所选皮肤', async () => {
    await app.restart();
    await app.waitVisible('#app');
    expect(await app.eval(SKIN_STATE)).toEqual({ skin: 'midnight', chrome: '#0b0f17' });
    expect(app.logs()).not.toContain('外观偏好文件损坏');
  });

  it('偏好文件损坏时备份并回退石墨', async () => {
    const f = file();   // 两次启动之间实例不在，先记下路径
    await app.restart({ between: () => fs.writeFileSync(f, '{broken') });
    await app.waitVisible('#app');
    expect(await app.eval(SKIN_STATE)).toEqual({ skin: 'graphite', chrome: '#0e0e0e' });
    expect(fs.readdirSync(app.home).some(n => n.startsWith('appearance.json.bak-'))).toBe(true);
    await app.until(() => app.logs().includes('外观偏好文件损坏'), { message: '日志记录了损坏备份' });
  });
});
