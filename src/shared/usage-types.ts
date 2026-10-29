/**
 * 上下文用量的共享类型：主进程记账、渲染层展示与 IPC 共用。
 * 账本按 token 去重累计，界面只展示每个会话主线程的上下文占用，不计算金额。
 */

/** 一组 token 计数；webSearch 为网络搜索调用次数 */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearch: number;
}

/** transcript 中一条 assistant 消息的解析结果 */
export interface UsageRecord extends TokenCounts {
  kind: 'usage';
  /** message.id，去重键 */
  id: string;
  /** 原始 model 字段 */
  model: string;
  /** timestamp 转毫秒；缺失或无法解析为 0 */
  ts: number;
  /** usage.speed === 'fast' */
  fast: boolean;
  /** isSidechain */
  sidechain: boolean;
}

/** 解析出的压缩标记（system 行 subtype 为 compact_boundary） */
export interface CompactMark {
  kind: 'compact';
  ts: number;
  preTokens?: number;
  postTokens?: number;
  trigger?: string;
}

/** cost-state 行中 modelUsage 的 key 带 [1m] 的模型（归一化 id） */
export interface Flag1mMark {
  kind: 'flag1m';
  models: string[];
}

export type ParsedLine = UsageRecord | CompactMark | Flag1mMark;

/** 按模型分桶，key 为归一化模型 id，快速模式在模型 id 后加 #fast */
export type ModelBuckets = Record<string, TokenCounts>;

/** 计数数组，顺序固定为 [input, output, cacheRead, cacheWrite5m, cacheWrite1h, webSearch] */
export type CountTuple = [number, number, number, number, number, number];

/** 去重用的最近记账值：message.id → 已记数值、桶与首次出现日期 */
export interface RecentEntry {
  bucket: string;
  date: string;
  t: CountTuple;
}
export type RecentMap = Array<[string, RecentEntry]>;

export type ContextLevel = 'ok' | 'warn' | 'danger';
export type WindowSource = 'setting' | 'flag_1m' | 'observed' | 'builtin' | 'default';

export interface ContextUsage {
  /** input + cacheRead + cacheWrite5m + cacheWrite1h */
  used: number;
  window: number;
  /** 0～100，取整 */
  pct: number;
  level: ContextLevel;
  model: string;
  windowSource: WindowSource;
  /** 最近一次 assistant 之前出现过 compact_boundary */
  compacted: boolean;
  /** 本文件累计压缩次数 */
  compactions?: number;
  at: number;
}

/** 合并进 Session.usage，随 panel:sessions 推送 */
export interface SessionUsageSummary {
  state: 'pending' | 'ok' | 'no_data';
  /** no_data 的原因文案 */
  reason?: string;
  context?: ContextUsage;
  updatedAt: number;
}

export interface UsageSettings {
  /** 默认 80 */
  contextWarnPct: number;
  /** 默认 95 */
  contextDangerPct: number;
  /** key 为模型前缀，支持尾部 *，值为窗口 token 数 */
  windows: Record<string, number>;
}

export type SetUsageSettingsResult = { ok: true } | { ok: false; error: string };

/** 零计数 */
export function zeroCounts(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 };
}

export function countsToTuple(t: TokenCounts): CountTuple {
  return [t.input, t.output, t.cacheRead, t.cacheWrite5m, t.cacheWrite1h, t.webSearch];
}

export function tupleToCounts(a: readonly number[]): TokenCounts {
  const n = (i: number): number => (Number.isFinite(a[i]) ? a[i] : 0);
  return { input: n(0), output: n(1), cacheRead: n(2), cacheWrite5m: n(3), cacheWrite1h: n(4), webSearch: n(5) };
}

/** 逐项相加到 target（原地修改），返回 target */
export function addCounts(target: TokenCounts, d: TokenCounts, sign = 1): TokenCounts {
  target.input += sign * d.input;
  target.output += sign * d.output;
  target.cacheRead += sign * d.cacheRead;
  target.cacheWrite5m += sign * d.cacheWrite5m;
  target.cacheWrite1h += sign * d.cacheWrite1h;
  target.webSearch += sign * d.webSearch;
  return target;
}

/** 元组逐项相加到 target（原地修改） */
export function addTuple(target: CountTuple, d: readonly number[], sign = 1): CountTuple {
  for (let i = 0; i < 6; i++) target[i] += sign * (Number.isFinite(d[i]) ? d[i] : 0);
  return target;
}

export function isZeroCounts(t: TokenCounts): boolean {
  return t.input === 0 && t.output === 0 && t.cacheRead === 0 && t.cacheWrite5m === 0
    && t.cacheWrite1h === 0 && t.webSearch === 0;
}

/** 展示用：负值按 0 处理（负增量只会短暂出现） */
export function clampCounts(t: TokenCounts): TokenCounts {
  return {
    input: Math.max(0, t.input), output: Math.max(0, t.output), cacheRead: Math.max(0, t.cacheRead),
    cacheWrite5m: Math.max(0, t.cacheWrite5m), cacheWrite1h: Math.max(0, t.cacheWrite1h),
    webSearch: Math.max(0, t.webSearch),
  };
}

/** 上下文占用：input + cacheRead + cacheWrite5m + cacheWrite1h */
export function contextTokens(t: TokenCounts): number {
  return t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
}
