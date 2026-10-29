import { execFile, execFileSync } from 'child_process';
import * as pty from 'node-pty';
import { PtyFactory, PtyProcess } from '../shared/types';
import { traceWrites } from './pty-trace';

/**
 * node-pty 在 Windows 上结束 conpty 时会另起子进程查询控制台进程列表，
 * 查询失败（进程已先退出导致 AttachConsole 失败）会在 5 秒后对原 shell pid 调用 process.kill。
 * 此时该 pid 可能已被系统复用，存在误杀无关进程的风险。
 * 这里改为在进程仍存活时用 taskkill /T 结束整棵进程树，并让 node-pty 的延迟查询直接返回空列表。
 */
function disableDelayedConsoleKill(proc: pty.IPty): void {
  const agent = (proc as unknown as { _agent?: { _getConsoleProcessList?: () => Promise<number[]> } })._agent;
  if (agent && typeof agent._getConsoleProcessList === 'function') {
    agent._getConsoleProcessList = () => Promise.resolve([]);
  }
}

function taskkillTree(pid: number, timeoutMs = 3000): Promise<void> {
  return new Promise(resolve => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: timeoutMs }, () => resolve());
  });
}

export class RealPtyFactory implements PtyFactory {
  spawn(file: string, args: string[], options: { cwd: string; env: Record<string, string> }): PtyProcess {
    const proc = pty.spawn(file, args, {
      name: 'xterm-color', cols: 120, rows: 30,
      cwd: options.cwd, env: options.env as unknown as Record<string, string>,
    });
    let exited = false;
    let killing = false;
    proc.onExit(() => { exited = true; });
    if (process.platform === 'win32') disableDelayedConsoleKill(proc);

    const kill = (immediate = false): void => {
      if (exited || killing) return;
      killing = true;
      if (process.platform !== 'win32') {
        proc.kill();
        return;
      }
      if (immediate) {
        try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 2000, stdio: 'ignore' }); } catch { /* 进程已退出或超时：继续关闭伪控制台 */ }
        try { proc.kill(); } catch { /* 进程已随进程树结束 */ }
        return;
      }
      // 先在进程存活时结束整棵树（pid 此时不会被复用），再关闭伪控制台释放句柄
      void taskkillTree(proc.pid).finally(() => {
        try { proc.kill(); } catch { /* 进程已随进程树结束 */ }
      });
    };

    // 会话 id 取自注入的环境变量（sanitizeChildEnv 写入），追踪只在隔离实例开启
    const write = traceWrites(options.env.CLAUDE_PANEL_SESSION_ID ?? String(proc.pid), d => proc.write(d));
    return {
      write,
      kill,
      onData: cb => proc.onData(cb),
      onExit: cb => proc.onExit(({ exitCode }) => cb(exitCode)),
      resize: (cols, rows) => proc.resize(cols, rows),
      pid: proc.pid,
    };
  }
}
