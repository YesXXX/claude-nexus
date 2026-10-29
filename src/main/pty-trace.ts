import * as fs from 'fs';
import { log } from './logger';

/**
 * PTY 写入追踪（CLAUDE_PANEL_PTY_TRACE=<文件>）：每次向 pty 写入时追加一行
 * {"t":毫秒时间戳,"id":"面板会话 id","data":"原样字符串"}，供自测核对面板实际写出的字节。
 * 只在隔离实例（设置了 CLAUDE_PANEL_HOME）生效；正式实例即使设置了也忽略并记一次日志，避免用户输入落盘。
 */

type Env = Record<string, string | undefined>;

let warned = false;

/** 追踪文件路径；未开启或非隔离实例返回 undefined */
export function ptyTraceFile(env: Env = process.env): string | undefined {
  const file = env.CLAUDE_PANEL_PTY_TRACE?.trim();
  if (!file) return undefined;
  if (!env.CLAUDE_PANEL_HOME) {
    if (!warned) {
      warned = true;
      log('pty', '已设置 CLAUDE_PANEL_PTY_TRACE，但当前不是隔离实例，忽略写入追踪');
    }
    return undefined;
  }
  return file;
}

export function traceLine(id: string, data: string, t: number): string {
  return JSON.stringify({ t, id, data }) + '\n';
}

/**
 * 给写入函数套上追踪：开启时先同步追加一行再写入（同步写保证行序与写入顺序一致），未开启时原样返回。
 * 追踪文件写失败不影响写入本身。
 */
export function traceWrites(id: string, write: (data: string) => void, env: Env = process.env): (data: string) => void {
  const file = ptyTraceFile(env);
  if (!file) return write;
  return data => {
    try { fs.appendFileSync(file, traceLine(id, data, Date.now())); } catch { /* 追踪失败不阻断输入 */ }
    write(data);
  };
}
