import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gitOk, type GitRunner } from './git-runner';
import { log } from './logger';
import { parsePorcelainV2 } from '../shared/git-parse';

/** 验证命令进程的最小接口（测试注入假实现） */
export interface VerifyChild {
  readonly pid?: number;
  onData(cb: (chunk: Buffer) => void): void;
  /** 只回调一次；error 为命令无法启动等原因 */
  onExit(cb: (code: number | null, error?: string) => void): void;
}

export type VerifySpawn = (command: string, opts: { cwd: string; env: NodeJS.ProcessEnv }) => VerifyChild;

/** 进程 exit 后等输出管道关闭的最长时间：脱离进程树的孙进程可能一直占着管道 */
const CLOSE_GRACE_MS = 1000;

/**
 * 经系统 shell 启动验证命令（Windows 为 cmd.exe），不经过 PTY，输出不会进入 Claude 的终端。
 * stdout 与 stderr 合并收集；POSIX 下以 detached 启动，便于按进程组结束；
 * 启动后立即把进程优先级降到低于正常，之后由它派生的子进程继承这一优先级。
 */
export const spawnShell: VerifySpawn = (command, { cwd, env }) => {
  const dataCbs: Array<(c: Buffer) => void> = [];
  const exitCbs: Array<(code: number | null, error?: string) => void> = [];
  let done = false;
  let exitCode: number | null = null;
  let graceTimer: NodeJS.Timeout | undefined;
  const fire = (code: number | null, error?: string): void => {
    if (done) return;
    done = true;
    if (graceTimer) clearTimeout(graceTimer);
    for (const cb of exitCbs) cb(code, error);
  };
  const child = spawn(command, {
    cwd, env, shell: true, windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.pid) {
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (err) {
      log('verify', `降低验证进程优先级失败：${String(err)}`);
    }
  }
  const onChunk = (c: Buffer): void => { for (const cb of dataCbs) cb(c); };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  child.on('error', err => fire(null, err.message));
  child.on('exit', code => {
    exitCode = code;
    graceTimer = setTimeout(() => fire(exitCode), CLOSE_GRACE_MS);
  });
  child.on('close', code => fire(code ?? exitCode));
  return {
    pid: child.pid,
    onData: cb => { dataCbs.push(cb); },
    onExit: cb => { exitCbs.push(cb); },
  };
};

/** 指纹最多逐个读取属性的文件数，超过只计入状态输出本身 */
const MAX_STAT_FILES = 2000;

/**
 * 工作区指纹：HEAD 提交 + git status（含未跟踪文件）列出的路径及各自的大小与修改时间，取 sha1。
 * 两轮之间指纹相同即认为工作区没有变化。非 git 目录或 git 出错返回 null（不做跳过）。
 */
export async function workspaceFingerprint(git: GitRunner, cwd: string): Promise<string | null> {
  if (!fs.existsSync(cwd)) return null;
  const top = await git.run(cwd, ['rev-parse', '--show-toplevel']);
  if (!gitOk(top)) return null;
  const root = top.stdout.trim();
  const [head, status] = await Promise.all([
    git.run(root, ['rev-parse', '-q', '--verify', 'HEAD']),
    git.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
  ]);
  if (!gitOk(status)) return null;
  const h = createHash('sha1');
  h.update(`head:${gitOk(head) ? head.stdout.trim() : ''}\n`);
  h.update(status.stdout);
  const entries = parsePorcelainV2(status.stdout).filter(e => e.type !== 'ignored');
  if (entries.length <= MAX_STAT_FILES) {
    const paths = entries.map(e => e.path).sort();
    await Promise.all(paths.map(async p => {
      try {
        const st = await fs.promises.stat(path.join(root, p));
        return `${p}\t${st.size}\t${st.mtimeMs}`;
      } catch {
        return `${p}\tmissing`;
      }
    })).then(lines => { for (const l of lines) h.update(`${l}\n`); });
  } else {
    h.update(`count:${entries.length}`);
  }
  return h.digest('hex');
}
