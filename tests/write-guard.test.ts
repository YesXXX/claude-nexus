import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { createGitRunner } from '../src/main/git-runner';
import { checkWritable, detectLock, lockKey, WriteGuard } from '../src/main/write-guard';
import type { Session } from '../src/shared/types';

function tmpRepo(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-wg-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, windowsHide: true });
  return dir;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('write-guard', () => {
  const guard = new WriteGuard(createGitRunner());

  it('同一仓库的任务串行，不同仓库并行', async () => {
    const order: string[] = [];
    const task = (name: string, ms: number) => async () => {
      order.push(`${name}+`);
      await sleep(ms);
      order.push(`${name}-`);
      return name;
    };
    const a = guard.withRepoLock('C:\\Repo\\.git', task('a1', 80));
    const b = guard.withRepoLock('c:/repo/.git/', task('a2', 10));
    const c = guard.withRepoLock('C:\\Other\\.git', task('b1', 10));
    expect(await Promise.all([a, b, c])).toEqual(['a1', 'a2', 'b1']);
    // a2 必须等 a1 结束；b1 不等 a1
    expect(order.indexOf('a2+')).toBeGreaterThan(order.indexOf('a1-'));
    expect(order.indexOf('b1-')).toBeLessThan(order.indexOf('a1-'));
  });

  it('前一个任务抛错不影响后续排队者', async () => {
    const failed = guard.withRepoLock('/x', async () => { throw new Error('boom'); });
    const next = guard.withRepoLock('/x', async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('ok');
  });

  it('主工作区与 worktree 共用同一个 common dir 键', async () => {
    const repo = tmpRepo();
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: repo, windowsHide: true });
    const wt = path.join(repo, '.claude', 'worktrees', 'w1');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'w1', wt], { cwd: repo, windowsHide: true });
    const k1 = await guard.commonDir(repo);
    const k2 = await guard.commonDir(wt);
    expect(k1).toBeDefined();
    expect(lockKey(k1!)).toBe(lockKey(k2!));
    expect(await guard.commonDir(os.tmpdir())).toBeUndefined();
  });

  it('手工放置 index.lock 后能检测到其路径', async () => {
    const repo = tmpRepo();
    const gitDir = path.join(repo, '.git');
    expect(detectLock(gitDir)).toBeUndefined();
    expect(await guard.findIndexLock(repo)).toBeUndefined();
    fs.writeFileSync(path.join(gitDir, 'index.lock'), '');
    expect(detectLock(gitDir)).toBe(path.join(gitDir, 'index.lock'));
    expect(lockKey((await guard.findIndexLock(repo))!)).toBe(lockKey(path.join(gitDir, 'index.lock')));
  });

  it('只读会话拒绝，忙碌只标记', () => {
    const s = { id: 's1', readOnly: false } as Session;
    expect(checkWritable(undefined, () => false).blocked).toBe('会话不存在');
    expect(checkWritable({ ...s, readOnly: true }, () => false).blocked).toMatch(/只能查看/);
    expect(checkWritable(s, () => true)).toEqual({ busy: true });
    expect(checkWritable(s, () => false)).toEqual({ busy: false });
  });
});
