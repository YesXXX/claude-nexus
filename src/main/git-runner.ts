import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GitResult {
  code: number;          // 进程退出码；git 未安装为 -1，超时为 -2
  stdout: string;
  stderr: string;
  ms: number;
  notFound: boolean;     // 找不到 git 可执行文件
  timedOut: boolean;
}

export interface GitRunOptions {
  timeoutMs?: number;
  /** 视为成功的退出码，默认只有 0（如 diff --no-index 有差异时返回 1） */
  okCodes?: number[];
  /** 追加的环境变量，覆盖同名的继承值（如合并时的 GIT_MERGE_AUTOEDIT=no） */
  env?: Record<string, string>;
  /** 写入子进程 stdin 的内容，写完即关闭（如 update-index --index-info、hash-object --stdin） */
  input?: string;
}

export interface GitRunner {
  run(cwd: string, args: string[], opts?: GitRunOptions): Promise<GitResult>;
}

const DEFAULT_TIMEOUT_MS = 15000;
/** 写操作（提交、合并、撤销等）的超时；超时会杀掉 git 进程，可能残留 index.lock */
export const GIT_WRITE_TIMEOUT_MS = 300000;
/** 推送的超时，网络慢时也不至于长时间挂起 */
export const GIT_PUSH_TIMEOUT_MS = 180000;
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * git 调用的唯一入口：execFile 参数数组直传，不经 shell，路径含中文 / 空格也不需要转义。
 * - core.quotepath=false：非 ASCII 文件名按原样输出，不被转义成八进制
 * - GIT_OPTIONAL_LOCKS=0：status 等只读命令不顺手刷新索引，不与 Claude 自己的 git add / commit 抢 index.lock
 * - GIT_TERMINAL_PROMPT=0：需要凭据时直接失败，绝不在后台挂起等输入
 */
export function createGitRunner(gitPath = 'git'): GitRunner {
  return {
    run(cwd, args, opts = {}) {
      const started = Date.now();
      const fullArgs = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args];
      const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...(opts.env ?? {}) };
      return new Promise(resolve => {
        const child = execFile(gitPath, fullArgs, {
          cwd, env, encoding: 'utf8', windowsHide: true,
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER,
        }, (err, stdout, stderr) => {
          const ms = Date.now() - started;
          const base = { stdout: stdout ?? '', stderr: stderr ?? '', ms, notFound: false, timedOut: false };
          if (!err) { resolve({ ...base, code: 0 }); return; }
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
          if (e.code === 'ENOENT' && !base.stderr) { resolve({ ...base, code: -1, notFound: true }); return; }
          if (e.killed) { resolve({ ...base, code: -2, timedOut: true }); return; }
          resolve({ ...base, code: typeof e.code === 'number' ? e.code : 1, stderr: base.stderr || String(e.message) });
        });
        if (opts.input !== undefined && child.stdin) {
          // 进程启动失败时写 stdin 会报 EPIPE，结果仍由上面的回调给出，这里只吞掉写入错误
          child.stdin.on('error', () => undefined);
          child.stdin.end(opts.input, 'utf8');
        }
      });
    },
  };
}

/** 结果是否成功（按 okCodes 判定） */
export function gitOk(r: GitResult, okCodes: number[] = [0]): boolean {
  return !r.notFound && !r.timedOut && okCodes.includes(r.code);
}

/** 失败结果转成一句可展示的中文说明 */
export function gitErrorText(r: GitResult): string {
  if (r.notFound) return '未检测到 git';
  if (r.timedOut) return `git 执行超时（${Math.round(r.ms / 1000)} 秒）`;
  const first = r.stderr.split(/\r?\n/).map(s => s.trim()).find(Boolean);
  return first ? first.replace(/^(fatal|error):\s*/i, '') : `git 退出码 ${r.code}`;
}

/**
 * 把 rev-parse --show-toplevel 给出的仓库根改写成 dir 的写法：git 返回的是长路径，
 * dir 可能是 8.3 短路径或经过链接，直接用会让相对路径变成一串 ..、同一文件在不同视图里地址写法不一，
 * 所以从 dir 向上退相应层数得到同一写法的根目录；无法换算时原样返回 git 的结果
 */
export function topInDirForm(dir: string, top: string): string {
  const resolved = path.resolve(top);
  const rel0 = path.relative(resolved, dir);
  if (rel0 === '' || (!rel0.startsWith('..') && !path.isAbsolute(rel0))) return resolved;
  try {
    const rel = path.relative(resolved, fs.realpathSync.native(dir));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return resolved;
    return rel ? path.resolve(dir, ...rel.split(path.sep).map(() => '..')) : path.resolve(dir);
  } catch {
    return resolved;
  }
}
