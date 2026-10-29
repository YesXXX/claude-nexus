import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import { claudeConfigDir, claudeProjectsRoot } from './claude-paths';
import { isIsolatedInstance, panelHome } from './panel-home';
import { UsageTracker } from './usage-tracker';
import type { UsageTrackerDeps } from './usage-tracker';
import { normalizeModelId } from '../shared/usage-window';

/**
 * 上下文统计的装配：环境开关、账本目录、从用户 claude 设置读取 1M 模型映射。
 * CLAUDE_PANEL_USAGE=0 时不创建（属性面板不显示上下文，设置读到默认值）。
 */

export function usageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_PANEL_USAGE !== '0';
}

/** 只读这几个 key：主模型与各档默认模型映射 */
const MODEL_ENV_KEY = /^(ANTHROPIC_MODEL|ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL)$/;

/**
 * 用户 claude 设置里 env 模型映射带 [1m] 的模型。隔离实例、mock 模式或显式指定了
 * transcript 根目录时不读（测试与隔离实例不碰真实的 claude 配置目录）。
 */
export function flagged1mFromClaudeSettings(env: NodeJS.ProcessEnv = process.env): string[] {
  if (isIsolatedInstance() || env.CLAUDE_PANEL_MOCK_CLAUDE || env.CLAUDE_PANEL_TRANSCRIPT_ROOT) return [];
  const file = path.join(claudeConfigDir(env), 'settings.json');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const e = raw && typeof raw === 'object' ? (raw as { env?: unknown }).env : undefined;
  if (!e || typeof e !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(e as Record<string, unknown>)) {
    if (!MODEL_ENV_KEY.test(k) || typeof v !== 'string') continue;
    const m = normalizeModelId(v);
    if (m.has1m && m.id) out.push(m.id);
  }
  if (out.length > 0) log('usage', `claude 设置中的 1M 模型：${out.join(', ')}`);
  return out;
}

export function createUsageTracker(
  deps: Pick<UsageTrackerDeps, 'getSession' | 'listSessions' | 'onSummaryChanged' | 'activity' | 'notify'>,
): UsageTracker | undefined {
  if (!usageEnabled()) {
    log('usage', '上下文统计已关闭（CLAUDE_PANEL_USAGE=0）');
    return undefined;
  }
  const tracker = new UsageTracker({
    ...deps,
    dir: path.join(panelHome(), 'usage'),
    root: () => claudeProjectsRoot(),
    claudeCodeChild: !!process.env.CLAUDE_CODE_CHILD,
    extraFlagged1m: flagged1mFromClaudeSettings(),
  });
  log('usage', `上下文统计已启用，账本 ${tracker.store.file}`);
  return tracker;
}
