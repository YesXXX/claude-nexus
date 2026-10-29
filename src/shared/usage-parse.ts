import type { CompactMark, Flag1mMark, ParsedLine, RecentMap, TokenCounts, UsageRecord } from './usage-types';
import { countsToTuple, tupleToCounts } from './usage-types.js';
import { FAST_SUFFIX, normalizeModelId } from './usage-window.js';

/**
 * transcript JSONL 的解析纯函数。
 * 解析一律按「取得到就用，取不到当 0」，不对形态做强校验，任何输入都不抛错。
 */

/** 每个文件保留的最近 message.id 数量；同 id 的流式分段在文件里相邻，32 个足够 */
export const RECENT_LIMIT = 32;

/** 预过滤：只有可能有用的行才做 JSON.parse */
export function mayBeUseful(line: string): boolean {
  if (line.includes('"compact_boundary"')) return true;
  if (line.includes('"modelUsage"') && /\[1m\]/i.test(line)) return true;
  return line.includes('"type":"assistant"') && line.includes('"usage"');
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function tsOf(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/** 在对象前几层里找 modelUsage（cost-state 行的具体嵌套位置不固定） */
function findModelUsage(o: Record<string, unknown>, depth = 0): Record<string, unknown> | null {
  const direct = obj(o.modelUsage);
  if (direct) return direct;
  if (depth >= 3) return null;
  for (const v of Object.values(o)) {
    const child = obj(v);
    if (!child) continue;
    const found = findModelUsage(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseAssistant(o: Record<string, unknown>): UsageRecord | null {
  if (o.isApiErrorMessage === true) return null;
  const msg = obj(o.message);
  const usage = msg ? obj(msg.usage) : null;
  if (!msg || !usage) return null;
  const model = typeof msg.model === 'string' ? msg.model : '';
  if (!model || model === '<synthetic>') return null;
  const id = typeof msg.id === 'string' && msg.id ? msg.id
    : typeof o.requestId === 'string' && o.requestId ? o.requestId
      : typeof o.uuid === 'string' && o.uuid ? o.uuid : '';
  if (!id) return null;

  const cc = obj(usage.cache_creation);
  let w5 = cc ? num(cc.ephemeral_5m_input_tokens) : 0;
  const w1 = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  // 分档缺失或不全时，cache_creation_input_tokens 的剩余部分按 5 分钟档计
  const total = num(usage.cache_creation_input_tokens);
  if (total > w5 + w1) w5 += total - w5 - w1;
  const server = obj(usage.server_tool_use);

  return {
    kind: 'usage',
    id,
    model,
    ts: tsOf(o.timestamp),
    fast: usage.speed === 'fast',
    sidechain: o.isSidechain === true,
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite5m: w5,
    cacheWrite1h: w1,
    webSearch: server ? num(server.web_search_requests) : 0,
  };
}

function parseCompact(o: Record<string, unknown>): CompactMark | null {
  if (o.type !== 'system' || o.subtype !== 'compact_boundary') return null;
  const meta = obj(o.compactMetadata) ?? obj(o.compact_metadata) ?? {};
  const mark: CompactMark = { kind: 'compact', ts: tsOf(o.timestamp) };
  const pre = num(meta.preTokens ?? meta.pre_tokens);
  const post = num(meta.postTokens ?? meta.post_tokens);
  if (pre) mark.preTokens = pre;
  if (post) mark.postTokens = post;
  if (typeof meta.trigger === 'string') mark.trigger = meta.trigger;
  return mark;
}

function parseFlag1m(o: Record<string, unknown>): Flag1mMark | null {
  const mu = findModelUsage(o);
  if (!mu) return null;
  const models = Object.keys(mu).map(k => normalizeModelId(k)).filter(m => m.has1m && m.id).map(m => m.id);
  return models.length > 0 ? { kind: 'flag1m', models: [...new Set(models)] } : null;
}

/** 预过滤 + 解析一行；不相关或无法解析返回 null，不抛错 */
export function parseLine(line: string): ParsedLine | null {
  if (!line || !mayBeUseful(line)) return null;
  let o: Record<string, unknown> | null;
  try {
    o = obj(JSON.parse(line));
  } catch {
    return null;
  }
  if (!o) return null;
  if (o.type === 'assistant') return parseAssistant(o);
  if (o.type === 'system' && o.subtype === 'compact_boundary') return parseCompact(o);
  return parseFlag1m(o);
}

/** 解析失败（看起来有用但 JSON 不合法）的判定，供调用方按文件记一次日志 */
export function isBrokenUsefulLine(line: string): boolean {
  if (!line || !mayBeUseful(line)) return false;
  try {
    JSON.parse(line);
    return false;
  } catch {
    return true;
  }
}

/** 本地日期 YYYY-MM-DD */
export function localDateOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 记账桶：归一化模型 id，快速模式加后缀 */
export function bucketOf(r: Pick<UsageRecord, 'model' | 'fast'>): string {
  const id = normalizeModelId(r.model).id;
  return r.fast ? `${id}${FAST_SUFFIX}` : id;
}

/**
 * 按 message.id 覆盖式求增量：同 id 再次出现时记「新值 − 旧值」（可为负），并覆盖旧值；
 * 增量记到该 id 首次出现的日期与桶上，避免一条消息跨零点被拆到两天。
 * recent 原地更新，只保留最近 RECENT_LIMIT 个。fallbackTs 用于缺少 timestamp 的行。
 */
export function applyRecord(
  recent: RecentMap, r: UsageRecord, fallbackTs = Date.now(),
): { delta: TokenCounts; date: string; bucket: string } {
  const t = countsToTuple(r);
  const idx = recent.findIndex(([id]) => id === r.id);
  if (idx >= 0) {
    const [, prev] = recent[idx];
    recent.splice(idx, 1);
    recent.push([r.id, { bucket: prev.bucket, date: prev.date, t }]);
    const delta = tupleToCounts(t.map((v, i) => v - (prev.t[i] ?? 0)));
    return { delta, date: prev.date, bucket: prev.bucket };
  }
  const bucket = bucketOf(r);
  const date = localDateOf(r.ts || fallbackTs);
  recent.push([r.id, { bucket, date, t }]);
  while (recent.length > RECENT_LIMIT) recent.shift();
  return { delta: tupleToCounts(t), date, bucket };
}
