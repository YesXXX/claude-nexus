import * as os from 'os';
import * as path from 'path';

/** 面板数据目录：env 注入优先（测试用），默认 ~/.claude-session-panel */
export function panelHome(): string {
  return process.env.CLAUDE_PANEL_HOME ?? path.join(os.homedir(), '.claude-session-panel');
}

/**
 * 是否为隔离实例：显式指定了 CLAUDE_PANEL_HOME 时视为测试/并行实例，
 * 与常驻面板分开单实例锁、userData，并且不抢全局热键、不改写开始菜单快捷方式
 */
export function isIsolatedInstance(): boolean {
  return !!process.env.CLAUDE_PANEL_HOME;
}

type Env = Record<string, string | undefined>;

/** 通知只记日志时写入的固定前缀，自动化测试从日志中按它断言 */
export const NOTIFY_LOG_PREFIX = '通知仅记录（未弹出系统通知）：';

/**
 * 窗口是否以不激活的方式显示（CLAUDE_PANEL_WINDOW=inactive）：
 * 只在隔离实例中生效，避免自动化测试每次新建窗口都抢走前台焦点
 */
export function windowInactive(env: Env = process.env): boolean {
  return !!env.CLAUDE_PANEL_HOME && env.CLAUDE_PANEL_WINDOW?.trim().toLowerCase() === 'inactive';
}

/**
 * 通知是否只写日志、不弹出系统通知（CLAUDE_PANEL_NOTIFY=log）：
 * 只在隔离实例中生效，常驻面板与安装版的正常启动不受影响
 */
export function notifyLogOnly(env: Env = process.env): boolean {
  return !!env.CLAUDE_PANEL_HOME && env.CLAUDE_PANEL_NOTIFY?.trim().toLowerCase() === 'log';
}
