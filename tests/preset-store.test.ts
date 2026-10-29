import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, ipcMain: { handle: () => undefined } }));

import { PresetStore } from '../src/main/preset-store';
import {
  presetSummary,
  sanitizePresetInput,
  sortPresets,
  PRESET_MAX_COUNT,
  PRESET_NAME_MAX,
  type SessionPreset,
} from '../src/shared/preset';

function tmpDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeStore(start = 1000) {
  let t = start;
  const dir = tmpDir('panel-preset-');
  const file = path.join(dir, 'presets.json');
  return { dir, file, store: new PresetStore(file, { now: () => t++ }) };
}

describe('sanitizePresetInput', () => {
  it('规范化名称、目录与提示词；worktree 只认真值，分支字段只在勾选时保留', () => {
    const r = sanitizePresetInput({
      name: '  日常开发  ', cwd: ' D:\\proj ', worktree: 'yes' as unknown as boolean,
      initialPrompt: 'a\r\nb\rc\n', branch: ' feat/x ', baseRef: ' main ',
    });
    expect(r).toEqual({
      ok: true,
      value: { name: '日常开发', cwd: 'D:\\proj', worktree: false, initialPrompt: 'a\nb\nc\n' },
    });

    const wt = sanitizePresetInput({ name: 'n', cwd: 'c', worktree: true, branch: ' b ', baseRef: '' });
    expect(wt.ok && wt.value.branch).toBe('b');
    expect(wt.ok && wt.value.baseRef).toBeUndefined();
    // 未勾选独立工作区时分支字段忽略
    const plain = sanitizePresetInput({ name: 'n', cwd: 'c', branch: 'b' });
    expect(plain.ok && plain.value.branch).toBeUndefined();
  });

  it('名称、目录、提示词的空值与超长都报错', () => {
    const err = (r: ReturnType<typeof sanitizePresetInput>): string => (r.ok ? '' : r.error);
    expect(sanitizePresetInput(null)).toEqual({ ok: false, error: '参数无效' });
    expect(err(sanitizePresetInput({ name: ' ', cwd: 'c' }))).toBe('预设名称不能为空');
    expect(err(sanitizePresetInput({ name: 'x'.repeat(PRESET_NAME_MAX + 1), cwd: 'c' }))).toContain('预设名称过长');
    expect(err(sanitizePresetInput({ name: 'n', cwd: '' }))).toBe('工作目录不能为空');
    const long = sanitizePresetInput({ name: 'n', cwd: 'c', initialPrompt: 'x'.repeat(100_001) });
    expect(err(long)).toContain('首条提示词过长');
  });
});

describe('PresetStore', () => {
  it('新建、改名更新、删除并持久化', () => {
    const { file, store } = makeStore();
    expect(store.load()).toBeUndefined();
    const a = store.save({ name: '开发', cwd: 'D:\\proj', initialPrompt: 'p1' });
    expect(a.ok && a.preset).toMatchObject({ name: '开发', cwd: 'D:\\proj', useCount: 0, initialPrompt: 'p1' });

    store.touch(a.ok ? a.preset.id : '');
    const b = store.save({ id: a.ok ? a.preset.id : '', name: '开发2', cwd: 'D:\\other', worktree: true, branch: 'feat/x' });
    expect(b.ok && b.preset.id).toBe(a.ok ? a.preset.id : '');
    // 修改保留创建时间与使用计数
    expect(b.ok && b.preset.createdAt).toBe(a.ok ? a.preset.createdAt : -1);
    expect(b.ok && b.preset.useCount).toBe(1);
    expect(b.ok && b.preset.initialPrompt).toBeUndefined();

    const reloaded = new PresetStore(file);
    reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]).toMatchObject({ name: '开发2', cwd: 'D:\\other', worktree: true, branch: 'feat/x' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(1);

    expect(store.remove(b.ok ? b.preset.id : '')).toBe(true);
    expect(store.remove(b.ok ? b.preset.id : '')).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('touch 计数并让最近使用的排在前面；列表是副本', () => {
    const { store } = makeStore();
    const a = store.save({ name: 'a', cwd: 'c1' });
    store.save({ name: 'b', cwd: 'c2' });
    // 都未使用时按更新时间倒序：b 后保存在前
    expect(store.list().map(p => p.name)).toEqual(['b', 'a']);
    const id = a.ok ? a.preset.id : '';
    expect(store.touch(id)).toMatchObject({ useCount: 1, lastUsedAt: expect.any(Number) });
    expect(store.list().map(p => p.name)).toEqual(['a', 'b']);
    expect(store.touch('missing')).toBeUndefined();
    store.list()[0].name = 'x';
    expect(store.list()[0].name).toBe('a');
  });

  it('文件损坏时备份为 .bak-* 并以空列表启动；单条不合规的跳过', () => {
    const { file, store } = makeStore();
    fs.writeFileSync(file, '{ 不是 json');
    const bak = store.load();
    expect(bak).toBeDefined();
    expect(fs.existsSync(file)).toBe(false);
    expect(path.basename(bak!)).toMatch(/^presets\.json\.bak-/);
    expect(fs.readFileSync(bak!, 'utf8')).toBe('{ 不是 json');
    expect(store.list()).toEqual([]);
    expect(store.save({ name: 'n', cwd: 'c' }).ok).toBe(true);

    const m = makeStore();
    fs.writeFileSync(m.file, JSON.stringify({ version: 1, presets: 'x' }));
    expect(m.store.load()).toBeDefined();

    const s = makeStore();
    fs.writeFileSync(s.file, JSON.stringify({
      version: 1,
      presets: [
        { id: 'ok', name: 'n', cwd: 'c', worktree: false, createdAt: 1, updatedAt: 2, useCount: -3, branch: 'b', initialPrompt: '' },
        { id: '', name: 'bad', cwd: 'c', worktree: false, createdAt: 1, updatedAt: 1, useCount: 0 },
        null,
      ],
    }));
    expect(s.store.load()).toBeUndefined();
    // 分支保留、空的提示词丢弃、负的计数归零
    expect(s.store.list()).toEqual([
      { id: 'ok', name: 'n', cwd: 'c', worktree: false, createdAt: 1, updatedAt: 2, useCount: 0, branch: 'b' },
    ]);
  });

  it('超过数量上限拒绝新建', () => {
    const { store } = makeStore();
    for (let i = 0; i < PRESET_MAX_COUNT; i++) {
      expect(store.save({ name: `p${i}`, cwd: 'c' }).ok).toBe(true);
    }
    expect(store.save({ name: 'one more', cwd: 'c' })).toEqual({
      ok: false, error: `预设数量已达上限（${PRESET_MAX_COUNT} 个）`,
    });
    // 修改已有的不受上限影响
    const first = store.list().at(-1)!;
    expect(store.save({ id: first.id, name: '改名', cwd: 'c' }).ok).toBe(true);
  });
});

describe('sortPresets 与 presetSummary', () => {
  const base = { cwd: 'c', worktree: false, createdAt: 1, updatedAt: 1, useCount: 0 };

  it('最近使用的在前，从未使用的按更新时间倒序', () => {
    const list: SessionPreset[] = [
      { id: '1', name: 'a', ...base, updatedAt: 5 },
      { id: '2', name: 'b', ...base, updatedAt: 9, lastUsedAt: 100 },
      { id: '3', name: 'c', ...base, updatedAt: 7, lastUsedAt: 50 },
      { id: '4', name: 'd', ...base, updatedAt: 8 },
    ];
    expect(sortPresets(list).map(p => p.id)).toEqual(['2', '3', '4', '1']);
  });

  it('摘要拼目录与标记并截断', () => {
    const p: SessionPreset = { ...base, id: 'x', name: 'n', cwd: 'D:\\p', worktree: true, branch: 'b', initialPrompt: 'hi' };
    expect(presetSummary(p)).toBe('D:\\p · 独立工作区 · 带首条提示词');
    expect(presetSummary({ ...p, worktree: false, initialPrompt: undefined })).toBe('D:\\p');
    expect(presetSummary({ ...p, cwd: 'x'.repeat(200) }, 20)).toHaveLength(21);
    expect(presetSummary({ ...p, cwd: 'x'.repeat(200) }, 20).endsWith('…')).toBe(true);
  });
});
