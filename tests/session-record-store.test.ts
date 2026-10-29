import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { recordFromOrphanMeta, SessionRecordStore } from '../src/main/session-record-store';
import type { SessionRecord } from '../src/shared/types';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'panel-records-'));
}

function rec(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1, id, label: id, cwd: 'D:\\w', createdAt: 1, updatedAt: 1, lastActiveAt: 1,
    state: 'live', lastStatus: 'running', claudeSessionIds: [], turns: 0, resumeCount: 0, ...over,
  };
}

function readFile(dir: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
}

describe('SessionRecordStore 读写', () => {
  it('upsert 原子写入：落盘为格式化 JSON，不留 .tmp', () => {
    const dir = tmpDir();
    const store = new SessionRecordStore(dir, { now: () => 42 });
    store.load();
    store.upsert(rec('a1'));
    expect(readFile(dir, 'a1')).toMatchObject({ id: 'a1', updatedAt: 42 });
    expect(fs.readFileSync(path.join(dir, 'a1.json'), 'utf8')).toContain('\n  "id"');
    expect(fs.readdirSync(dir)).toEqual(['a1.json']);
  });

  it('load：损坏或不认识的文件改名为 .bad，遗留 .tmp 删除，其余读入', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(rec('good')));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'v9.json'), JSON.stringify({ ...rec('v9'), version: 9 }));
    fs.writeFileSync(path.join(dir, 'mismatch.json'), JSON.stringify(rec('other')));
    fs.writeFileSync(path.join(dir, 'x.json.tmp'), '{}');
    const store = new SessionRecordStore(dir);
    expect(store.load()).toEqual({ loaded: 1, skipped: 3 });
    expect(store.get('good')?.label).toBe('good');
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['broken.json.bad', 'good.json', 'mismatch.json.bad', 'v9.json.bad']);
  });

  it('目录不存在时自动创建', () => {
    const dir = path.join(tmpDir(), 'nested', 'records');
    const store = new SessionRecordStore(dir);
    expect(store.load()).toEqual({ loaded: 0, skipped: 0 });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('不合法的 id 不写盘', () => {
    const dir = tmpDir();
    const store = new SessionRecordStore(dir);
    store.upsert(rec('../evil'));
    expect(store.get('../evil')).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('SessionRecordStore.patch', () => {
  it('保留未知字段；值为 undefined 的键被删除', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'p1.json'), JSON.stringify({ ...rec('p1', { transcriptPath: 'x.jsonl' }), pinned: true, tags: ['a'] }));
    const store = new SessionRecordStore(dir);
    store.load();
    store.patch('p1', { label: '新标签', transcriptPath: undefined });
    const disk = readFile(dir, 'p1');
    expect(disk).toMatchObject({ label: '新标签', pinned: true, tags: ['a'] });
    expect('transcriptPath' in disk).toBe(false);
  });

  it('不合法的状态迁移只丢弃状态改动', () => {
    const store = new SessionRecordStore(tmpDir());
    store.upsert(rec('e1', { state: 'ended' }));
    const r = store.patch('e1', { state: 'exited', turns: 3 })!;
    expect(r.state).toBe('ended');
    expect(r.turns).toBe(3);
  });

  it('没有变化时不写盘也不更新时间', () => {
    let t = 1;
    const dir = tmpDir();
    const store = new SessionRecordStore(dir, { now: () => t });
    store.upsert(rec('n1'));
    t = 99;
    store.patch('n1', { label: 'n1' });
    expect(store.get('n1')!.updatedAt).toBe(1);
  });

  it('defer 延迟落盘，flush 时写出', () => {
    const dir = tmpDir();
    const store = new SessionRecordStore(dir, { deferMs: 60_000 });
    store.upsert(rec('d1'));
    store.patch('d1', { lastActiveAt: 777 }, { defer: true });
    expect(store.get('d1')!.lastActiveAt).toBe(777);
    expect(readFile(dir, 'd1').lastActiveAt).toBe(1);
    store.flush();
    expect(readFile(dir, 'd1').lastActiveAt).toBe(777);
  });

  it('延迟中的改动被随后的立即写入一并带上', () => {
    const dir = tmpDir();
    const store = new SessionRecordStore(dir, { deferMs: 60_000 });
    store.upsert(rec('d2'));
    store.patch('d2', { lastActiveAt: 5 }, { defer: true });
    store.patch('d2', { turns: 1 });
    expect(readFile(dir, 'd2')).toMatchObject({ lastActiveAt: 5, turns: 1 });
  });

  it('dispose 写出延迟改动', () => {
    const dir = tmpDir();
    const store = new SessionRecordStore(dir, { deferMs: 60_000 });
    store.upsert(rec('d3'));
    store.patch('d3', { lastStatus: 'waiting_input' }, { defer: true });
    store.dispose();
    expect(readFile(dir, 'd3').lastStatus).toBe('waiting_input');
  });

  it('不存在的记录返回 undefined', () => {
    expect(new SessionRecordStore(tmpDir()).patch('nope', { turns: 1 })).toBeUndefined();
  });
});

describe('SessionRecordStore 删除、清理与通知', () => {
  it('remove 只删 ended', () => {
    const dir = tmpDir();
    const store = new SessionRecordStore(dir);
    store.upsert(rec('live1'));
    store.upsert(rec('end1', { state: 'ended' }));
    expect(store.remove(['live1', 'end1', 'nope'])).toEqual(['end1']);
    expect(fs.existsSync(path.join(dir, 'end1.json'))).toBe(false);
    expect(store.get('live1')).toBeDefined();
  });

  it('prune 按上限删除 ended 记录', () => {
    const store = new SessionRecordStore(tmpDir(), { now: () => 1000 });
    for (let i = 0; i < 5; i++) store.upsert(rec(`h${i}`, { state: 'ended', endedAt: 100 + i }));
    const removed = store.prune({ historyMaxCount: 2, historyMaxDays: 90 });
    expect(removed.sort()).toEqual(['h0', 'h1', 'h2']);
    expect(store.all().map(r => r.id).sort()).toEqual(['h3', 'h4']);
  });

  it('onChange 防抖合并多次改动', async () => {
    const calls: string[][] = [];
    const store = new SessionRecordStore(tmpDir(), { onChange: ids => calls.push(ids.sort()), debounceMs: 20 });
    store.upsert(rec('c1'));
    store.upsert(rec('c2'));
    store.patch('c1', { turns: 2 });
    expect(calls).toEqual([]);
    await new Promise(r => setTimeout(r, 60));
    expect(calls).toEqual([['c1', 'c2']]);
  });

  it('get 返回副本，修改不影响缓存', () => {
    const store = new SessionRecordStore(tmpDir());
    store.upsert(rec('copy'));
    store.get('copy')!.label = '改了';
    expect(store.get('copy')!.label).toBe('copy');
  });

  it('query 委托内存查询', () => {
    const store = new SessionRecordStore(tmpDir());
    store.upsert(rec('q1', { state: 'ended', lastActiveAt: 2 }));
    store.upsert(rec('q2', { state: 'ended', lastActiveAt: 3 }));
    store.upsert(rec('q3'));
    expect(store.query({}).items.map(r => r.id)).toEqual(['q2', 'q1']);
  });
});

describe('recordFromOrphanMeta', () => {
  it('旧版元数据转为 migrated 的 ended 记录', () => {
    const r = recordFromOrphanMeta({ id: 'm1', label: 'L', cwd: 'D:\\p', createdAt: 5, sessionId: 'c2', sessionIds: ['c1'] }, 100)!;
    expect(r).toMatchObject({ id: 'm1', state: 'ended', endReason: 'migrated', endedAt: 100, claudeSessionId: 'c2', lastActiveAt: 5 });
    expect(r.claudeSessionIds).toEqual(['c1', 'c2']);
  });

  it('缺 cwd 或 id 不合法时返回 null', () => {
    expect(recordFromOrphanMeta({ id: 'm2' }, 1)).toBeNull();
    expect(recordFromOrphanMeta({ id: '../x', cwd: 'D:\\p' }, 1)).toBeNull();
  });
});
