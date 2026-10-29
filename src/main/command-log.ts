import type { CommandRecord } from '../shared/review-types';
import type { GitResult } from './git-runner';

/**
 * 面板执行的写命令记录：每条保留显示用命令行、cwd、退出码、耗时与截断后的输出，
 * 按会话只留最近 PER_SESSION 条，供界面「操作记录」查看。只在内存中保存，面板重启后清空。
 */

const MAX_OUTPUT = 64 * 1024;
const PER_SESSION = 50;

/** URL 里的用户名与令牌（scheme://user:token@host）一律去掉，避免出现在界面与记录里 */
export function redactCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1');
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n…（输出过长，已截断，共 ${text.length} 字符）`;
}

/** 显示用命令行：参数含空白或引号时加双引号，仅供阅读，不能直接粘贴执行 */
export function displayCommand(file: string, args: string[]): string {
  const quote = (a: string): string => (a === '' || /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return redactCredentials([file, ...args].map(quote).join(' '));
}

export function toRecord(cwd: string, file: string, args: string[], r: GitResult, ok: boolean, at: number): CommandRecord {
  return {
    display: displayCommand(file, args),
    cwd,
    code: r.code,
    ms: r.ms,
    stdout: truncate(redactCredentials(r.stdout)),
    stderr: truncate(redactCredentials(r.stderr)),
    ok,
    at,
  };
}

export class CommandLog {
  private readonly bySession = new Map<string, CommandRecord[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 记一条命令；ok 缺省按退出码 0 判定。返回写入的记录 */
  record(sessionId: string, cwd: string, file: string, args: string[], r: GitResult, ok?: boolean): CommandRecord {
    const rec = toRecord(cwd, file, args, r, ok ?? (!r.notFound && !r.timedOut && r.code === 0), this.now());
    const list = this.bySession.get(sessionId) ?? [];
    list.push(rec);
    if (list.length > PER_SESSION) list.splice(0, list.length - PER_SESSION);
    this.bySession.set(sessionId, list);
    return rec;
  }

  /** 该会话的记录，按时间从旧到新 */
  list(sessionId: string): CommandRecord[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  forget(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
