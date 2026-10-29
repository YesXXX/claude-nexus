import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UsageStore, emptyDay, emptyLedger, KEEP_DAYS } from '../src/main/usage-store';
import { localDateOf } from '../src/shared/usage-parse';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-store-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const DAY = 24 * 3600 * 1000;

describe('UsageStore', () => {
  it('不存在时为空账本；flushSync 原子写入后可读回', () => {
    const s = new UsageStore(dir);
    expect(s.load()).toEqual(emptyLedger());
    s.ledger.days['2026-10-17'] = emptyDay();
    s.ledger.days['2026-10-17'].models['claude-opus-5'] = [1, 2, 3, 4, 5, 0];
    s.markDirty();
    expect(s.flushSync()).toBe(true);
    expect(fs.existsSync(s.file + '.tmp')).toBe(false);
    const again = new UsageStore(dir, { now: () => new Date(2026, 9, 17).getTime() });
    expect(again.load().days['2026-10-17'].models['claude-opus-5']).toEqual([1, 2, 3, 4, 5, 0]);
  });

  it('残留的 .tmp（上次写到一半）不影响原文件', () => {
    const s = new UsageStore(dir, { now: () => new Date(2026, 9, 17).getTime() });
    s.load();
    s.ledger.flagged1m.push('claude-sonnet-5');
    s.markDirty();
    s.flushSync();
    fs.writeFileSync(s.file + '.tmp', '{"version":1,"fil');
    const again = new UsageStore(dir);
    expect(again.load().flagged1m).toEqual(['claude-sonnet-5']);
  });

  it('损坏时备份为 ledger.json.bad-<时间> 并重建空账本', () => {
    fs.writeFileSync(path.join(dir, 'ledger.json'), 'not json{');
    const s = new UsageStore(dir);
    expect(s.load()).toEqual(emptyLedger());
    const names = fs.readdirSync(dir);
    expect(names.some(n => n.startsWith('ledger.json.bad-'))).toBe(true);
    expect(names).not.toContain('ledger.json');
  });

  it('版本不对或结构不对同样按损坏处理', () => {
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ version: 9, files: {}, days: {} }));
    const s = new UsageStore(dir);
    expect(s.load()).toEqual(emptyLedger());
    expect(fs.readdirSync(dir).some(n => n.startsWith('ledger.json.bad-'))).toBe(true);
  });

  it('缺字段的文件状态补齐缺省值，非对象条目丢弃', () => {
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({
      version: 1, days: {},
      files: { 'C:\\a.jsonl': { sessionId: 's1' }, 'C:\\b.jsonl': 3 },
    }));
    const s = new UsageStore(dir);
    const l = s.load();
    expect(Object.keys(l.files)).toEqual(['C:\\a.jsonl']);
    expect(l.files['C:\\a.jsonl']).toMatchObject({ offset: 0, recent: [], contrib: {}, kind: 'main', agentId: null });
    expect(l.flagged1m).toEqual([]);
  });

  it('启动时清理 90 天之前的每日数据与长期未提及的已结束文件', () => {
    const now = new Date(2026, 9, 17, 12).getTime();
    const s = new UsageStore(dir, { now: () => now });
    s.load();
    const old = localDateOf(now - (KEEP_DAYS + 1) * DAY);
    const edge = localDateOf(now - (KEEP_DAYS - 1) * DAY);
    s.ledger.days[old] = emptyDay();
    s.ledger.days[edge] = emptyDay();
    s.ledger.days[localDateOf(now)] = emptyDay();
    const file = { sessionId: 'x', kind: 'main' as const, agentId: null, offset: 5, countFrom: 0, recent: [], contrib: {}, observedMax: {} };
    s.ledger.files['old.jsonl'] = { ...file, detached: true, seenAt: now - (KEEP_DAYS + 1) * DAY };
    s.ledger.files['live.jsonl'] = { ...file, seenAt: now - (KEEP_DAYS + 1) * DAY };
    s.ledger.files['recent.jsonl'] = { ...file, detached: true, seenAt: now - DAY };
    s.markDirty();
    s.flushSync();
    const again = new UsageStore(dir, { now: () => now });
    const l = again.load();
    expect(Object.keys(l.days).sort()).toEqual([edge, localDateOf(now)].sort());
    expect(Object.keys(l.files).sort()).toEqual(['live.jsonl', 'recent.jsonl']);
  });

  it('防抖：多次 markDirty 只在到期后写一次；没有改动不写', async () => {
    const s = new UsageStore(dir, { debounceMs: 30 });
    s.load();
    expect(s.flushSync()).toBe(true);
    expect(fs.existsSync(s.file)).toBe(false);
    s.markDirty();
    s.markDirty();
    expect(fs.existsSync(s.file)).toBe(false);
    await new Promise(r => setTimeout(r, 80));
    expect(fs.existsSync(s.file)).toBe(true);
  });

  it('dispose 同步落盘，之后不再定时写', () => {
    const s = new UsageStore(dir, { debounceMs: 10_000 });
    s.load();
    s.markDirty();
    s.dispose();
    expect(fs.existsSync(s.file)).toBe(true);
  });
});
