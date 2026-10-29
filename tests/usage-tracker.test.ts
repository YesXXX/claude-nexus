import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HookMessage, Session } from '../src/shared/types';

// 包一层真实读取函数，统计同时进行的读取数（验证并发上限）
const readStats = vi.hoisted(() => ({ active: 0, max: 0 }));
vi.mock('../src/main/usage-reader', async (orig) => {
  const real = await orig<typeof import('../src/main/usage-reader')>();
  return {
    ...real,
    readIncrement: async (...args: Parameters<typeof real.readIncrement>) => {
      readStats.active++;
      readStats.max = Math.max(readStats.max, readStats.active);
      try {
        await new Promise(r => setTimeout(r, 5));
        return await real.readIncrement(...args);
      } finally {
        readStats.active--;
      }
    },
  };
});

import { UsageTracker, type UsageTrackerDeps } from '../src/main/usage-tracker';

let tmp: string;
let root: string;
let proj: string;
let usageDir: string;
let sessions: Map<string, Session>;
let clock: number;
let changed: string[];

const T0 = new Date(2026, 9, 17, 10, 0, 0).getTime();

function mkSession(id: string, createdAt = T0 - 60_000): Session {
  const s: Session = {
    id, label: `会话-${id}`, cwd: 'D:\\w', status: 'running', statusSince: createdAt, createdAt, escalated: false,
  };
  sessions.set(id, s);
  return s;
}

interface U { in?: number; out?: number; cr?: number; cw?: number }
function asst(id: string, u: U, ts: number, opt: { model?: string; side?: boolean } = {}): string {
  return JSON.stringify({
    type: 'assistant', timestamp: new Date(ts).toISOString(), isSidechain: opt.side ?? false,
    message: {
      id, model: opt.model ?? 'claude-opus-5',
      usage: {
        input_tokens: u.in ?? 0, output_tokens: u.out ?? 0,
        cache_read_input_tokens: u.cr ?? 0, cache_creation_input_tokens: u.cw ?? 0,
      },
    },
  }) + '\n';
}

function makeTracker(extra: Partial<UsageTrackerDeps> = {}): UsageTracker {
  return new UsageTracker({
    dir: usageDir,
    root: () => root,
    getSession: id => sessions.get(id),
    listSessions: () => [...sessions.values()],
    onSummaryChanged: id => changed.push(id),
    now: () => clock,
    throttleMs: 30,
    debounceMs: 60_000,
    ...extra,
  });
}

const hook = (sessionId: string, type: 'turn_completed' | 'tool_finished' | 'session_started', transcriptPath?: string): HookMessage => ({
  sessionId,
  event: type === 'session_started' ? { type, source: 'startup' } : { type },
  transcriptPath,
});

async function turn(t: UsageTracker, sid: string, file?: string): Promise<void> {
  t.onHookMessage(hook(sid, 'turn_completed', file));
  await new Promise(r => setTimeout(r, 0));
  await t.whenIdle();
  await new Promise(r => setTimeout(r, 0));
  await t.whenIdle();
}

/** 账本里某会话未 detached 文件的累计 token（验证增量读取、去重与撤销） */
function tokensOf(t: UsageTracker, sid: string): { input: number; output: number; cacheRead: number } {
  const out = { input: 0, output: 0, cacheRead: 0 };
  for (const file of Object.values(t.store.ledger.files)) {
    if (file.sessionId !== sid || file.detached) continue;
    for (const day of Object.values(file.contrib)) {
      for (const tup of Object.values(day)) {
        out.input += tup[0];
        out.output += tup[1];
        out.cacheRead += tup[2];
      }
    }
  }
  return out;
}

let trackers: UsageTracker[] = [];
function track(t: UsageTracker): UsageTracker {
  trackers.push(t);
  return t;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-tracker-'));
  root = path.join(tmp, 'projects');
  proj = path.join(root, 'D--w');
  fs.mkdirSync(proj, { recursive: true });
  usageDir = path.join(tmp, 'panel', 'usage');
  sessions = new Map();
  clock = T0;
  changed = [];
  readStats.active = 0;
  readStats.max = 0;
});

afterEach(() => {
  for (const t of trackers) t.dispose();
  trackers = [];
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('UsageTracker 增量记账', () => {
  it('增量读取；半行留到下次；同 id 流式分段按最后值计', async () => {
    mkSession('s1');
    const f = path.join(proj, 'c1.jsonl');
    const t = track(makeTracker());
    fs.writeFileSync(f, asst('m1', { in: 10, out: 1, cr: 100 }, T0));
    await turn(t, 's1', f);
    expect(tokensOf(t, 's1')).toMatchObject({ input: 10, output: 1, cacheRead: 100 });
    expect(t.getSummary('s1')!.state).toBe('ok');

    const full = asst('m1', { in: 10, out: 800, cr: 100 }, T0);
    fs.appendFileSync(f, full.slice(0, 40));
    await turn(t, 's1', f);
    expect(tokensOf(t, 's1').output).toBe(1);
    fs.appendFileSync(f, full.slice(40));
    fs.appendFileSync(f, asst('m1', { in: 10, out: 2000, cr: 100 }, T0));
    await turn(t, 's1', f);
    expect(tokensOf(t, 's1')).toMatchObject({ input: 10, output: 2000, cacheRead: 100 });
    expect(t.getSummary('s1')!.context?.used).toBe(110);
    expect(changed).toContain('s1');
  });

  it('文件变短时撤销已记的量并从头重读', async () => {
    mkSession('s1');
    const f = path.join(proj, 'c1.jsonl');
    const t = track(makeTracker());
    fs.writeFileSync(f, asst('a', { out: 500 }, T0) + asst('b', { out: 700 }, T0));
    await turn(t, 's1', f);
    expect(tokensOf(t, 's1').output).toBe(1200);
    fs.writeFileSync(f, asst('c', { out: 30 }, T0));
    await turn(t, 's1', f);
    expect(tokensOf(t, 's1').output).toBe(30);
  });

  it('计数下限：早于会话创建时间 5 分钟的消息不记账，但用于上下文', async () => {
    mkSession('s1', T0);
    const f = path.join(proj, 'c1.jsonl');
    const t = track(makeTracker());
    fs.writeFileSync(f,
      asst('old', { in: 1, out: 999, cr: 50_000 }, T0 - 6 * 60_000)
      + asst('new', { in: 1, out: 5 }, T0 - 4 * 60_000));
    await turn(t, 's1', f);
    expect(tokensOf(t, 's1').output).toBe(5);
    fs.writeFileSync(path.join(proj, 'c2.jsonl'), asst('old2', { in: 2, cr: 70_000 }, T0 - 3600_000));
    await turn(t, 's1', path.join(proj, 'c2.jsonl'));
    expect(t.getSummary('s1')!.context?.used).toBe(70_002);
    expect(tokensOf(t, 's1').output).toBe(5);
  });

});

describe('UsageTracker 文件关联', () => {
  it('子代理与压缩代理归类；上下文只看主线程且忽略 sidechain', async () => {
    mkSession('s1');
    const f = path.join(proj, 'c1.jsonl');
    const subDir = path.join(proj, 'c1', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(f, asst('m', { in: 100, cr: 1000, out: 10 }, T0) + asst('sc', { in: 900_000, out: 1 }, T0, { side: true }));
    fs.writeFileSync(path.join(subDir, 'agent-a1.jsonl'), asst('s', { in: 500_000, out: 20 }, T0));
    fs.writeFileSync(path.join(subDir, 'agent-acompact-9.jsonl'), asst('k', { in: 50, out: 30 }, T0));
    const t = track(makeTracker());
    await turn(t, 's1', f);
    expect(tokensOf(t, 's1').output).toBe(61);
    expect(t.getSummary('s1')!.context?.used).toBe(1100);
    const files = Object.values(t.store.ledger.files);
    expect(files).toHaveLength(3);
    expect(files.filter(x => x.kind !== 'main').map(x => [x.agentId, x.kind]).sort()).toEqual([['a1', 'subagent'], ['acompact-9', 'compact']]);
  });

  it('/clear 换文件：上下文看新文件，记账为两个文件之和', async () => {
    mkSession('s1');
    const a = path.join(proj, 'a.jsonl');
    const b = path.join(proj, 'b.jsonl');
    fs.writeFileSync(a, asst('1', { in: 1, cr: 150_000, out: 10 }, T0));
    const t = track(makeTracker());
    await turn(t, 's1', a);
    expect(t.getSummary('s1')!.context?.used).toBe(150_001);
    fs.writeFileSync(b, asst('2', { in: 1, cr: 2000, out: 5 }, T0));
    await turn(t, 's1', b);
    expect(t.getSummary('s1')!.context?.used).toBe(2001);
    expect(tokensOf(t, 's1').output).toBe(15);
  });

  it('根目录之外的路径拒绝登记', async () => {
    mkSession('s1');
    const outside = path.join(tmp, 'elsewhere', 'x.jsonl');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, asst('1', { out: 10 }, T0));
    const t = track(makeTracker());
    expect(t.attach('s1', outside, 'main')).toBe(false);
    expect(t.attach('s1', path.join(proj, '..', '..', 'elsewhere', 'x.jsonl'), 'main')).toBe(false);
    await turn(t, 's1', outside);
    expect(tokensOf(t, 's1').output).toBe(0);
    expect(Object.keys(t.store.ledger.files)).toHaveLength(0);
  });

  it('已归属另一存活会话的文件忽略', async () => {
    mkSession('s1');
    mkSession('s2');
    const f = path.join(proj, 'c.jsonl');
    fs.writeFileSync(f, asst('1', { out: 10 }, T0));
    const t = track(makeTracker());
    await turn(t, 's1', f);
    expect(t.attach('s2', f, 'main')).toBe(false);
    expect(tokensOf(t, 's1').output).toBe(10);
  });

  it('hook 未带路径时按会话的 Claude 会话 id 在根目录下查找', async () => {
    const s = mkSession('s1');
    s.claudeSessionIds = ['abc-1'];
    fs.writeFileSync(path.join(proj, 'abc-1.jsonl'), asst('1', { out: 7 }, T0));
    const t = track(makeTracker());
    await turn(t, 's1');
    expect(tokensOf(t, 's1').output).toBe(7);
  });
});

describe('UsageTracker 持久化与生命周期', () => {
  it('重启后从 offset 续读，不重复计数', async () => {
    mkSession('s1');
    const f = path.join(proj, 'c1.jsonl');
    fs.writeFileSync(f, asst('a', { out: 100 }, T0));
    const t1 = makeTracker();
    await turn(t1, 's1', f);
    t1.dispose();
    fs.appendFileSync(f, asst('b', { out: 5 }, T0));
    const t2 = track(makeTracker());
    t2.syncSessions();
    await t2.whenIdle();
    await new Promise(r => setTimeout(r, 0));
    await t2.whenIdle();
    expect(tokensOf(t2, 's1').output).toBe(105);
  });

  it('forget 后文件标记 detached；续接回来同一文件不重复计数', async () => {
    mkSession('s1');
    const f = path.join(proj, 'c1.jsonl');
    fs.writeFileSync(f, asst('a', { out: 100 }, T0));
    const t = track(makeTracker());
    await turn(t, 's1', f);
    t.forget('s1');
    expect(t.store.ledger.files[path.resolve(f)].detached).toBe(true);
    fs.appendFileSync(f, asst('b', { out: 1 }, T0));
    await turn(t, 's1', f);
    expect(tokensOf(t, 's1').output).toBe(101);
  });

  it('会话已不存在的文件在启动对齐时标记 detached，不计入任何摘要', async () => {
    mkSession('s1');
    const f = path.join(proj, 'c1.jsonl');
    fs.writeFileSync(f, asst('a', { out: 100 }, T0));
    const t1 = makeTracker();
    await turn(t1, 's1', f);
    t1.dispose();
    sessions.delete('s1');
    const t2 = track(makeTracker());
    t2.syncSessions();
    expect(t2.store.ledger.files[path.resolve(f)].detached).toBe(true);
  });

  it('回合结束后文件仍不存在判为 no_data；之后出现数据恢复为 ok', async () => {
    mkSession('s1');
    const f = path.join(proj, 'never.jsonl');
    const t = track(makeTracker());
    t.onHookMessage(hook('s1', 'session_started', f));
    expect(t.getSummary('s1')!.state).toBe('pending');
    await turn(t, 's1', f);
    expect(t.getSummary('s1')).toMatchObject({ state: 'no_data', reason: 'transcript 文件不存在' });
    fs.writeFileSync(f, asst('a', { out: 1 }, T0));
    await turn(t, 's1', f);
    expect(t.getSummary('s1')!.state).toBe('ok');
  });

  it('面板带 CLAUDE_CODE_CHILD 时 no_data 原因写明', async () => {
    mkSession('s1');
    const t = track(makeTracker({ claudeCodeChild: true }));
    await turn(t, 's1', path.join(proj, 'none.jsonl'));
    expect(t.getSummary('s1')!.reason).toContain('CLAUDE_CODE_CHILD');
  });

  it('PostToolUse 尾节流：短时间多次只读一次，到期后读到最新内容', async () => {
    mkSession('s1');
    const f = path.join(proj, 'c1.jsonl');
    fs.writeFileSync(f, asst('a', { out: 1 }, T0));
    const t = track(makeTracker({ throttleMs: 40 }));
    t.onHookMessage(hook('s1', 'tool_finished', f));
    fs.appendFileSync(f, asst('b', { out: 2 }, T0));
    t.onHookMessage(hook('s1', 'tool_finished', f));
    expect(tokensOf(t, 's1').output).toBe(0);
    await new Promise(r => setTimeout(r, 80));
    await t.whenIdle();
    await new Promise(r => setTimeout(r, 0));
    expect(tokensOf(t, 's1').output).toBe(3);
  });

  it('兜底轮询只读运行中的会话', async () => {
    const s1 = mkSession('s1');
    const s2 = mkSession('s2');
    const a = path.join(proj, 'a.jsonl');
    const b = path.join(proj, 'b.jsonl');
    fs.writeFileSync(a, '');
    fs.writeFileSync(b, '');
    const t = track(makeTracker());
    t.onHookMessage(hook('s1', 'session_started', a));
    t.onHookMessage(hook('s2', 'session_started', b));
    s2.status = 'completed';
    void s1;
    fs.writeFileSync(a, asst('x', { out: 4 }, T0));
    fs.writeFileSync(b, asst('y', { out: 6 }, T0));
    t.pollLive();
    await new Promise(r => setTimeout(r, 0));
    await t.whenIdle();
    await new Promise(r => setTimeout(r, 0));
    expect(tokensOf(t, 's1').output).toBe(4);
    expect(tokensOf(t, 's2').output).toBe(0);
  });

});

describe('UsageTracker 大文件', () => {
  it('2MB 单行跨块完整解析', async () => {
    mkSession('s1');
    const f = path.join(proj, 'c1.jsonl');
    const big = JSON.parse(asst('big', { in: 3, out: 9 }, T0));
    big.message.content = [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }];
    fs.writeFileSync(f, JSON.stringify(big) + '\n' + asst('after', { out: 1 }, T0));
    const t = track(makeTracker({ chunkSize: 64 * 1024 }));
    await turn(t, 's1', f);
    expect(tokensOf(t, 's1').output).toBe(10);
  });

  it('超长行跳过并继续读后面的行', async () => {
    mkSession('s1');
    const f = path.join(proj, 'c1.jsonl');
    const big = JSON.parse(asst('big', { out: 9 }, T0));
    big.message.content = [{ type: 'text', text: 'x'.repeat(300 * 1024) }];
    fs.writeFileSync(f, asst('a', { out: 1 }, T0) + JSON.stringify(big) + '\n' + asst('b', { out: 2 }, T0));
    const t = track(makeTracker({ chunkSize: 64 * 1024, maxLine: 100 * 1024 }));
    await turn(t, 's1', f);
    expect(tokensOf(t, 's1').output).toBe(3);
    expect(t.store.ledger.files[path.resolve(f)].offset).toBe(fs.statSync(f).size);
  });

  it('全局并发不超过上限', async () => {
    const files: string[] = [];
    for (let i = 0; i < 6; i++) {
      mkSession(`s${i}`);
      const f = path.join(proj, `c${i}.jsonl`);
      fs.writeFileSync(f, asst(`m${i}`, { out: i + 1 }, T0));
      files.push(f);
    }
    const t = track(makeTracker({ concurrency: 2 }));
    for (let i = 0; i < 6; i++) t.onHookMessage(hook(`s${i}`, 'turn_completed', files[i]));
    await new Promise(r => setTimeout(r, 0));
    await t.whenIdle();
    await new Promise(r => setTimeout(r, 0));
    await t.whenIdle();
    expect(readStats.max).toBe(2);
    for (let i = 0; i < 6; i++) expect(tokensOf(t, `s${i}`).output).toBe(i + 1);
  });
});
