import * as fs from 'fs';
import * as path from 'path';
import type { Session } from '../shared/types';
import { gitOk, type GitRunner } from './git-runner';

/**
 * git 写操作的保护：
 * - 同一仓库（按 git common dir 区分，主工作区与其各个 worktree 共用一把锁）的面板写操作串行执行；
 * - 失败后检测残留的 index.lock，只报告路径，从不自动删除（锁可能正被 Claude 的 git 持有）；
 * - 只读与忙碌的统一判断。
 */

/** 互斥锁的键：绝对路径、正斜杠、小写（Windows 路径不区分大小写） */
export function lockKey(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 失败后的锁文件检测：<gitDir>/index.lock 存在时返回其路径 */
export function detectLock(gitDir: string): string | undefined {
  const file = path.join(gitDir, 'index.lock');
  try {
    return fs.existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

export interface WritableCheck {
  /** 不能写的原因；为空表示可写 */
  blocked?: string;
  busy: boolean;
}

/** 写操作前的统一判断：会话不存在或只读一律拒绝；忙碌只标记，由调用方决定是否需要再确认 */
export function checkWritable(session: Session | undefined, isBusy: (id: string) => boolean): WritableCheck {
  if (!session) return { blocked: '会话不存在', busy: false };
  if (session.readOnly) return { blocked: '此会话由其他面板实例运行，只能查看，不能执行写操作', busy: false };
  return { busy: isBusy(session.id) };
}

export class WriteGuard {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly git: GitRunner) {}

  /** 在给定键（通常是 common dir）的锁内执行 fn；同键排队，不同键互不影响；fn 抛错不影响后续排队者 */
  withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const k = lockKey(key);
    const prev = this.tails.get(k) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(k, tail);
    // 队尾执行完且没有新排队者时移除，避免 Map 无限增长
    void tail.then(() => { if (this.tails.get(k) === tail) this.tails.delete(k); });
    return result;
  }

  /** cwd 所在仓库的 common dir（绝对路径）；不是仓库时返回 undefined */
  async commonDir(cwd: string): Promise<string | undefined> {
    const r = await this.git.run(cwd, ['rev-parse', '--git-common-dir']);
    if (!gitOk(r)) return undefined;
    const raw = r.stdout.trim();
    return raw ? path.resolve(cwd, raw) : undefined;
  }

  /** 按 cwd 所在仓库加锁执行；不是仓库时直接执行（git 自己会报错） */
  async withRepo<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const dir = await this.commonDir(cwd);
    return dir ? this.withRepoLock(dir, fn) : fn();
  }

  /** cwd 所在工作树的 index.lock 是否存在（worktree 的索引锁在各自的 git dir 下） */
  async findIndexLock(cwd: string): Promise<string | undefined> {
    const r = await this.git.run(cwd, ['rev-parse', '--git-path', 'index.lock']);
    if (!gitOk(r)) return undefined;
    const file = path.resolve(cwd, r.stdout.trim());
    return fs.existsSync(file) ? file : undefined;
  }
}

/** 锁文件残留时给用户的说明 */
export function lockMessage(file: string): string {
  return `另一个 git 进程正在操作（可能是 Claude），或上次 git 被中止后残留了锁文件 ${file}。确认没有 git 进程在运行后可手动删除该文件`;
}
