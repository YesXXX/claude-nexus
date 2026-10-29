import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createGitRunner, gitErrorText, gitOk, topInDirForm } from '../src/main/git-runner';

describe('git-runner', () => {
  const git = createGitRunner();

  it('成功执行并返回 stdout 与耗时', async () => {
    const r = await git.run(process.cwd(), ['--version']);
    expect(gitOk(r)).toBe(true);
    expect(r.stdout).toMatch(/^git version/);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('非仓库目录返回非零退出码与可读错误', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-gitrun-'));
    const r = await git.run(dir, ['rev-parse', '--show-toplevel']);
    expect(gitOk(r)).toBe(false);
    expect(r.code).not.toBe(0);
    expect(gitErrorText(r)).toMatch(/not a git repository/i);
  });

  it('找不到 git 可执行文件时标记 notFound', async () => {
    const missing = createGitRunner('git-definitely-missing-xyz');
    const r = await missing.run(process.cwd(), ['--version']);
    expect(r.notFound).toBe(true);
    expect(gitErrorText(r)).toBe('未检测到 git');
  });

  it('env 选项追加到子进程环境', async () => {
    const r = await git.run(process.cwd(), ['var', 'GIT_EDITOR'], { env: { GIT_EDITOR: 'panel-test-editor' } });
    expect(gitOk(r)).toBe(true);
    expect(r.stdout.trim()).toBe('panel-test-editor');
  });

  it('input 写入 stdin：hash-object --stdin 得到预期 sha', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-gitrun-'));
    const r = await git.run(dir, ['hash-object', '--stdin'], { input: 'hello\n' });
    expect(gitOk(r)).toBe(true);
    // 与 `echo hello | git hash-object --stdin` 一致
    expect(r.stdout.trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('GIT_MERGE_AUTOEDIT=no 让合并不打开编辑器', async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-gitrun-')));
    const sh = (...a: string[]) => git.run(dir, a);
    await sh('init', '-q', '-b', 'main');
    await sh('config', 'user.email', 't@t');
    await sh('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    await sh('add', '.');
    await sh('commit', '-q', '-m', 'init');
    await sh('checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    await sh('add', '.');
    await sh('commit', '-q', '-m', 'side');
    await sh('checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
    await sh('add', '.');
    await sh('commit', '-q', '-m', 'main');
    // 编辑器设成一个必然失败的命令：若合并尝试打开编辑器就会失败
    const r = await git.run(dir, ['-c', 'core.editor=false', 'merge', '--no-ff', 'side'], {
      env: { GIT_MERGE_AUTOEDIT: 'no' }, timeoutMs: 30000,
    });
    expect(gitOk(r)).toBe(true);
    const log = await sh('log', '-1', '--format=%s');
    expect(log.stdout.trim()).toMatch(/Merge branch 'side'/);
  });

  it('okCodes 允许把指定退出码视为成功', () => {
    const r = { code: 1, stdout: '', stderr: '', ms: 0, notFound: false, timedOut: false };
    expect(gitOk(r)).toBe(false);
    expect(gitOk(r, [0, 1])).toBe(true);
  });

  it('topInDirForm：经过链接的目录得到同一写法的仓库根，dir 已在根下时原样用 git 的结果', () => {
    const real = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-gitrun-')));
    fs.mkdirSync(path.join(real, 'repo', 'sub', 'deep'), { recursive: true });
    const link = path.join(real, 'alias');
    fs.symlinkSync(path.join(real, 'repo'), link, 'junction');
    const top = path.join(real, 'repo');
    expect(topInDirForm(path.join(link, 'sub', 'deep'), top)).toBe(link);
    expect(topInDirForm(link, top)).toBe(link);
    expect(topInDirForm(path.join(top, 'sub'), top)).toBe(top);
    // 换算不出（dir 不存在或不在仓库里）时退回 git 的结果
    expect(topInDirForm(path.join(real, 'missing'), top)).toBe(top);
    expect(topInDirForm(real, top)).toBe(top);
  });
});
