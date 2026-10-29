import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createGitRunner } from '../src/main/git-runner';
import { normalizeRepoKey, resolveRepoKey, VerifyConfigStore } from '../src/main/verify-config';
import { workspaceFingerprint } from '../src/main/verify-exec';
import { sanitizeVerifyConfig, sanitizeVerifyGlobal, verifyFailText } from '../src/shared/verify-types';

function tmpDir(prefix = 'panel-vcfg-'): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function initRepo(): string {
  const dir = tmpDir('panel-vrepo-');
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@example.com');
  sh(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  sh(dir, 'add', 'a.txt');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('sanitizeVerifyConfig', () => {
  it('规范化命令与超时，缺省开启与跳过未变化', () => {
    const r = sanitizeVerifyConfig({ command: '  npm test  ', timeoutSec: 5 });
    expect(r).toEqual({ ok: true, value: { command: 'npm test', enabled: true, timeoutSec: 10, skipUnchanged: true } });
    const r2 = sanitizeVerifyConfig({ command: 'x', timeoutSec: 99999, enabled: false, skipUnchanged: false, setupCommand: 'npm ci' });
    expect(r2.ok && r2.value).toEqual({
      command: 'x', enabled: false, timeoutSec: 3600, skipUnchanged: false, setupCommand: 'npm ci', setupTimeoutSec: 900,
    });
  });

  it('拒绝空命令、多行命令与超长命令', () => {
    expect(sanitizeVerifyConfig({ command: '  ' })).toEqual({ ok: false, error: '验证命令不能为空' });
    expect(sanitizeVerifyConfig({ command: 'a\nb' }).ok).toBe(false);
    expect(sanitizeVerifyConfig({ command: 'a', setupCommand: 'b\r\nc' }).ok).toBe(false);
    expect(sanitizeVerifyConfig({ command: 'x'.repeat(2001) }).ok).toBe(false);
    expect(sanitizeVerifyConfig(null).ok).toBe(false);
  });

  it('全局设置夹到合法范围', () => {
    expect(sanitizeVerifyGlobal({ maxConcurrent: 9, notifyOnFail: false })).toEqual({ maxConcurrent: 4, notifyOnFail: false });
    expect(sanitizeVerifyGlobal('bad')).toEqual({ maxConcurrent: 2, notifyOnFail: true });
  });

  it('未通过说明含退出码或原因、用时与命令', () => {
    expect(verifyFailText({ status: 'failed', command: 'npm test', exitCode: 2, durationMs: 3400 }))
      .toBe('退出码 2 · 用时 3 秒 · npm test');
    expect(verifyFailText({ status: 'timeout', command: 'x', message: '验证超时（10 秒）' })).toBe('验证超时（10 秒） · x');
  });
});

describe('VerifyConfigStore', () => {
  it('增删改并持久化，全局设置合并保存', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'verify.json');
    const store = new VerifyConfigStore(file);
    expect(store.load()).toBeUndefined();
    expect(store.get('k')).toBeNull();
    const r = store.set('k', { command: 'npm test' });
    expect(r.ok).toBe(true);
    expect(store.setGlobal({ maxConcurrent: 3 })).toEqual({ maxConcurrent: 3, notifyOnFail: true });
    const again = new VerifyConfigStore(file);
    again.load();
    expect(again.get('k')?.command).toBe('npm test');
    expect(again.global().maxConcurrent).toBe(3);
    expect(again.set('k', { command: '' })).toEqual({ ok: false, error: '验证命令不能为空' });
    expect(again.set('k', null)).toEqual({ ok: true, config: null });
    const third = new VerifyConfigStore(file);
    third.load();
    expect(third.get('k')).toBeNull();
  });

  it('文件损坏时改名备份并以空配置启动', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'verify.json');
    fs.writeFileSync(file, '{ not json');
    const store = new VerifyConfigStore(file, () => 42);
    const bak = store.load();
    expect(bak).toBe(`${file}.bak-42`);
    expect(fs.existsSync(bak!)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(store.global()).toEqual({ maxConcurrent: 2, notifyOnFail: true });
  });

  it('跳过不合法的单条配置', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'verify.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, global: {}, repos: { a: { command: 'ok' }, b: { command: '' } } }));
    const store = new VerifyConfigStore(file);
    expect(store.load()).toBeUndefined();
    expect(store.get('a')?.command).toBe('ok');
    expect(store.get('b')).toBeNull();
  });
});

describe('resolveRepoKey', () => {
  const git = createGitRunner();

  it('仓库子目录与其工作区都解析到主仓库根', async () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, 'sub'));
    const fromSub = await resolveRepoKey(git, path.join(repo, 'sub'));
    expect(fromSub.isRepo).toBe(true);
    expect(fromSub.key).toBe(normalizeRepoKey(repo));
    const wt = path.join(tmpDir('panel-vwt-'), 'wt');
    sh(repo, 'worktree', 'add', '-q', '-b', 'feat', wt);
    const fromWt = await resolveRepoKey(git, wt);
    expect(fromWt.key).toBe(normalizeRepoKey(repo));
  }, 30000);

  it('已知 repoRoot 直接使用；非仓库目录按目录本身', async () => {
    const plain = tmpDir('panel-vplain-');
    expect((await resolveRepoKey(git, plain, 'C:/x/Repo')).key).toBe(normalizeRepoKey('C:/x/Repo'));
    const r = await resolveRepoKey(git, plain);
    expect(r).toEqual({ key: normalizeRepoKey(plain), root: path.resolve(plain), isRepo: false });
  });
});

describe('workspaceFingerprint', () => {
  const git = createGitRunner();

  it('工作区不变时相同，修改或新增文件后变化，非仓库为 null', async () => {
    const repo = initRepo();
    const a = await workspaceFingerprint(git, repo);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(await workspaceFingerprint(git, repo)).toBe(a);
    fs.writeFileSync(path.join(repo, 'new.txt'), 'n');
    const b = await workspaceFingerprint(git, repo);
    expect(b).not.toBe(a);
    fs.writeFileSync(path.join(repo, 'new.txt'), 'nn');
    expect(await workspaceFingerprint(git, repo)).not.toBe(b);
    expect(await workspaceFingerprint(git, tmpDir('panel-vplain-'))).toBeNull();
  }, 30000);
});
