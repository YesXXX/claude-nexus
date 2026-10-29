import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, ipcMain: { handle: () => undefined } }));

import { createGitRunner } from '../src/main/git-runner';
import { formatChangedFiles, templateContext, TemplateStore } from '../src/main/template-store';
import { relativeToCwd } from '../src/main/ipc-templates';

function tmpDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function makeStore(dir = tmpDir('panel-tpl-'), start = 1000) {
  let t = start;
  const file = path.join(dir, 'templates.json');
  return { dir, file, store: new TemplateStore(file, { now: () => t++ }) };
}

describe('TemplateStore', () => {
  it('新建、修改、删除并持久化', () => {
    const { file, store } = makeStore();
    expect(store.load()).toBeUndefined();
    const a = store.save({ name: '审查', body: '审查 {{文件}}', description: '说明' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.template).toMatchObject({ name: '审查', body: '审查 {{文件}}', description: '说明', useCount: 0 });

    const b = store.save({ id: a.template.id, name: '审查2', body: '新正文' });
    expect(b.ok && b.template.id).toBe(a.template.id);
    expect(b.ok && b.template.description).toBeUndefined();
    expect(b.ok && b.template.createdAt).toBe(a.template.createdAt);
    expect(store.list()).toHaveLength(1);

    const reloaded = new TemplateStore(file);
    reloaded.load();
    expect(reloaded.list().map(t => t.name)).toEqual(['审查2']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(1);

    expect(store.remove(a.template.id)).toBe(true);
    expect(store.remove(a.template.id)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('不存在的 id 保存时按新建处理，非法输入返回错误', () => {
    const { store } = makeStore();
    const r = store.save({ id: 'nope', name: 'n', body: 'b' });
    expect(r.ok && r.template.id).not.toBe('nope');
    expect(store.save({ name: '', body: 'b' })).toEqual({ ok: false, error: '模板名称不能为空' });
  });

  it('touch 计数并让最近使用的排在前面', () => {
    const { store } = makeStore();
    const a = store.save({ name: 'a', body: '1' });
    store.save({ name: 'b', body: '2' });
    expect(store.list().map(t => t.name)).toEqual(['b', 'a']);
    const id = a.ok ? a.template.id : '';
    expect(store.touch(id)).toMatchObject({ useCount: 1 });
    expect(store.touch(id)).toMatchObject({ useCount: 2 });
    expect(store.list().map(t => t.name)).toEqual(['a', 'b']);
    expect(store.touch('missing')).toBeUndefined();
  });

  it('list 返回副本，修改不影响存储', () => {
    const { store } = makeStore();
    store.save({ name: 'a', body: '1' });
    store.list()[0].name = 'x';
    expect(store.list()[0].name).toBe('a');
  });

  it('文件损坏时备份为 .bak-* 并以空列表启动', () => {
    const { dir, file, store } = makeStore();
    fs.writeFileSync(file, '{ 不是 json');
    const bak = store.load();
    expect(bak).toBeDefined();
    expect(fs.existsSync(file)).toBe(false);
    expect(path.basename(bak!)).toMatch(/^templates\.json\.bak-/);
    expect(fs.readFileSync(bak!, 'utf8')).toBe('{ 不是 json');
    expect(store.list()).toEqual([]);
    expect(store.save({ name: 'n', body: 'b' }).ok).toBe(true);
    expect(fs.readdirSync(dir).filter(f => f.includes('.bak-'))).toHaveLength(1);
  });

  it('结构不对也按损坏处理；单条不合规的跳过', () => {
    const { file, store } = makeStore();
    fs.writeFileSync(file, JSON.stringify({ version: 1, templates: 'x' }));
    expect(store.load()).toBeDefined();

    const m = makeStore();
    fs.writeFileSync(m.file, JSON.stringify({
      version: 1,
      templates: [
        { id: 'ok', name: 'n', body: 'b', createdAt: 1, updatedAt: 2, useCount: -3 },
        { id: '', name: 'bad', body: 'b', createdAt: 1, updatedAt: 1 },
        null,
      ],
    }));
    expect(m.store.load()).toBeUndefined();
    expect(m.store.list()).toEqual([{ id: 'ok', name: 'n', body: 'b', createdAt: 1, updatedAt: 2, useCount: 0 }]);
  });
});

describe('formatChangedFiles', () => {
  it('超过上限时截断并注明总数', () => {
    expect(formatChangedFiles(['a', 'b'])).toBe('a\nb');
    const many = Array.from({ length: 52 }, (_, i) => `f${i}`);
    const out = formatChangedFiles(many).split('\n');
    expect(out).toHaveLength(51);
    expect(out[50]).toBe('等 52 个文件');
  });
});

describe('templateContext', () => {
  const now = new Date(2026, 9, 17, 10, 0).getTime();

  it('git 仓库：分支、项目、未提交文件', async () => {
    const root = tmpDir('panel-tplctx-');
    const repo = path.join(root, '示例项目');
    fs.mkdirSync(repo);
    sh(repo, 'init', '-q', '-b', 'feat/模板');
    sh(repo, 'config', 'user.email', 't@t');
    sh(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), '1\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(repo, 'a.txt'), '2\n');
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'sub', '新文件.md'), 'x\n');

    const ctx = await templateContext(createGitRunner(), { cwd: repo, now });
    expect(ctx.日期).toBe('2026-10-17');
    expect(ctx.目录).toBe(repo);
    expect(ctx.项目).toBe('示例项目');
    expect(ctx.分支).toBe('feat/模板');
    expect(ctx.改动文件?.split('\n').sort()).toEqual(['a.txt', 'sub/新文件.md']);

    const viaList = await templateContext(createGitRunner(), { cwd: repo, now, changedFiles: ['x.ts'], repoRoot: 'D:/r/主仓库' });
    expect(viaList.改动文件).toBe('x.ts');
    expect(viaList.项目).toBe('主仓库');

    sh(repo, 'checkout', '-q', '--detach');
    const detached = await templateContext(createGitRunner(), { cwd: repo, now });
    expect(detached.分支).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('非仓库目录只有目录、项目与日期；目录不存在时只有目录与日期', async () => {
    const dir = tmpDir('panel-tplplain-');
    const ctx = await templateContext(createGitRunner(), { cwd: dir, now });
    expect(ctx).toEqual({ 日期: '2026-10-17', 目录: dir, 项目: path.basename(dir) });
    const gone = path.join(dir, 'missing');
    expect(await templateContext(createGitRunner(), { cwd: gone, now })).toEqual({ 日期: '2026-10-17', 目录: gone });
  });
});

describe('relativeToCwd', () => {
  it('cwd 内给正斜杠相对路径，cwd 外给绝对路径', () => {
    const cwd = path.join(os.tmpdir(), 'proj');
    expect(relativeToCwd(cwd, path.join(cwd, 'src', 'a.ts'))).toEqual({ path: 'src/a.ts', absolute: false });
    const outside = path.join(os.tmpdir(), 'other', 'b.ts');
    expect(relativeToCwd(cwd, outside)).toEqual({ path: outside, absolute: true });
    expect(relativeToCwd(cwd, cwd)).toEqual({ path: cwd, absolute: true });
  });
});
