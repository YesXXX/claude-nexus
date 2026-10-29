import { log } from './logger';
import type { RestartOptions, RestartResult, ResumeCheck, Session } from '../shared/types';

/**
 * 接管认领的孤儿会话：结束仍在原终端运行的 claude 进程，再在面板里续接同一段对话。
 * 面板重启后原终端的 ConPTY 句柄已随旧面板进程失效，无法重新挂接，只能结束原进程后用 --resume 拉起新进程。
 * 结束进程前必须确认 pid 仍属于本会话：命令行里带着本会话专属的 --settings 配置路径。
 * 确认不了（读不到命令行、命令行不含该路径，可能 pid 已被其他程序复用）一律不结束任何进程。
 */

/** 接管用到的会话管理能力（SessionManager 的子集，便于单测替换） */
export interface TakeoverHost {
  getSession(id: string): Session | undefined;
  orphanPid(id: string): number | undefined;
  checkTakeover(id: string): ResumeCheck | undefined;
  releaseOrphan(id: string): boolean;
  restartSession(id: string, opts: RestartOptions): RestartResult;
}

export interface TakeoverDeps {
  host: TakeoverHost;
  readCommandLine(pid: number): Promise<string | null>;
  isAlive(pid: number): boolean;
  killTree(pid: number): Promise<void>;
  /** 结束原进程后等待其退出的上限，缺省 3 秒 */
  exitWaitMs?: number;
}

const EXIT_POLL_MS = 100;
const DEFAULT_EXIT_WAIT_MS = 3000;

/** 正在接管的会话，防止连点重复结束进程 */
const running = new Set<string>();

/**
 * 命令行是否属于该会话：含 sessions/<id>/settings.json（不区分大小写，斜杠方向与引号不限）。
 * 面板会话 id 全局唯一，带上 sessions 目录与文件名可排除只是碰巧含 id 的其他命令行。
 */
export function commandLineOwns(cmdline: string, sessionId: string): boolean {
  if (!sessionId) return false;
  const norm = (v: string): string => v.replace(/\\/g, '/').toLowerCase();
  return norm(cmdline).includes(norm(`sessions/${sessionId}/settings.json`));
}

async function waitExit(deps: TakeoverDeps, pid: number): Promise<boolean> {
  const deadline = Date.now() + (deps.exitWaitMs ?? DEFAULT_EXIT_WAIT_MS);
  while (deps.isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, EXIT_POLL_MS));
  }
  return true;
}

export async function takeoverOrphan(deps: TakeoverDeps, id: string): Promise<RestartResult> {
  const fail = (message: string, reason?: RestartResult['reason']): RestartResult => {
    log('orphan', `接管被拒 会话 ${id.slice(0, 8)}：${message}`);
    return { ok: false, mode: 'resume', ...(reason ? { reason } : {}), message };
  };
  const s = deps.host.getSession(id);
  if (!s) return fail('会话不存在', 'not_found');
  if (!s.readOnly) return fail('这不是认领的孤儿会话，无需接管');
  if (running.has(id)) return fail('正在接管这个会话');
  running.add(id);
  try {
    const pid = deps.host.orphanPid(id);
    if (pid !== undefined && deps.isAlive(pid)) {
      // 先确认能续接再动原进程：续接不了时结束原进程只会让这段对话彻底停下
      const check = deps.host.checkTakeover(id);
      if (!check) return fail('会话不存在', 'not_found');
      if (!check.resumable && check.reason !== 'busy') return fail(`${check.message}，未结束原进程`, check.reason);
      const cmdline = await deps.readCommandLine(pid);
      if (cmdline === null) return fail(`读不到进程 ${pid} 的命令行，无法确认它属于本会话，未结束任何进程`, 'unverified');
      if (!commandLineOwns(cmdline, id)) {
        return fail(`进程 ${pid} 已不是本会话的 claude（pid 可能已被其他程序复用），未结束任何进程`, 'unverified');
      }
      log('orphan', `接管会话 ${id.slice(0, 8)}（${s.label}）：结束原进程 pid=${pid}`);
      await deps.killTree(pid);
      if (!(await waitExit(deps, pid))) return fail(`原进程 ${pid} 未能结束，请回到原终端退出后再试`);
    }
    // 轮询可能已先一步解除只读，这里返回 false 不影响后续续接
    deps.host.releaseOrphan(id);
    const r = deps.host.restartSession(id, { mode: 'resume' });
    if (r.ok) log('orphan', `会话 ${id.slice(0, 8)} 已接管并续接`);
    return r;
  } finally {
    running.delete(id);
  }
}
