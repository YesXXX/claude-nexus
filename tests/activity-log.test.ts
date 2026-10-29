import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ACTIVITY_MAX_AGE_MS, ActivityLog, BATCH_GAP_MS, BATCH_MAX_COUNT, DEDUPE_WINDOW_MS, PUSH_DELAY_MS, cwdTail, toolCountsText,
} from '../src/main/activity-log';
import { verifyResultInput } from '../src/main/activity-sources';
import type { ActivityInput, ActivityPush } from '../src/shared/activity';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-activity-'));
process.env.CLAUDE_PANEL_HOME = TMP;

let clock = 1_700_000_000_000;
const now = (): number => clock;
let fileSeq = 0;
const newFile = (): string => path.join(TMP, `case-${++fileSeq}`, 'events.jsonl');

function make(opts: Partial<ConstructorParameters<typeof ActivityLog>[0]> = {}): ActivityLog {
  return new ActivityLog({
    now,
    describeSession: id => (id.startsWith('gone') ? undefined : { label: `会话-${id}`, cwd: `D:\\work\\${id}`, alive: id !== 'dead' }),
    ...opts,
  });
}

function readLines(file: string): Array<Record<string, unknown>> {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => { clock = 1_700_000_000_000; });
afterEach(() => { vi.useRealTimers(); });

describe('ActivityLog 上报与规范化', () => {
  it('生成 id、seq、rev、缺省标题与级别，附带会话名与目录末段', () => {
    const log = make();
    const e = log.report({ type: 'turn.end', source: 'session', sessionId: 's1' })!;
    expect(e).toMatchObject({ seq: 1, rev: 1, at: clock, updatedAt: clock, title: '本轮结束', level: 'success' });
    expect(e.sessionLabel).toBe('会话-s1');
    expect(e.cwdTail).toBe('s1');
    expect(e.id).toBe(`${clock.toString(36)}-1`);
    expect(log.report({ type: 'session.start', source: 'session', sessionId: 's1' })!.seq).toBe(2);
  });

  it('非法输入记日志丢弃、不抛错：非对象、未知类型、缺少 source', () => {
    const log = make();
    expect(log.report(null as unknown as ActivityInput)).toBeNull();
    expect(log.report({ type: 'nope', source: 'x' } as unknown as ActivityInput)).toBeNull();
    expect(log.report({ type: 'turn.end' } as unknown as ActivityInput)).toBeNull();
    expect(log.report({ type: 'turn.end', source: '  ' })).toBeNull();
    expect(log.size).toBe(0);
  });

  it('标题与详情折叠空白、打码并截断；data 超 2KB 整体去除，非对象 data 去除', () => {
    const log = make();
    const e = log.report({
      type: 'turn.start', source: 'session', sessionId: 's1',
      title: `长标题 ${'甲'.repeat(300)}`,
      detail: `password=hunter2\n\n${'乙'.repeat(400)}`,
    })!;
    expect(e.title.length).toBeLessThanOrEqual(120);
    expect(e.title.endsWith('…')).toBe(true);
    expect(e.detail!.length).toBeLessThanOrEqual(200);
    expect(e.detail).toContain('password=***');
    expect(e.detail).not.toContain('hunter2');
    expect(e.detail).not.toContain('\n');
    const big = log.report({ type: 'turn.end', source: 's', data: { blob: Array.from({ length: 20 }, () => 'x'.repeat(150)) } })!;
    expect(big.data).toBeUndefined();
    expect(big.title).toBe('本轮结束');
    const bad = log.report({ type: 'turn.end', source: 's', data: 'str' as unknown as object })!;
    expect(bad.data).toBeUndefined();
  });

  it('data 里的字符串一律打码截断', () => {
    const log = make();
    const e = log.report({ type: 'wait.permission', source: 's', data: { toolName: 'Bash', summary: `curl -H "Authorization: Bearer abcdefghijk" ${'z'.repeat(300)}` } })!;
    const d = e.data as { summary: string };
    expect(d.summary).not.toContain('abcdefghijk');
    expect(d.summary.length).toBeLessThanOrEqual(200);
  });

  it('dedupeKey：同会话同 key 60 秒内只记一次，不同会话互不影响', () => {
    const log = make();
    const input: ActivityInput = { type: 'wait.overdue', source: 'notify', sessionId: 's1', dedupeKey: 'overdue' };
    expect(log.report(input)).not.toBeNull();
    expect(log.report(input)).toBeNull();
    expect(log.report({ ...input, sessionId: 's2' })).not.toBeNull();
    clock += DEDUPE_WINDOW_MS;
    expect(log.report(input)).not.toBeNull();
  });

  it('会话已不在时沿用该会话最近一条事件里的名字与目录', () => {
    let alive = true;
    const log = make({ describeSession: () => (alive ? { label: '临时会话', cwd: '/a/b/proj/' } : undefined) });
    log.report({ type: 'session.start', source: 'session', sessionId: 'x' });
    alive = false;
    const e = log.report({ type: 'session.end', source: 'session', sessionId: 'x' })!;
    expect(e.sessionLabel).toBe('临时会话');
    expect(e.cwdTail).toBe('proj');
  });
});

describe('ActivityLog 外部事件', () => {
  it('预算告警：缺省 warning，标题按范围与档位生成', () => {
    const log = make();
    const e = log.report({
      type: 'budget.alert', source: 'usage', sessionId: 's1',
      data: { scope: 'session', used: 4.2, limit: 5, unit: 'usd', threshold: 80 },
    })!;
    expect(e).toMatchObject({ level: 'warning', title: '本会话预算达到 80%' });
    expect(log.report({ type: 'budget.alert', source: 'usage', data: { scope: 'daily', used: 10, limit: 10, unit: 'usd', threshold: 100 } })!.title)
      .toBe('今日预算达到 100%');
  });

  it('验证结果：通过为 success，失败为 error 并带退出码摘要', () => {
    const log = make();
    const ok = log.report(verifyResultInput('s1', { status: 'passed', command: 'npm test', durationMs: 3200, exitCode: 0 }))!;
    expect(ok).toMatchObject({ type: 'verify.result', level: 'success', title: '验证通过 · npm test', source: 'verify' });
    const bad = log.report(verifyResultInput('s1', { status: 'failed', command: 'npm test', durationMs: 65_000, exitCode: 2 }))!;
    expect(bad).toMatchObject({ level: 'error', title: '验证失败 · npm test' });
    expect(bad.detail).toBe('退出码 2 · 用时 1 分');
    expect(bad.data).toMatchObject({ ok: false, exitCode: 2, summary: '退出码 2' });
    const to = log.report(verifyResultInput('s1', { status: 'timeout', command: 'npm test', message: '超过 10 分钟' }))!;
    expect(to.level).toBe('error');
    expect(to.detail).toBe('超过 10 分钟');
  });

  it('提交与合并：标题含短 sha 与分支走向，合并失败为 error', () => {
    const log = make();
    const c = log.report({ type: 'git.commit', source: 'finish', sessionId: 's1', data: { sha: 'abc1234def', subject: 'feat: x', branch: 'wt/a' } })!;
    expect(c).toMatchObject({ level: 'success', title: '提交 abc1234' });
    const m = log.report({ type: 'git.merge', source: 'finish', sessionId: 's1', data: { from: 'wt/a', into: 'main', ok: true } })!;
    expect(m).toMatchObject({ level: 'success', title: '合并完成 wt/a → main' });
    const f = log.report({ type: 'git.merge', source: 'finish', sessionId: 's1', data: { from: 'wt/a', into: 'main', ok: false, conflicts: 2 } })!;
    expect(f).toMatchObject({ level: 'error', title: '合并失败 wt/a → main' });
  });
});

describe('辅助函数', () => {
  it('cwdTail 兼容两种分隔符与末尾分隔符', () => {
    expect(cwdTail('D:\\a\\b\\proj')).toBe('proj');
    expect(cwdTail('/a/b/proj/')).toBe('proj');
    expect(cwdTail(undefined)).toBeUndefined();
  });

  it('toolCountsText 按次数降序', () => {
    expect(toolCountsText({ Bash: 4, Edit: 5, Read: 1 })).toBe('Edit×5 Bash×4 Read×1');
  });
});

describe('ActivityLog 工具调用合并', () => {
  it('连续工具调用并入同一条 tool.batch：计数、各工具次数、最近 3 条摘要，rev 递增且不占新位置', () => {
    const log = make();
    const first = log.recordTool('s1', 'Edit', 'src/a.ts')!;
    for (const [t, s] of [['Bash', 'npm test'], ['Edit', 'src/b.ts'], ['Read', 'README.md'], ['Edit', 'src/c.ts']]) {
      clock += 1000;
      log.recordTool('s1', t, s);
    }
    expect(log.size).toBe(1);
    const e = log.get(first.id)!;
    expect(e.rev).toBe(5);
    expect(e.seq).toBe(first.seq);
    expect(e.updatedAt).toBe(clock);
    expect(e.title).toBe('调用 5 次工具');
    expect(e.detail).toBe('Edit×3 Bash×1 Read×1');
    expect((e.data as { recent: string[] }).recent).toEqual(['Edit：src/b.ts', 'Read：README.md', 'Edit：src/c.ts']);
  });

  it('关闭条件：非工具事件、间隔超过 5 分钟、计数达到上限', () => {
    const log = make();
    log.recordTool('s1', 'Bash', 'ls');
    log.recordTool('s2', 'Bash', 'ls');
    log.report({ type: 'wait.permission', source: 'session', sessionId: 's1', data: { toolName: 'Bash' } });
    log.recordTool('s1', 'Bash', 'ls');
    log.recordTool('s2', 'Bash', 'pwd');
    const batches = log.query({ types: ['tool.batch'] }).events;
    expect(batches.filter(e => e.sessionId === 's1')).toHaveLength(2);
    expect(batches.filter(e => e.sessionId === 's2')).toHaveLength(1);

    clock += BATCH_GAP_MS + 1;
    log.recordTool('s2', 'Read', 'a');
    expect(log.query({ types: ['tool.batch'], sessionIds: ['s2'] }).events).toHaveLength(2);

    const capLog = make();
    for (let i = 0; i < BATCH_MAX_COUNT + 3; i++) capLog.recordTool('s1', 'Read', `f${i}`);
    const caps = capLog.query({ types: ['tool.batch'] }).events;
    expect(caps).toHaveLength(2);
    expect((caps[1].data as { count: number }).count).toBe(BATCH_MAX_COUNT);
    expect((caps[0].data as { count: number }).count).toBe(3);
  });

  it('工具摘要打码', () => {
    const log = make();
    const e = log.recordTool('s1', 'Bash', 'mysql -u root --password=topsecret')!;
    expect(JSON.stringify(e)).not.toContain('topsecret');
  });
});

describe('ActivityLog 容量与淘汰', () => {
  it('环形淘汰：超过上限丢最旧', () => {
    const log = make({ maxEvents: 5 });
    for (let i = 0; i < 8; i++) log.report({ type: 'turn.start', source: 's', sessionId: 's1', detail: `#${i}` });
    expect(log.size).toBe(5);
    const r = log.query();
    expect(r.events.map(e => e.detail)).toEqual(['#7', '#6', '#5', '#4', '#3']);
  });

  it('14 天淘汰：新事件写入时清掉过期的', () => {
    const log = make();
    log.report({ type: 'turn.start', source: 's', detail: 'old' });
    clock += ACTIVITY_MAX_AGE_MS + 1;
    log.report({ type: 'turn.start', source: 's', detail: 'new' });
    expect(log.query().events.map(e => e.detail)).toEqual(['new']);
  });
});

describe('ActivityLog 推送', () => {
  it('250ms 批量合并：同 id 只推最新版本，按 seq 升序', () => {
    vi.useFakeTimers();
    const log = make();
    const pushes: ActivityPush[] = [];
    log.subscribe(p => pushes.push(p));
    log.report({ type: 'turn.start', source: 's', sessionId: 's1' });
    for (let i = 0; i < 20; i++) log.recordTool('s1', 'Read', `f${i}`);
    expect(pushes).toHaveLength(0);
    vi.advanceTimersByTime(PUSH_DELAY_MS);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].upserts).toHaveLength(2);
    expect(pushes[0].upserts[0].type).toBe('turn.start');
    expect(pushes[0].upserts[1]).toMatchObject({ type: 'tool.batch', rev: 20 });
    log.dispose();
  });

  it('无订阅者时不排队；watch 每次写入同步回调并区分新增与更新', () => {
    const log = make();
    const seen: string[] = [];
    log.watch((e, fresh) => seen.push(`${e.type}:${fresh ? 'new' : 'upd'}`));
    log.recordTool('s1', 'Bash');
    log.recordTool('s1', 'Bash');
    log.report({ type: 'turn.end', source: 's', sessionId: 's1' });
    expect(seen).toEqual(['tool.batch:new', 'tool.batch:upd', 'turn.end:new']);
  });

  it('清空：订阅者收到 cleared 推送，seq 不回退', () => {
    const log = make();
    const pushes: ActivityPush[] = [];
    log.subscribe(p => pushes.push(p));
    log.report({ type: 'turn.start', source: 's' });
    log.flushPush();
    log.clear();
    log.flushPush();
    expect(pushes[pushes.length - 1]).toMatchObject({ upserts: [], cleared: true });
    expect(log.size).toBe(0);
    expect(log.report({ type: 'turn.start', source: 's' })!.seq).toBe(2);
  });
});

describe('ActivityLog 查询', () => {
  it('倒序分页：beforeSeq、limit、hasMore、latestSeq', () => {
    const log = make();
    for (let i = 0; i < 12; i++) log.report({ type: 'turn.start', source: 's', sessionId: i % 2 ? 'a' : 'b' });
    const p1 = log.query({ limit: 5 });
    expect(p1.events.map(e => e.seq)).toEqual([12, 11, 10, 9, 8]);
    expect(p1.hasMore).toBe(true);
    expect(p1.latestSeq).toBe(12);
    const p3 = log.query({ limit: 5, beforeSeq: 3 });
    expect(p3.events.map(e => e.seq)).toEqual([2, 1]);
    expect(p3.hasMore).toBe(false);
    expect(log.query({ limit: 0 }).events).toHaveLength(12);
  });

  it('过滤：会话、类型、仅需关注', () => {
    const log = make();
    log.report({ type: 'turn.start', source: 's', sessionId: 'a' });
    log.report({ type: 'wait.permission', source: 's', sessionId: 'a', data: { toolName: 'Bash' } });
    log.report({ type: 'session.error', source: 's', sessionId: 'b' });
    log.report({ type: 'budget.alert', source: 'usage', data: { scope: 'daily', used: 1, limit: 1, unit: 'usd', threshold: 100 } });
    expect(log.query({ sessionIds: ['a'] }).events).toHaveLength(2);
    expect(log.query({ types: ['session.error', 'turn.start'] }).events).toHaveLength(2);
    expect(log.query({ attentionOnly: true }).events.map(e => e.type)).toEqual(['budget.alert', 'session.error', 'wait.permission']);
    expect(log.query({ sessionIds: ['b'], attentionOnly: true }).events).toHaveLength(1);
  });

  it('sessions 列出出现过的会话，按最近事件倒序并带存活状态', () => {
    const log = make();
    log.report({ type: 'turn.start', source: 's', sessionId: 'a' });
    log.report({ type: 'turn.start', source: 's', sessionId: 'dead' });
    log.report({ type: 'turn.start', source: 's', sessionId: 'a' });
    expect(log.sessions()).toEqual([
      { id: 'a', label: '会话-a', alive: true },
      { id: 'dead', label: '会话-dead', alive: false },
    ]);
  });
});

describe('ActivityLog 落盘', () => {
  it('防抖追加 JSONL，flushSync 立即写；重载后历史与 seq 延续，原地更新取最后版本', () => {
    const file = newFile();
    const log = make({ file });
    log.report({ type: 'session.start', source: 'session', sessionId: 's1' });
    log.recordTool('s1', 'Bash', 'ls');
    log.recordTool('s1', 'Read', 'a');
    expect(fs.existsSync(file)).toBe(false);
    log.flushSync();
    expect(readLines(file)).toHaveLength(2);
    log.recordTool('s1', 'Edit', 'b');
    log.dispose();
    expect(readLines(file)).toHaveLength(3);

    const again = make({ file });
    expect(again.size).toBe(2);
    expect(again.query({ types: ['tool.batch'] }).events[0]).toMatchObject({ rev: 3, title: '调用 3 次工具' });
    expect(again.report({ type: 'turn.end', source: 's' })!.seq).toBe(3);
  });

  it('损坏行与字段不合法的行跳过，启动后压缩重写', () => {
    const file = newFile();
    const log = make({ file });
    log.report({ type: 'turn.start', source: 's', detail: 'ok' });
    log.dispose();
    fs.appendFileSync(file, '{坏行\n{"id":"x","seq":9}\n\n');
    const again = make({ file });
    expect(again.size).toBe(1);
    expect(readLines(file)).toHaveLength(1);
  });

  it('重载时裁剪到上限与 14 天', () => {
    const file = newFile();
    const log = make({ file });
    log.report({ type: 'turn.start', source: 's', detail: 'old' });
    clock += 1000;
    for (let i = 0; i < 4; i++) log.report({ type: 'turn.start', source: 's', detail: `#${i}` });
    log.dispose();
    clock += ACTIVITY_MAX_AGE_MS - 500;
    const again = make({ file, maxEvents: 3 });
    expect(again.query().events.map(e => e.detail)).toEqual(['#3', '#2', '#1']);
    expect(readLines(file)).toHaveLength(3);
  });

  it('行数超过上限两倍时整体压缩重写', () => {
    const file = newFile();
    const log = make({ file, maxEvents: 3 });
    for (let i = 0; i < 7; i++) {
      log.report({ type: 'turn.start', source: 's', detail: `#${i}` });
      log.flushSync();
    }
    expect(readLines(file).length).toBeLessThanOrEqual(6);
    log.dispose();
    expect(make({ file, maxEvents: 3 }).query().events.map(e => e.detail)).toEqual(['#6', '#5', '#4']);
  });

  it('无法读取（路径是目录）时改名为 .bad-时间戳 后从空开始', () => {
    const file = newFile();
    fs.mkdirSync(file, { recursive: true });
    const log = make({ file });
    expect(log.size).toBe(0);
    expect(fs.existsSync(`${file}.bad-${clock}`)).toBe(true);
    log.report({ type: 'turn.start', source: 's' });
    log.dispose();
    expect(readLines(file)).toHaveLength(1);
  });

  it('清空同时清空磁盘文件', () => {
    const file = newFile();
    const log = make({ file });
    log.report({ type: 'turn.start', source: 's' });
    log.flushSync();
    log.clear();
    expect(fs.readFileSync(file, 'utf8')).toBe('');
    expect(make({ file }).size).toBe(0);
  });
});
