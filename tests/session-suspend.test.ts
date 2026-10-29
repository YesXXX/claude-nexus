import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionManager } from '../src/main/session-manager';
import { SessionRecordStore } from '../src/main/session-record-store';
import { projectDirName } from '../src/main/claude-paths';
import type { PtyFactory, PtyProcess, SessionRecord } from '../src/shared/types';

class MockPty implements PtyProcess {
  private exitCbs: Array<(c: number | null) => void> = [];
  static nextPid = 7000;
  readonly pid: number = MockPty.nextPid++;
  constructor(public file: string, public args: string[]) {}
  write(): void { /* 不需要 */ }
  kill(): void { /* 退出由用例手动触发 */ }
  onData(): void { /* 不需要 */ }
  onExit(cb: (c: number | null) => void): void { this.exitCbs.push(cb); }
  emitExit(code: number | null): void { this.exitCbs.forEach(cb => cb(code)); }
}

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-susp-'));
process.env.CLAUDE_PANEL_HOME = TEST_HOME;
const CAPS = { version: 't', resume: true, sessionId: true, forkSession: true, name: true, probedAt: 0 };

let seq = 0;
const uuid = (): string => `bbbbbbbb-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function setup(): { m: SessionManager; store: SessionRecordStore; ptys: MockPty[]; projects: string; clock: { t: number } } {
  const ptys: MockPty[] = [];
  const factory: PtyFactory = { spawn: (file, args) => { const p = new MockPty(file, args); ptys.push(p); return p; } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-susp-rec-'));
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects);
  const clock = { t: 1000 };
  const store = new SessionRecordStore(path.join(root, 'records'), { now: () => clock.t, deferMs: 60_000 });
  store.load();
  const m = new SessionManager({
    ptyFactory: factory, hookClientPath: 'x', mockClaudePath: 'y', now: () => clock.t,
    caps: () => CAPS, newUuid: uuid, projectsRoot: () => projects, records: store,
  });
  return { m, store, ptys, projects, clock };
}

function writeTranscript(projects: string, cwd: string, id: string): void {
  const dir = path.join(projects, projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), '{"type":"user"}\n');
}

function suspendedRecord(id: string, claudeId: string, createdAt: number): SessionRecord {
  return {
    version: 1, id, label: `保留 ${id}`, cwd: TEST_HOME, createdAt, updatedAt: createdAt, lastActiveAt: createdAt,
    state: 'suspended', restoreReason: 'quit', lastStatus: 'completed', claudeSessionId: claudeId,
    claudeSessionIds: [claudeId], turns: 3, resumeCount: 0,
  };
}

describe('退出前保留与结束', () => {
  it('liveManagedIds 只含进程存活的托管会话，不含已退出与只读认领', () => {
    const { m, ptys } = setup();
    const a = m.createSession({ label: 'a', cwd: TEST_HOME });
    const b = m.createSession({ label: 'b', cwd: TEST_HOME });
    ptys[1].emitExit(0);
    m.adoptSession({ id: 'orphan', label: 'o', cwd: TEST_HOME, status: 'running', statusSince: 1, createdAt: 1, escalated: false, readOnly: true }, 42);
    expect(m.liveManagedIds()).toEqual([a.id]);
    expect(b.id).toBeTruthy();
  });

  it('suspendAll 把存活会话记录转 suspended 并写原因；之后进程退出不覆盖记录', () => {
    const { m, store, ptys } = setup();
    const a = m.createSession({ label: 'a', cwd: TEST_HOME });
    const b = m.createSession({ label: 'b', cwd: TEST_HOME });
    ptys[1].emitExit(0);
    expect(m.suspendAll('update')).toEqual([a.id]);
    expect(store.get(a.id)).toMatchObject({ state: 'suspended', restoreReason: 'update' });
    expect(store.get(b.id)!.state).toBe('exited');
    m.disposeAll();
    ptys[0].emitExit(1);
    expect(store.get(a.id)).toMatchObject({ state: 'suspended', restoreReason: 'update' });
    expect(store.get(a.id)!.exitCode).toBeUndefined();
  });

  it('endAll 把存活会话记录转 ended(quit_end)，已退出的行不动', () => {
    const { m, store, ptys, clock } = setup();
    const a = m.createSession({ label: 'a', cwd: TEST_HOME });
    const b = m.createSession({ label: 'b', cwd: TEST_HOME });
    ptys[1].emitExit(0);
    clock.t = 5000;
    expect(m.endAll()).toEqual([a.id]);
    expect(store.get(a.id)).toMatchObject({ state: 'ended', endReason: 'quit_end', endedAt: 5000 });
    expect(store.get(b.id)!.state).toBe('exited');
    ptys[0].emitExit(0);
    expect(store.get(a.id)!.state).toBe('ended');
  });
});

describe('无进程行与批量续接', () => {
  it('addDormant 只加行不拉进程，重复 id 忽略', () => {
    const { m, ptys } = setup();
    const rec = suspendedRecord('d1', uuid(), 10);
    const s = m.addDormant(rec, { id: 'd1', state: 'suspended', restoreReason: 'quit' });
    expect(s).toMatchObject({ id: 'd1', status: 'suspended', dormant: true, turns: 3 });
    expect(ptys).toHaveLength(0);
    expect(m.getSessionOutput('d1')).toBe('');
    expect(m.isProcessAlive('d1')).toBe(false);
    expect(m.addDormant(rec, { id: 'd1', state: 'suspended' })).toBeUndefined();
    expect(m.liveManagedIds()).toEqual([]);
  });

  it('restoreSessions 按创建时间逐个续接并间隔拉起；记录缺失的返回失败、不改为全新开始', async () => {
    const { m, store, ptys, projects } = setup();
    const c1 = uuid(); const c2 = uuid(); const c3 = uuid();
    for (const [id, cid, at] of [['r2', c2, 20], ['r1', c1, 10], ['r3', c3, 30]] as const) {
      const rec = suspendedRecord(id, cid, at);
      store.upsert(rec);
      m.addDormant(rec, { id, state: 'suspended', restoreReason: 'quit' });
    }
    writeTranscript(projects, TEST_HOME, c1);
    writeTranscript(projects, TEST_HOME, c2);
    const progress: Array<[number, number]> = [];
    const started = Date.now();
    const r = await m.restoreSessions('all', 30, (d, t) => progress.push([d, t]));
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(r.started).toEqual(['r1', 'r2']);
    expect(r.failed.map(f => f.id)).toEqual(['r3']);
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(ptys.map(p => p.args.join(' '))).toEqual([
      expect.stringContaining(`--resume ${c1}`), expect.stringContaining(`--resume ${c2}`),
    ]);
    const s1 = m.getSession('r1')!;
    expect(s1.status).toBe('running');
    expect(s1.dormant).toBeUndefined();
    expect(s1.restoreReason).toBeUndefined();
    expect(m.getSession('r3')!.status).toBe('suspended');
    expect(store.get('r1')).toMatchObject({ state: 'live' });
    expect(store.get('r1')!.restoreReason).toBeUndefined();
    expect(store.get('r3')!.state).toBe('suspended');
  });

  it('续接无进程行时补建会话目录里的 settings.json 与 metadata.json', async () => {
    const { m, store, projects } = setup();
    const cid = uuid();
    const rec = suspendedRecord('fresh-dir', cid, 1);
    store.upsert(rec);
    m.addDormant(rec, { id: 'fresh-dir', state: 'suspended' });
    writeTranscript(projects, TEST_HOME, cid);
    const dir = path.join(TEST_HOME, 'sessions', 'fresh-dir');
    fs.rmSync(dir, { recursive: true, force: true });
    const r = await m.restoreSessions(['fresh-dir'], 0);
    expect(r.started).toEqual(['fresh-dir']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).hooks).toHaveProperty('Stop');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'))).toMatchObject({ id: 'fresh-dir' });
  });

  it('只续接 suspended 行；进入关闭状态后停止后续拉起', async () => {
    const { m, store, ptys, projects } = setup();
    const ids = ['k1', 'k2'];
    for (const [i, id] of ids.entries()) {
      const cid = uuid();
      const rec = suspendedRecord(id, cid, i);
      store.upsert(rec);
      m.addDormant(rec, { id, state: 'suspended' });
      writeTranscript(projects, TEST_HOME, cid);
    }
    const live = m.createSession({ label: 'live', cwd: TEST_HOME });
    const p = m.restoreSessions([live.id, 'k1', 'k2'], 40);
    await new Promise(r => setTimeout(r, 10));
    m.disposeAll();
    const r = await p;
    expect(r.started).toEqual(['k1']);
    expect(ptys).toHaveLength(2);
  });

  it('archive：结束无进程行时记录转 ended(killed)', () => {
    const { m, store } = setup();
    const rec = suspendedRecord('z', uuid(), 1);
    store.upsert(rec);
    m.addDormant(rec, { id: 'z', state: 'suspended' });
    m.killSession('z');
    expect(m.getSession('z')).toBeUndefined();
    expect(store.get('z')).toMatchObject({ state: 'ended', endReason: 'killed' });
  });
});
