import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Session } from '../src/shared/types';
import type { ActivityInput, ActivityLevel } from '../src/shared/activity';
import type { UsageSettings } from '../src/shared/usage-types';
import { UsageTracker, type UsageTrackerDeps } from '../src/main/usage-tracker';
import { defaultUsageSettings } from '../src/shared/usage-format';

let tmp: string;
let root: string;
let file: string;
let usageDir: string;
let sessions: Map<string, Session>;
let clock: number;
let reports: ActivityInput[];
let seq = 0;
const T0 = new Date(2026, 9, 17, 10, 0, 0).getTime();

const activity = { report: (i: ActivityInput) => { reports.push(i); return null; } };

function settings(over: Partial<UsageSettings> = {}): UsageSettings {
  return {
    ...defaultUsageSettings(),
    windows: { 'claude-opus-5': 100_000 },
    ...over,
  };
}

function makeTracker(extra: Partial<UsageTrackerDeps> = {}, s: UsageSettings = settings()): UsageTracker {
  const t = new UsageTracker({
    dir: usageDir,
    root: () => root,
    getSession: id => sessions.get(id),
    listSessions: () => [...sessions.values()],
    now: () => clock,
    debounceMs: 60_000,
    activity,
    ...extra,
  });
  trackers.push(t);
  if (s) t.setSettings(s);
  return t;
}

/** 追加一条 assistant 记录；inM 为输入百万 token 数，ctx 为上下文 token 数 */
function add(o: { inM?: number; ctx?: number; model?: string; ts?: number }): void {
  const u = {
    input_tokens: Math.round((o.inM ?? 0) * 1_000_000),
    output_tokens: 1,
    cache_read_input_tokens: o.ctx ?? 0,
  };
  fs.appendFileSync(file, JSON.stringify({
    type: 'assistant', timestamp: new Date(o.ts ?? clock).toISOString(),
    message: { id: `m${++seq}`, model: o.model ?? 'claude-opus-5', usage: u },
  }) + '\n');
}

function compact(post: number): void {
  fs.appendFileSync(file, JSON.stringify({
    type: 'system', subtype: 'compact_boundary', timestamp: new Date(clock).toISOString(),
    compactMetadata: { trigger: 'auto', preTokens: 99_000, postTokens: post },
  }) + '\n');
}

async function turn(t: UsageTracker): Promise<void> {
  t.onHookMessage({ sessionId: 's1', event: { type: 'turn_completed' }, transcriptPath: file });
  await new Promise(r => setTimeout(r, 0));
  await t.whenIdle();
  await new Promise(r => setTimeout(r, 0));
  await t.whenIdle();
}

const ctxs = (): ActivityInput[] => reports.filter(r => (r.data as { scope?: string })?.scope === 'context');

let trackers: UsageTracker[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-alerts-'));
  root = path.join(tmp, 'projects');
  fs.mkdirSync(path.join(root, 'D--w'), { recursive: true });
  file = path.join(root, 'D--w', 'c.jsonl');
  fs.writeFileSync(file, '');
  usageDir = path.join(tmp, 'panel', 'usage');
  sessions = new Map([['s1', {
    id: 's1', label: '重构', cwd: 'D:\\w', status: 'running', statusSince: T0, createdAt: T0 - 60_000, escalated: false,
  }]]);
  clock = T0;
  reports = [];
  trackers = [];
});

afterEach(() => {
  for (const t of trackers) t.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('不再有预算提醒', () => {
  it('大量 token 只产生上下文告警，不产生金额相关事件', async () => {
    const t = makeTracker();
    add({ inM: 500 });
    add({ ctx: 10_000 });
    await turn(t);
    expect(reports).toEqual([]);
    expect(t.getSummary('s1')).toMatchObject({ state: 'ok', context: { used: 10_000, pct: 10 } });
  });
});

describe('上下文提醒', () => {
  it('80 与 95 档各报一次，压缩后再越档再报', async () => {
    const t = makeTracker();
    add({ ctx: 81_000 });
    await turn(t);
    expect(ctxs()).toHaveLength(1);
    expect(ctxs()[0]).toMatchObject({
      sessionId: 's1', level: 'warning',
      data: { scope: 'context', used: 81, limit: 100, unit: 'percent', threshold: 80 },
      dedupeKey: 'usage:context:s1:c.jsonl:80',
    });
    add({ ctx: 85_000 });
    await turn(t);
    expect(ctxs()).toHaveLength(1);
    add({ ctx: 96_000 });
    await turn(t);
    expect(ctxs()).toHaveLength(2);
    expect(ctxs()[1]).toMatchObject({ level: 'error', data: { threshold: 95 }, dedupeKey: 'usage:context:s1:c.jsonl:95' });
    compact(20_000);
    add({ ctx: 30_000 });
    await turn(t);
    expect(ctxs()).toHaveLength(2);
    add({ ctx: 82_000 });
    await turn(t);
    expect(ctxs()).toHaveLength(3);
    expect(ctxs()[2].dedupeKey).toBe('usage:context:s1:c.jsonl:80:1');
  });

  it('一次跨两档只报高档；重启后不重复', async () => {
    const t = makeTracker();
    add({ ctx: 97_000 });
    await turn(t);
    expect(ctxs()).toHaveLength(1);
    expect(ctxs()[0].data).toMatchObject({ threshold: 95 });
    t.dispose();
    const t2 = makeTracker();
    add({ ctx: 98_000 });
    await turn(t2);
    expect(ctxs()).toHaveLength(1);
  });

  it('十分钟之前的上下文记录不提醒', async () => {
    const t = makeTracker();
    add({ ctx: 90_000, ts: T0 - 11 * 60_000 + 60_000 });
    clock = T0 + 60_000;
    await turn(t);
    expect(ctxs()).toHaveLength(0);
    expect(t.getSummary('s1')?.context?.pct).toBe(90);
  });
});

describe('未注入活动上报器', () => {
  it('上下文告警直接发通知，带会话 id', async () => {
    const calls: Array<[ActivityLevel, string, string, string | undefined]> = [];
    const t = makeTracker({ activity: undefined, notify: (l, ti, b, sid) => calls.push([l, ti, b, sid]) });
    add({ inM: 8 });
    add({ ctx: 81_000 });
    await turn(t);
    expect(reports).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('warning');
    expect(calls[0][1]).toContain('上下文已用 81%');
    expect(calls[0][3]).toBe('s1');
  });
});
