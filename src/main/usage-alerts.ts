import * as path from 'path';
import { log } from './logger';
import type { FileState } from './usage-store';
import type { ActivityInput, ActivityLevel, ActivityReporter } from '../shared/activity';
import type { ContextUsage, UsageSettings } from '../shared/usage-types';
import { fmtTokens } from '../shared/usage-format';

/**
 * 上下文告警：会话上下文占用越档时生成 budget.alert 事件（事件类型沿用旧名，保证历史记录与推送配置兼容）。
 * 有活动上报器时只上报（是否弹通知由活动日志转交通知服务决定）；没有时直接发通知。
 * 已提醒档位记在 transcript 文件状态里，重启后不重复。
 */

export type AlertNotify = (level: ActivityLevel, title: string, body: string, sessionId?: string) => void;

export interface AlertSink {
  activity?: ActivityReporter;
  notify?: AlertNotify;
}

/** 文件状态里最多保留的已提醒上下文档位数 */
const MAX_CTX_ALERTED = 20;
/** 上下文告警只针对这段时间内的记录：首次启用或补读历史时不为早已结束的回合提醒 */
const CTX_FRESH_MS = 10 * 60 * 1000;

/**
 * 上下文告警：主线程上下文越过提醒或危险阈值且该档未提醒过时生成事件，一次跨两档只报高档。
 * 已提醒档位带压缩次数记录，压缩后占用回落、再次越档会再提醒一次。
 */
export function contextAlert(
  sessionId: string, label: string, file: string, f: FileState, ctx: ContextUsage, s: UsageSettings, now: number,
): ActivityInput<'budget.alert'> | null {
  const tiers = [s.contextWarnPct, s.contextDangerPct].filter(t => ctx.pct >= t).sort((a, b) => a - b);
  if (tiers.length === 0 || now - ctx.at > CTX_FRESH_MS) return null;
  const n = f.compactions ?? 0;
  const tag = (t: number): string => `${n}:${t}`;
  const done = f.ctxAlerted ?? [];
  const fresh = tiers.filter(t => !done.includes(tag(t)));
  if (fresh.length === 0) return null;
  f.ctxAlerted = [...done, ...fresh.map(tag)].slice(-MAX_CTX_ALERTED);
  const top = fresh[fresh.length - 1];
  const danger = top >= s.contextDangerPct;
  return {
    type: 'budget.alert',
    source: 'usage',
    sessionId,
    level: danger ? 'error' : 'warning',
    title: `「${label}」上下文已用 ${ctx.pct}%`,
    detail: `${fmtTokens(ctx.used)} / ${fmtTokens(ctx.window)}（${ctx.model}）${danger ? '，即将触发自动压缩' : ''}`,
    data: { scope: 'context', used: ctx.pct, limit: 100, unit: 'percent', threshold: top },
    at: now,
    dedupeKey: `usage:context:${sessionId}:${path.basename(file)}:${top}${n > 0 ? `:${n}` : ''}`,
  };
}

/** 送出告警：优先走活动上报器，未注入时直接发通知 */
export function deliverAlert(input: ActivityInput<'budget.alert'>, sink: AlertSink): void {
  log('usage', `上下文告警：${input.title}｜${input.detail ?? ''}`);
  if (sink.activity) {
    sink.activity.report(input);
    return;
  }
  sink.notify?.(input.level ?? 'warning', input.title ?? '上下文提醒', input.detail ?? '', input.sessionId);
}
