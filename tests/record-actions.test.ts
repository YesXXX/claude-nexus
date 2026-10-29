import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionManager } from '../src/main/session-manager';
import { SessionRecordStore } from '../src/main/session-record-store';
import { createGitRunner } from '../src/main/git-runner';
import { WorktreeManager } from '../src/main/worktree-manager';
import { projectDirName } from '../src/main/claude-paths';
import {
  asRecordResumeOptions, deleteRecords, forkLabel, renameRecord, resumeRecord, type RecordActionDeps,
} from '../src/main/record-actions';
import type { CliCapabilities } from '../src/main/cli-capabilities';
import type { PtyFactory, PtyProcess } from '../src/shared/types';

class MockPty implements PtyProcess {
  private exitCbs: Array<(c: number | null) => void> = [];
  static nextPid = 12000;
  readonly pid: number = MockPty.nextPid++;
  constructor(public file: string, public args: string[], public options: { cwd: string }) {}
  write(): void { /* 不需要 */ }
  kill(): void { /* 退出由用例手动触发 */ }
  onData(): void { /* 不需要 */ }
  onExit(cb: (c: number | null) => void): void { this.exitCbs.push(cb); }
  emitExit(code: number | null): void { this.exitCbs.forEach(cb => cb(code)); }
}

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-recact-'));
process.env.CLAUDE_PANEL_HOME = TEST_HOME;
const FULL_CAPS: CliCapabilities = { version: 't', resume: true, sessionId: true, forkSession: true, name: true, probedAt: 0 };

let seq = 0;
const uuid = (): string => `dddddddd-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

interface Harness {
  m: SessionManager; store: SessionRecordStore; ptys: MockPty[]; projects: string; deps: RecordActionDeps; cwd: string;
}

function harness(caps: CliCapabilities = FULL_CAPS): Harness {
  const ptys: MockPty[] = [];
  const factory: PtyFactory = { spawn: (file, args, options) => { const p = new MockPty(file, args, options); ptys.push(p); return p; } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-recact-home-'));
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects);
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-recact-cwd-')));
  const store = new SessionRecordStore(path.join(root, 'records'));
  store.load();
  const wm = new WorktreeManager({ git: createGitRunner(), registryFile: path.join(root, 'worktrees.json'), sleep: async () => {} });
  const m = new SessionManager({
    ptyFactory: factory, hookClientPath: 'x', mockClaudePath: 'y', caps: () => caps, newUuid: uuid,
    projectsRoot: () => projects, records: store,
  });
  const deps: RecordActionDeps = {
    manager: m, records: store, resume: { host: m, worktrees: wm, patchRecord: (id, p) => { store.patch(id, p); } },
  };
  return { m, store, ptys, projects, deps, cwd };
}

function writeTranscript(h: Harness, claudeId: string, body = '{"type":"user"}\n'): void {
  const dir = path.join(h.projects, projectDirName(h.cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${claudeId}.jsonl`), body);
}

/** 新建会话跑完一轮后进程退出；transcript 为 false 时不写对话记录 */
function finishedSession(h: Harness, transcript = true): { id: string; claudeId: string } {
  const s = h.m.createSession({ label: '重构', cwd: h.cwd });
  const claudeId = s.claudeSessionId!;
  if (transcript) writeTranscript(h, claudeId);
  h.ptys[h.ptys.length - 1].emitExit(0);
  return { id: s.id, claudeId };
}

/** 结束会话：从列表移除，记录转入历史 */
function endedSession(h: Harness, transcript = true): { id: string; claudeId: string } {
  const r = finishedSession(h, transcript);
  h.m.killSession(r.id);
  return r;
}

describe('从历史续接', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('已结束记录可做续接检查，带对话记录大小', () => {
    const { id } = endedSession(h);
    expect(h.m.getSession(id)).toBeUndefined();
    const check = h.m.checkResume(id);
    expect(check).toMatchObject({ resumable: true, transcript: 'found', transcriptSize: 16, canFork: true });
  });

  it('续接：沿用面板会话 id 与 Claude 会话 id，以 --resume 拉起，记录转为进行中', async () => {
    const { id, claudeId } = endedSession(h);
    const r = await resumeRecord(h.deps, id, { mode: 'resume' });
    expect(r).toMatchObject({ ok: true, mode: 'resume', sessionId: id });
    expect(h.ptys).toHaveLength(2);
    expect(h.ptys[1].args.join(' ')).toContain(`--resume ${claudeId}`);
    expect(h.m.getSession(id)).toMatchObject({ status: 'running', claudeSessionId: claudeId });
    expect(h.m.getSession(id)!.dormant).toBeUndefined();
    expect(h.store.get(id)).toMatchObject({ state: 'live' });
    expect(h.store.get(id)!.endedAt).toBeUndefined();
  });

  it('对话记录缺失：不拉起进程，撤回放回列表的行，记录仍为已结束', async () => {
    const { id } = endedSession(h, false);
    const r = await resumeRecord(h.deps, id, { mode: 'resume' });
    expect(r).toMatchObject({ ok: false, reason: 'no_transcript' });
    expect(h.ptys).toHaveLength(1);
    expect(h.m.getSession(id)).toBeUndefined();
    expect(h.store.get(id)!.state).toBe('ended');
  });

  it('全新开始：沿用面板会话 id，换新的 Claude 会话 id', async () => {
    const { id, claudeId } = endedSession(h, false);
    const r = await resumeRecord(h.deps, id, { mode: 'fresh' });
    expect(r).toMatchObject({ ok: true, mode: 'fresh', sessionId: id });
    const s = h.m.getSession(id)!;
    expect(s.claudeSessionId).toBeTruthy();
    expect(s.claudeSessionId).not.toBe(claudeId);
    expect(h.ptys[1].args).toContain('--session-id');
    expect(h.ptys[1].args).not.toContain('--resume');
    expect(h.store.get(id)!.claudeSessionIds).toEqual([claudeId, s.claudeSessionId]);
  });

  it('不存在的 id 返回 not_found', async () => {
    const r = await resumeRecord(h.deps, 'nope', { mode: 'resume' });
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('分叉为新会话', () => {
  it('以 --resume 原 id --fork-session 拉起新会话，不预分配 id；原会话不变，记录写明来源', async () => {
    const h = harness();
    const { id, claudeId } = finishedSession(h);
    const before = JSON.stringify(h.m.getSession(id));
    const r = await resumeRecord(h.deps, id, { mode: 'fork' });
    expect(r.ok).toBe(true);
    const forkId = r.sessionId!;
    expect(forkId).not.toBe(id);
    const args = h.ptys[1].args;
    expect(args.join(' ')).toContain(`--resume ${claudeId} --fork-session`);
    expect(args).not.toContain('--session-id');
    const fork = h.m.getSession(forkId)!;
    expect(fork).toMatchObject({ status: 'running', label: '重构（分叉）', cwd: h.cwd });
    expect(fork.claudeSessionId).toBeUndefined();
    expect(h.store.get(forkId)!.forkedFrom).toEqual({ recordId: id, claudeSessionId: claudeId });
    expect(JSON.stringify(h.m.getSession(id))).toBe(before);

    // SessionStart 回填分叉后的新 id
    const newId = uuid();
    h.m.handleHookMessage({ sessionId: forkId, event: { type: 'session_started', source: 'resume' }, claudeSessionId: newId });
    expect(h.m.getSession(forkId)!.claudeSessionId).toBe(newId);
    expect(h.store.get(forkId)!.claudeSessionId).toBe(newId);
  });

  it('从已结束的记录也能分叉，原记录保持已结束', async () => {
    const h = harness();
    const { id } = endedSession(h);
    const r = await resumeRecord(h.deps, id, { mode: 'fork' });
    expect(r.ok).toBe(true);
    expect(h.m.getSession(id)).toBeUndefined();
    expect(h.store.get(id)!.state).toBe('ended');
  });

  it('CLI 不支持 --fork-session 或对话记录缺失：拒绝分叉，不拉起进程', async () => {
    const h = harness({ ...FULL_CAPS, forkSession: false });
    const { id } = finishedSession(h);
    const r = await resumeRecord(h.deps, id, { mode: 'fork' });
    expect(r).toMatchObject({ ok: false, mode: 'fork' });
    expect(r.message).toContain('--fork-session');
    const h2 = harness();
    const b = finishedSession(h2, false);
    const r2 = await resumeRecord(h2.deps, b.id, { mode: 'fork' });
    expect(r2).toMatchObject({ ok: false, reason: 'no_transcript' });
    expect(h.ptys).toHaveLength(1);
    expect(h2.ptys).toHaveLength(1);
  });

  it('分叉标签只加一次后缀', () => {
    expect(forkLabel('a')).toBe('a（分叉）');
    expect(forkLabel('a（分叉）')).toBe('a（分叉）');
  });
});

describe('改名与删除', () => {
  it('列表里的会话连同记录一起改名；只在历史里的只改记录；空标签与未知 id 拒绝', () => {
    const h = harness();
    const live = finishedSession(h);
    const gone = endedSession(h);
    expect(renameRecord(h.deps, live.id, '  新名字  ')).toBe(true);
    expect(h.m.getSession(live.id)!.label).toBe('新名字');
    expect(h.store.get(live.id)!.label).toBe('新名字');
    expect(renameRecord(h.deps, gone.id, '历史名')).toBe(true);
    expect(h.store.get(gone.id)!.label).toBe('历史名');
    expect(renameRecord(h.deps, gone.id, '   ')).toBe(false);
    expect(renameRecord(h.deps, 'nope', 'x')).toBe(false);
    expect(renameRecord(h.deps, 1, 'x')).toBe(false);
    expect(renameRecord(h.deps, live.id, 'x'.repeat(150))).toBe(true);
    expect(h.store.get(live.id)!.label).toHaveLength(100);
  });

  it('只删已结束且不在列表里的记录', () => {
    const h = harness();
    const live = finishedSession(h);
    const gone = endedSession(h);
    expect(deleteRecords(h.deps, [live.id, gone.id, 3, 'nope'])).toEqual([gone.id]);
    expect(h.store.get(gone.id)).toBeUndefined();
    expect(h.store.get(live.id)).toBeDefined();
    expect(deleteRecords(h.deps, 'x')).toEqual([]);
  });

  it('拉起选项只接受已知 mode 与布尔 true', () => {
    expect(asRecordResumeOptions({ mode: 'fork', rebuildWorktree: 'yes' })).toEqual({ mode: 'fork' });
    expect(asRecordResumeOptions({ mode: 'bad', rebuildWorktree: true })).toEqual({ mode: 'resume', rebuildWorktree: true });
    expect(asRecordResumeOptions(null)).toEqual({ mode: 'resume' });
  });
});
