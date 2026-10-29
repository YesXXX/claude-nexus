import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { RECENT_LIMIT, applyRecord, bucketOf, isBrokenUsefulLine, localDateOf, mayBeUseful, parseLine } from '../src/shared/usage-parse';
import type { ParsedLine, RecentMap, TokenCounts, UsageRecord } from '../src/shared/usage-types';
import { addCounts, zeroCounts } from '../src/shared/usage-types';

const FIX = path.join(__dirname, 'fixtures', 'usage');

function lines(name: string): string[] {
  return fs.readFileSync(path.join(FIX, name), 'utf8').split(/\r?\n/).filter(Boolean);
}

function parsed(name: string): ParsedLine[] {
  return lines(name).map(parseLine).filter((x): x is ParsedLine => x !== null);
}

function usages(name: string): UsageRecord[] {
  return parsed(name).filter((x): x is UsageRecord => x.kind === 'usage');
}

/** 把一组记录按 applyRecord 记账，返回各桶合计 */
function account(recent: RecentMap, recs: UsageRecord[], into: Record<string, TokenCounts> = {}): Record<string, TokenCounts> {
  for (const r of recs) {
    const { delta, bucket } = applyRecord(recent, r);
    addCounts(into[bucket] ??= zeroCounts(), delta);
  }
  return into;
}

describe('parseLine：脱敏样例行', () => {
  it('流式分段的三行都解析出同一个 id', () => {
    const rs = usages('stream.jsonl');
    expect(rs.map(r => r.id)).toEqual(['msg_A', 'msg_A', 'msg_A']);
    expect(rs.map(r => r.output)).toEqual([1, 800, 2000]);
    expect(rs[2]).toMatchObject({ input: 1000, cacheRead: 100_000, cacheWrite5m: 20_000, cacheWrite1h: 0, fast: false, sidechain: false });
    expect(rs[2].ts).toBe(Date.parse('2026-10-17T02:00:03.000Z'));
  });

  it('缺 cache_creation_input_tokens 时缓存写按 0', () => {
    const r = usages('shapes.jsonl').find(x => x.id === 'msg_nocc')!;
    expect(r).toMatchObject({ input: 10, cacheRead: 500, output: 20, cacheWrite5m: 0, cacheWrite1h: 0 });
  });

  it('speed / service_tier 为对象时不抛错，也不当作快速模式；无分档时总量记入 5 分钟档', () => {
    const r = usages('shapes.jsonl').find(x => x.id === 'msg_obj')!;
    expect(r.fast).toBe(false);
    expect(r.cacheWrite5m).toBe(300);
  });

  it('<synthetic> 与 isApiErrorMessage 的行不计', () => {
    const ids = usages('shapes.jsonl').map(r => r.id);
    expect(ids).not.toContain('msg_syn');
    expect(ids).not.toContain('msg_err');
  });

  it('子代理行带 sidechain、快速模式与网络搜索次数', () => {
    const r = usages('shapes.jsonl').find(x => x.id === 'msg_side')!;
    expect(r).toMatchObject({ sidechain: true, fast: true, webSearch: 2, input: 500, output: 1000, cacheRead: 10_000 });
    expect(bucketOf(r)).toBe('claude-opus-5#fast');
  });

  it('识别 compact_boundary', () => {
    const c = parsed('shapes.jsonl').find(x => x.kind === 'compact');
    expect(c).toEqual({ kind: 'compact', ts: Date.parse('2026-10-17T03:00:05.000Z'), preTokens: 180_000, trigger: 'auto' });
  });

  it('cost-state 中带 [1m] 的模型 key 归一化后上报', () => {
    const f = parsed('shapes.jsonl').find(x => x.kind === 'flag1m');
    expect(f).toEqual({ kind: 'flag1m', models: ['claude-opus-5-5'] });
  });

  it('损坏的 JSON 与无关行返回 null，不抛错', () => {
    const all = lines('shapes.jsonl');
    const broken = all.find(l => l.includes('msg_broken'))!;
    expect(parseLine(broken)).toBeNull();
    expect(isBrokenUsefulLine(broken)).toBe(true);
    expect(isBrokenUsefulLine(all[0])).toBe(false);
    for (const bad of ['', '{', 'null', '[]', '"x"', '{"type":"assistant","usage":1}', '{"type":"assistant","message":{"usage":{}},"usage":1}']) {
      expect(() => parseLine(bad)).not.toThrow();
      expect(parseLine(bad)).toBeNull();
    }
  });

  it('预过滤只放行可能有用的行', () => {
    expect(mayBeUseful('{"type":"user","message":"hi"}')).toBe(false);
    expect(mayBeUseful('{"type":"assistant","message":{"content":"x"}}')).toBe(false);
    expect(mayBeUseful('{"type":"assistant","message":{"usage":{}}}')).toBe(true);
    expect(mayBeUseful('{"type":"system","subtype":"compact_boundary"}')).toBe(true);
    expect(mayBeUseful('{"modelUsage":{"a[1m]":{}}}')).toBe(true);
    expect(mayBeUseful('{"modelUsage":{"a":{}}}')).toBe(false);
  });

  it('缺少 message.id 时退回 requestId / uuid，都没有则不计', () => {
    const base = { type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 1 } } };
    expect((parseLine(JSON.stringify({ ...base, requestId: 'req_1' })) as UsageRecord).id).toBe('req_1');
    expect((parseLine(JSON.stringify({ ...base, uuid: 'u_1' })) as UsageRecord).id).toBe('u_1');
    expect(parseLine(JSON.stringify(base))).toBeNull();
  });
});

describe('applyRecord：按 id 覆盖式记账', () => {
  it('同 id 三行（1 → 800 → 2000）只按最后一行计', () => {
    const sums = account([], usages('stream.jsonl'));
    expect(sums['claude-opus-5']).toEqual({ input: 1000, output: 2000, cacheRead: 100_000, cacheWrite5m: 20_000, cacheWrite1h: 0, webSearch: 0 });
  });

  it('分两批喂入（recent 跨批次保留）结果相同', () => {
    const rs = usages('stream.jsonl');
    const recent: RecentMap = [];
    const sums = account(recent, rs.slice(0, 1));
    account(JSON.parse(JSON.stringify(recent)) as RecentMap, [], sums);
    account(recent, rs.slice(1), sums);
    expect(sums['claude-opus-5'].output).toBe(2000);
    expect(sums['claude-opus-5'].input).toBe(1000);
  });

  it('后一行比前一行小时记负增量', () => {
    const [a] = usages('stream.jsonl');
    const recent: RecentMap = [];
    applyRecord(recent, { ...a, input: 1000 });
    const { delta } = applyRecord(recent, { ...a, input: 900 });
    expect(delta.input).toBe(-100);
  });

  it('增量记到该 id 首次出现的日期上', () => {
    const [a] = usages('stream.jsonl');
    const first = new Date(2026, 9, 17, 23, 59, 59).getTime();
    const later = new Date(2026, 9, 18, 0, 0, 5).getTime();
    const recent: RecentMap = [];
    expect(applyRecord(recent, { ...a, ts: first }).date).toBe('2026-10-17');
    expect(applyRecord(recent, { ...a, ts: later, output: 5000 }).date).toBe('2026-10-17');
    expect(localDateOf(later)).toBe('2026-10-18');
  });

  it('recent 只保留最近 32 个 id', () => {
    const [a] = usages('stream.jsonl');
    const recent: RecentMap = [];
    for (let i = 0; i < RECENT_LIMIT + 5; i++) applyRecord(recent, { ...a, id: `m${i}` });
    expect(recent).toHaveLength(RECENT_LIMIT);
    expect(recent[0][0]).toBe('m5');
  });

  it('缺 timestamp 时用调用方给的时间定日期', () => {
    const [a] = usages('stream.jsonl');
    const at = new Date(2026, 0, 2, 12).getTime();
    expect(applyRecord([], { ...a, ts: 0 }, at).date).toBe('2026-01-02');
  });
});
