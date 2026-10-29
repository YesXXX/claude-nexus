import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, ipcMain: { handle: () => undefined } }));

import { EditorConfigStore } from '../src/main/editor-config';
import { EDITOR_COMMAND_MAX } from '../src/main/editor-launch';

function tmpDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeStore() {
  const dir = tmpDir('panel-edcfg-');
  const file = path.join(dir, 'editor.json');
  return { dir, file, store: new EditorConfigStore(file) };
}

describe('EditorConfigStore', () => {
  it('未配置时为空串；合法命令校验通过后保存并可重新读入', () => {
    const { file, store } = makeStore();
    expect(store.load()).toBeUndefined();
    expect(store.command()).toBe('');

    expect(store.set('code -g {file}:{line}')).toBe('');
    expect(store.command()).toBe('code -g {file}:{line}');

    // 引号路径 + 多个占位符也合法；换行折成空格、首尾空白去掉
    expect(store.set('  "C:\\Program Files\\IDE\\idea.exe" --line {line} {file}\r\n')).toBe('');
    expect(store.command()).toBe('"C:\\Program Files\\IDE\\idea.exe" --line {line} {file}');

    const again = new EditorConfigStore(file);
    again.load();
    expect(again.command()).toBe(store.command());
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(1);
  });

  it('空串清除配置且不做占位符校验', () => {
    const { store } = makeStore();
    expect(store.set('code {file}')).toBe('');
    expect(store.set('   ')).toBe('');
    expect(store.command()).toBe('');
  });

  it('非法输入给出错误且不落盘', () => {
    const { file, store } = makeStore();
    expect(store.set(42)).toBe('参数无效');
    expect(store.set('code {file} ' + 'x'.repeat(EDITOR_COMMAND_MAX))).toContain('命令过长');
    expect(store.set('code\x01 {file}')).toContain('控制字符');
    expect(store.set('code "unclosed {file}')).toContain('双引号没有闭合');
    expect(store.set('code {line}')).toContain('{file}');
    expect(store.command()).toBe('');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('文件损坏时备份为 .bak-* 并按未配置处理', () => {
    const { dir, file, store } = makeStore();
    fs.writeFileSync(file, 'not-json{{{');
    store.load();
    expect(store.command()).toBe('');
    expect(fs.existsSync(file)).toBe(false);
    const baks = fs.readdirSync(dir).filter(f => f.startsWith('editor.json.bak-'));
    expect(baks).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, baks[0]), 'utf8')).toBe('not-json{{{');
    // 损坏后保存新的配置照常工作
    expect(store.set('code {file}')).toBe('');
  });

  it('command 字段不是字符串时同样按损坏处理', () => {
    const { file, store } = makeStore();
    fs.writeFileSync(file, JSON.stringify({ version: 1, command: 7 }));
    store.load();
    expect(store.command()).toBe('');
    expect(fs.existsSync(file)).toBe(false);
  });
});
