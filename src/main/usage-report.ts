import type { ContextUsage, SessionUsageSummary, UsageSettings } from '../shared/usage-types';
import { inferWindow } from '../shared/usage-window';
import { contextLevel, pctOf } from '../shared/usage-format';
import type { FileState } from './usage-store';

/**
 * 由账本计算会话摘要的纯函数：只取当前主文件最近一次主对话记录的上下文占用，
 * 窗口按当前设置实时推断，改了窗口覆盖后立即按新窗口重算。
 */

export interface SessionFiles {
  sessionId: string;
  /** [路径, 状态]，只含未 detached 的文件 */
  files: Array<[string, FileState]>;
  /** 当前主文件（上下文占用只看它） */
  currentMain?: string;
}

export interface ReportContext {
  settings: UsageSettings;
  flagged1m: ReadonlySet<string>;
  now: number;
}

/** 主文件选择：优先最近一次 hook 指向的文件，否则取最近被提及的主文件 */
export function pickMain(sf: SessionFiles): [string, FileState] | undefined {
  if (sf.currentMain) {
    const hit = sf.files.find(([p]) => p === sf.currentMain);
    if (hit) return hit;
  }
  let best: [string, FileState] | undefined;
  for (const e of sf.files) {
    if (e[1].kind !== 'main') continue;
    if (!best || e[1].seenAt > best[1].seenAt) best = e;
  }
  return best;
}

export function contextOf(sf: SessionFiles, ctx: ReportContext): ContextUsage | undefined {
  const main = pickMain(sf);
  const last = main?.[1].lastContext;
  if (!main || !last || last.used <= 0) return undefined;
  let observedMax = 0;
  for (const [, f] of sf.files) observedMax = Math.max(observedMax, f.observedMax[last.model] ?? 0);
  const { window, source } = inferWindow(last.model, { settings: ctx.settings, flagged1m: ctx.flagged1m, observedMax });
  const pct = pctOf(last.used, window);
  const out: ContextUsage = {
    used: last.used, window, pct, level: contextLevel(pct, ctx.settings), model: last.model,
    windowSource: source, compacted: last.compacted, at: last.at,
  };
  if (main[1].compactions) out.compactions = main[1].compactions;
  return out;
}

/**
 * 会话摘要：有上下文即为 ok；读过对话记录但还没有主对话记录时也算 ok（等下一回合）；
 * 判定过无数据的为 no_data；其余为 pending（首个回合还没结束）。
 */
export function buildSummary(
  sf: SessionFiles, ctx: ReportContext, noDataReason?: string,
): SessionUsageSummary {
  const read = sf.files.some(([, f]) => f.offset > 0);
  const context = contextOf(sf, ctx);
  const state: SessionUsageSummary['state'] = context || (read && !noDataReason)
    ? 'ok'
    : noDataReason ? 'no_data' : 'pending';
  const out: SessionUsageSummary = { state, updatedAt: ctx.now };
  if (state === 'no_data') out.reason = noDataReason;
  if (context) out.context = context;
  return out;
}
