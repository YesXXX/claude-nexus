import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, ipcMain: { handle: () => undefined } }));

import { AppearanceStore } from '../src/main/appearance-store';
import { chromeOptions } from '../src/main/ipc-appearance';

function makeStore() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-appearance-')));
  const file = path.join(dir, 'appearance.json');
  return { dir, file, store: new AppearanceStore(file) };
}

describe('AppearanceStore', () => {
  it('没有文件时为默认皮肤石墨，且不创建文件', () => {
    const { file, store } = makeStore();
    store.load();
    expect(store.skin()).toBe('graphite');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('保存后落盘为 { version: 1, skin }，新实例能读回', () => {
    const { file, store } = makeStore();
    expect(store.set('midnight')).toBe(true);
    expect(store.skin()).toBe('midnight');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, skin: 'midnight' });
    const again = new AppearanceStore(file);
    again.load();
    expect(again.skin()).toBe('midnight');
  });

  it('不认识的 id 拒绝保存，当前皮肤与文件都不变', () => {
    const { file, store } = makeStore();
    store.set('warm');
    for (const bad of ['light', '', 42, null, { skin: 'warm' }]) expect(store.set(bad)).toBe(false);
    expect(store.skin()).toBe('warm');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).skin).toBe('warm');
  });

  it.each([
    ['不是 JSON', '{oops'],
    ['皮肤不认识', JSON.stringify({ version: 1, skin: 'light' })],
    ['缺字段', JSON.stringify({ version: 1 })],
  ])('文件损坏（%s）时备份为 .bak-<时间> 并回退默认皮肤', (_name, content) => {
    const { dir, file, store } = makeStore();
    fs.writeFileSync(file, content);
    store.load();
    expect(store.skin()).toBe('graphite');
    expect(fs.existsSync(file)).toBe(false);
    const baks = fs.readdirSync(dir).filter(n => n.startsWith('appearance.json.bak-'));
    expect(baks).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, baks[0]), 'utf8')).toBe(content);
  });
});

describe('chromeOptions', () => {
  it('按皮肤给出标题栏底色与系统按钮颜色', () => {
    expect(chromeOptions('graphite')).toEqual({ color: '#0e0e0e', symbolColor: '#a3a3a3' });
    expect(chromeOptions('midnight').color).toBe('#0b0f17');
    expect(chromeOptions('warm').color).toBe('#161412');
  });
});
