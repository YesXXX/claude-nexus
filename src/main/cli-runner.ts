import { execFile, execFileSync } from 'child_process';
import type { GitResult } from './git-runner';

/**
 * 外部程序（gh、claude 等）的运行器：execFile 参数数组直传、不经 shell，结果结构与 GitResult 一致。
 * prefixArgs 放在每次调用的参数之前，测试里可用 `{ file: process.execPath, prefixArgs: [假脚本] }` 运行 node 脚本，
 * Windows 上调用 .cmd 包装的程序则写成 `{ file: 'cmd.exe', prefixArgs: ['/c', 'claude.cmd'] }`。
 */

export interface CliRunOptions {
  cwd?: string;
  /** 追加的环境变量，覆盖 baseEnv 中的同名项 */
  env?: Record<string, string>;
  /** 写入 stdin 的内容，写完即关闭；不传时 stdin 立即关闭，程序读 stdin 会得到 EOF 而不是挂起 */
  stdin?: string;
  timeoutMs?: number;
}

export interface CliRunnerConfig {
  file: string;
  prefixArgs?: string[];
  /** 子进程环境的基础，缺省为当前进程环境 */
  baseEnv?: Record<string, string | undefined>;
}

export interface CliRunner {
  /** 显示用的程序名（命令记录里用），不含 prefixArgs 中的脚本路径 */
  readonly name: string;
  run(args: string[], opts?: CliRunOptions): Promise<GitResult>;
}

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_BUFFER = 16 * 1024 * 1024;

/** 结束超时的子进程；Windows 上经 cmd.exe 包装时要连同子进程树一起结束，只针对自己拉起的 pid */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch {
      // 进程已退出或无权限：退回到普通的 kill
    }
  }
  try { process.kill(pid); } catch { /* 已退出 */ }
}

function programName(file: string, prefixArgs: string[]): string {
  // cmd.exe /c xxx.cmd 显示为 xxx；node 脚本显示为脚本文件名
  if (/cmd(\.exe)?$/i.test(file) && prefixArgs[0]?.toLowerCase() === '/c' && prefixArgs[1]) {
    return prefixArgs[1].replace(/\.(cmd|bat)$/i, '');
  }
  const base = (prefixArgs.length > 0 ? prefixArgs[prefixArgs.length - 1] : file).split(/[\\/]/).pop() ?? file;
  return base.replace(/\.(exe|cmd|bat|js)$/i, '');
}

export function createCliRunner(config: CliRunnerConfig): CliRunner {
  const prefix = config.prefixArgs ?? [];
  return {
    name: programName(config.file, prefix),
    run(args, opts = {}) {
      const started = Date.now();
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(config.baseEnv ?? process.env)) if (v !== undefined) env[k] = v;
      Object.assign(env, opts.env ?? {});
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return new Promise<GitResult>(resolve => {
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        const child = execFile(config.file, [...prefix, ...args], {
          cwd: opts.cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: MAX_BUFFER,
        }, (err, stdout, stderr) => {
          if (timer) clearTimeout(timer);
          const ms = Date.now() - started;
          const base = { stdout: stdout ?? '', stderr: stderr ?? '', ms, notFound: false, timedOut: false };
          if (timedOut) { resolve({ ...base, code: -2, timedOut: true }); return; }
          if (!err) { resolve({ ...base, code: 0 }); return; }
          const e = err as NodeJS.ErrnoException & { code?: number | string };
          if (e.code === 'ENOENT' && !base.stderr) { resolve({ ...base, code: -1, notFound: true }); return; }
          // 退出码非 0 时 err.message 只是「Command failed …」，不当作 stderr；启动失败等才用它
          const exitCode: unknown = e.code;
          const numeric = typeof exitCode === 'number';
          resolve({ ...base, code: numeric ? exitCode : 1, stderr: base.stderr || (numeric ? '' : String(e.message)) });
        });
        timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
        if (child.stdin) {
          child.stdin.on('error', () => undefined);
          child.stdin.end(opts.stdin ?? '', 'utf8');
        }
      });
    },
  };
}

/** 失败结果的一句话说明：找不到程序、超时，否则取 stderr（再退回 stdout）的首个非空行 */
export function cliErrorText(name: string, r: GitResult): string {
  if (r.notFound) return `未找到 ${name}`;
  if (r.timedOut) return `${name} 执行超时（${Math.round(r.ms / 1000)} 秒）`;
  const first = (r.stderr || r.stdout).split(/\r?\n/).map(s => s.trim()).find(Boolean);
  return first ?? `${name} 退出码 ${r.code}`;
}
