import { execFile, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import { log } from './logger';

/**
 * 结束整个进程树。只按调用方给出的 pid 结束（就是面板自己启动的进程），绝不按进程名批量结束。
 * Windows：taskkill /pid <pid> /T /F（shell 启动时 pid 是 cmd.exe，子孙进程靠 /T 一并结束）。
 * POSIX：进程须以 detached 启动成为进程组组长，先向整组发 SIGTERM，2 秒后仍在则补 SIGKILL。
 * 已知限制：主动脱离进程树的守护进程（如 Gradle daemon）不会被结束。
 */

const POSIX_GRACE_MS = 2000;
const TASKKILL_TIMEOUT_MS = 5000;

export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) {
    // EPERM：进程存在但无权发信号，仍算存活
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 异步结束进程树；进程已不存在时直接返回。不抛出 */
export function killTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      let done = false;
      const finish = (): void => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => { log('proc', `taskkill ${pid} 超时`); finish(); }, TASKKILL_TIMEOUT_MS);
      try {
        const p = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        p.on('error', err => { log('proc', `taskkill ${pid} 启动失败：${String(err)}`); finish(); });
        p.on('exit', finish);
      } catch (err) {
        log('proc', `taskkill ${pid} 启动失败：${String(err)}`);
        finish();
      }
    });
  }
  return new Promise(resolve => {
    const signalGroup = (sig: NodeJS.Signals): boolean => {
      try { process.kill(-pid, sig); return true; } catch {
        try { process.kill(pid, sig); return true; } catch { return false; }
      }
    };
    if (!signalGroup('SIGTERM')) { resolve(); return; }
    setTimeout(() => {
      if (isPidAlive(pid)) signalGroup('SIGKILL');
      resolve();
    }, POSIX_GRACE_MS);
  });
}

/** 同步结束进程树（面板退出时用，来不及等异步）。不抛出 */
export function killTreeSync(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: TASKKILL_TIMEOUT_MS });
    } catch (err) { log('proc', `taskkill ${pid} 失败：${String(err)}`); }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }
}

const CMDLINE_TIMEOUT_MS = 10_000;

/**
 * 读取进程的完整命令行，用于结束进程前确认 pid 没有被其他程序复用。读不到（进程不存在、无权限、超时）返回 null。
 * Windows 经 PowerShell 查 Win32_Process，输出编码先切到 UTF-8，避免中文路径按系统代码页乱码；
 * Linux 读 /proc/<pid>/cmdline；其余 POSIX 用 ps。不抛出。
 */
export function readCommandLine(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  if (process.platform === 'linux') {
    return fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf8')
      .then(raw => raw.replace(/\0/g, ' ').trim() || null, () => null);
  }
  const [file, args]: [string, string[]] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]]
    : ['ps', ['-ww', '-o', 'args=', '-p', String(pid)]];
  return new Promise(resolve => {
    try {
      execFile(file, args, { windowsHide: true, timeout: CMDLINE_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
        if (err) { log('proc', `读取进程 ${pid} 命令行失败：${err.message}`); resolve(null); return; }
        resolve(stdout.trim() || null);
      });
    } catch (err) {
      log('proc', `读取进程 ${pid} 命令行失败：${String(err)}`);
      resolve(null);
    }
  });
}
