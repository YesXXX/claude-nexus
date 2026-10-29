import { ipcMain } from 'electron';
import * as path from 'path';
import type { ActivityInput } from '../shared/activity';
import { ActivityLog } from './activity-log';
import { createActivitySources, type ActivitySources } from './activity-sources';
import { log } from './logger';
import { isIsolatedInstance, panelHome } from './panel-home';
import type { SessionManager } from './session-manager';

/**
 * 活动日志的接线：在主进程最先创建，会话名字与存活状态通过取值函数延后读取（会话管理器晚于它创建）。
 * CLAUDE_PANEL_ACTIVITY=0 时只在内存运行、不落盘，作为排障开关。
 */

export interface ActivityWiring {
  log: ActivityLog;
  sources: ActivitySources;
}

export function activityFile(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLAUDE_PANEL_ACTIVITY === '0') return null;
  return path.join(panelHome(), 'activity', 'events.jsonl');
}

export function createActivityWiring(deps: {
  manager: () => Pick<SessionManager, 'getSession' | 'isProcessAlive'> | undefined;
  isQuitting: () => boolean;
}): ActivityWiring {
  const file = activityFile();
  if (!file) log('activity', 'CLAUDE_PANEL_ACTIVITY=0：活动日志只在内存运行');
  const activity = new ActivityLog({
    file,
    describeSession: id => {
      const m = deps.manager();
      const s = m?.getSession(id);
      return s && m ? { label: s.label, cwd: s.cwd, alive: m.isProcessAlive(id) } : undefined;
    },
  });
  const sources = createActivitySources(activity, { isQuitting: deps.isQuitting });
  return { log: activity, sources };
}

/**
 * 自测通道：CDP 通过它批量灌入事件、校验上报规则。
 * 只在隔离实例（数据目录指向临时目录）且 CLAUDE_PANEL_TEST_HOOKS=1 时注册，正式实例不存在该通道。
 */
export function registerActivityTestHooks(activity: ActivityLog, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLAUDE_PANEL_TEST_HOOKS !== '1' || !isIsolatedInstance()) return false;
  ipcMain.handle('activity:test-report', (_e, input: unknown) => {
    const list = Array.isArray(input) ? input : [input];
    const out = list.map(x => activity.report(x as ActivityInput));
    activity.flushPush();
    return Array.isArray(input) ? out : out[0];
  });
  log('activity', '测试钩子已注册：activity:test-report');
  return true;
}
