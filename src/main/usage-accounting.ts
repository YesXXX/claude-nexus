import { emptyDay } from './usage-store';
import type { FileState, Ledger } from './usage-store';
import type { CountTuple, ParsedLine, UsageRecord } from '../shared/usage-types';
import { contextTokens } from '../shared/usage-types';
import { applyRecord } from '../shared/usage-parse';
import { normalizeModelId } from '../shared/usage-window';

/**
 * 账本记账操作：把一行解析结果记入文件状态与每日账本，或撤销一个文件已记的全部量。
 * 只改内存中的账本对象，落盘由调用方负责。
 */

export function addTo(m: Record<string, CountTuple>, bucket: string, t: readonly number[], sign = 1): void {
  const cur = m[bucket] ?? (m[bucket] = [0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < 6; i++) cur[i] += sign * (t[i] ?? 0);
}

/** 撤销文件已记入账本的量并清空读取状态（文件被截断或重写时） */
export function revertFile(ledger: Ledger, f: FileState): void {
  for (const [date, buckets] of Object.entries(f.contrib)) {
    const day = ledger.days[date];
    if (!day) continue;
    for (const [bucket, t] of Object.entries(buckets)) {
      addTo(day.models, bucket, t, -1);
      const ds = day.sessions[f.sessionId];
      if (ds) addTo(ds.models, bucket, t, -1);
    }
  }
  f.offset = 0;
  f.recent = [];
  f.contrib = {};
  f.observedMax = {};
  f.compactions = 0;
  delete f.lastContext;
}

export interface ApplyContext {
  now: number;
  /** 会话标签（写进每日账本的会话条目） */
  label: () => string;
  /** 已知的 1M 模型集合，遇到新标记时原地加入 */
  flagged1m: Set<string>;
}

/**
 * 记入一行解析结果，返回是否改动了每日账本（用于决定是否推送今日总计）。
 * 计数下限之前的消息只用于上下文，不记账；主线程且非 sidechain 的消息才更新上下文。
 */
export function applyParsed(ledger: Ledger, f: FileState, parsed: ParsedLine, ctx: ApplyContext): boolean {
  if (parsed.kind === 'flag1m') {
    for (const m of parsed.models) {
      ctx.flagged1m.add(m);
      if (!ledger.flagged1m.includes(m)) ledger.flagged1m.push(m);
    }
    return false;
  }
  if (parsed.kind === 'compact') {
    f.compactions = (f.compactions ?? 0) + 1;
    // 压缩后到下一条 assistant 之前，用压缩后的 token 数作为当前占用
    if (f.kind === 'main' && f.lastContext && parsed.postTokens) {
      f.lastContext = { ...f.lastContext, used: parsed.postTokens, at: parsed.ts || ctx.now, compacted: true };
    }
    return false;
  }
  return applyUsage(ledger, f, parsed, ctx);
}

function applyUsage(ledger: Ledger, f: FileState, r: UsageRecord, ctx: ApplyContext): boolean {
  const model = normalizeModelId(r.model).id;
  if (f.kind === 'main' && !r.sidechain) {
    const used = contextTokens(r);
    f.lastContext = { used, model, at: r.ts || ctx.now, compacted: (f.compactions ?? 0) > 0 };
    if (used > (f.observedMax[model] ?? 0)) f.observedMax[model] = used;
  }
  if (r.ts && r.ts < f.countFrom) return false;
  const { delta, date, bucket } = applyRecord(f.recent, r, ctx.now);
  const t: CountTuple = [delta.input, delta.output, delta.cacheRead, delta.cacheWrite5m, delta.cacheWrite1h, delta.webSearch];
  if (t.every(v => v === 0)) return false;
  const contrib = f.contrib[date] ?? (f.contrib[date] = {});
  addTo(contrib, bucket, t);
  const day = ledger.days[date] ?? (ledger.days[date] = emptyDay());
  addTo(day.models, bucket, t);
  const ds = day.sessions[f.sessionId] ?? (day.sessions[f.sessionId] = { label: ctx.label(), models: {} });
  ds.label = ctx.label();
  addTo(ds.models, bucket, t);
  return true;
}
