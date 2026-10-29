import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionManager } from '../src/main/session-manager';
import { RESUME_MESSAGES } from '../src/main/resume-check';
import { projectDirName } from '../src/main/claude-paths';
import type { PtyFactory, PtyProcess } from '../src/shared/types';
import type { SubagentTracker } from '../src/main/subagent-tracker';

class MockPty implements PtyProcess {
  written: string[] = [];
  private dataCbs: Array<(c: string) => void> = [];
  private exitCbs: Array<(c: number | null) => void> = [];
  killed = false;
  static nextPid = 20000;
  readonly pid: number = MockPty.nextPid++;
  constructor(public file: string, public args: string[], public options: { cwd: string; env: Record<string, string> }) {}
  write(d: string): void { this.written.push(d); }
  kill(): void { this.killed = true; }
  onData(cb: (c: string) => void): void { this.dataCbs.push(cb); }
  onExit(cb: (c: number | null) => void): void { this.exitCbs.push(cb); }
  emitData(chunk: string): void { this.dataCbs.forEach(cb => cb(chunk)); }
  emitExit(code: number | null): void { this.exitCbs.forEach(cb => cb(code)); }
}

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-resume-'));
process.env.CLAUDE_PANEL_HOME = TEST_HOME;
const PROJECTS = path.join(TEST_HOME, 'projects');
const WORK = path.join(TEST_HOME, 'work');
fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

const FULL_CAPS = { version: 't', resume: true, sessionId: true, forkSession: true, name: true, probedAt: 0 };
const NO_ID_CAPS = { ...FULL_CAPS, sessionId: false, forkSession: false };

let uuidSeq = 0;
function uuid(): string {
  uuidSeq += 1;
  return `00000000-0000-4000-8000-${String(uuidSeq).padStart(12, '0')}`;
}

/** 在对话记录根目录下写一份非空记录，模拟 CLI 已保存过这段对话 */
function writeTranscript(cwd: string, claudeId: string, content = '{"type":"user"}\n'): string {
  const dir = path.join(PROJECTS, projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${claudeId}.jsonl`);
  fs.writeFileSync(file, content);
  return file;
}

interface Harness {
  m: SessionManager;
  ptys: MockPty[];
  tracker: { aborted: string[]; cleared: string[] };
}

function harness(extra: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}): Harness {
  const ptys: MockPty[] = [];
  const factory: PtyFactory = {
    spawn: (file, args, options) => { const p = new MockPty(file, args, options); ptys.push(p); return p; },
  };
  const tracker = { aborted: [] as string[], cleared: [] as string[] };
  const fakeTracker = {
    abortChildren: (id: string) => { tracker.aborted.push(id); },
    clearSession: (id: string) => { tracker.cleared.push(id); },
    handleHook: () => undefined,
    getSubagents: () => [],
  } as unknown as SubagentTracker;
  const m = new SessionManager({
    ptyFactory: factory, hookClientPath: 'x', mockClaudePath: 'y',
    caps: () => FULL_CAPS, newUuid: uuid, projectsRoot: () => PROJECTS,
    subagentTracker: fakeTracker, ...extra,
  });
  return { m, ptys, tracker };
}

describe('重启会话：续接与全新开始', () => {
  it('续接带 --resume 原 id，面板 id 与 Claude 会话 id 不变，子代理不清空', () => {
    const { m, ptys, tracker } = harness();
    const s = m.createSession({ label: '续接', cwd: WORK });
    const claudeId = s.claudeSessionId!;
    writeTranscript(WORK, claudeId);
    ptys[0].emitExit(0);
    expect(m.checkResume(s.id)).toMatchObject({ resumable: true, transcript: 'found', canFork: true });

    const r = m.restartSession(s.id);
    expect(r).toEqual({ ok: true, mode: 'resume' });
    const args = ptys[1].args;
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe(claudeId);
    expect(args).not.toContain('--session-id');
    const cur = m.getSession(s.id)!;
    expect(cur.claudeSessionId).toBe(claudeId);
    expect(cur.status).toBe('running');
    expect(tracker.cleared).not.toContain(s.id);
    expect(tracker.aborted).toContain(s.id);
  });

  it('全新开始换新 id、清掉子代理与记录路径，旧 id 留在历史里', () => {
    const { m, ptys, tracker } = harness();
    const s = m.createSession({ label: '全新', cwd: WORK });
    const oldId = s.claudeSessionId!;
    ptys[0].emitExit(1);
    const r = m.restartSession(s.id, { mode: 'fresh' });
    expect(r.ok).toBe(true);
    const cur = m.getSession(s.id)!;
    expect(cur.claudeSessionId).not.toBe(oldId);
    expect(cur.claudeSessionIds).toEqual([oldId, cur.claudeSessionId]);
    expect(cur.claudeTranscriptPath).toBeUndefined();
    expect(ptys[1].args).toContain('--session-id');
    expect(ptys[1].args).not.toContain('--resume');
    expect(tracker.cleared).toContain(s.id);
  });

  it('没有 id 时不能续接，只能全新开始', () => {
    const { m, ptys } = harness({ caps: () => NO_ID_CAPS });
    const s = m.createSession({ label: '无 id', cwd: WORK });
    ptys[0].emitExit(0);
    expect(m.checkResume(s.id)).toMatchObject({ resumable: false, reason: 'no_id', canFresh: true });
    expect(m.restartSession(s.id)).toMatchObject({ ok: false, reason: 'no_id' });
    expect(ptys.length).toBe(1);
    expect(m.restartSession(s.id, { mode: 'fresh' }).ok).toBe(true);
  });

  it('对话记录缺失时不能续接，也不拉起进程', () => {
    const { m, ptys } = harness();
    const s = m.createSession({ label: '无记录', cwd: WORK });
    ptys[0].emitExit(0);
    expect(m.checkResume(s.id)).toMatchObject({ resumable: false, reason: 'no_transcript', transcript: 'missing' });
    expect(m.restartSession(s.id)).toMatchObject({ ok: false, reason: 'no_transcript', message: RESUME_MESSAGES.noTranscript });
    expect(ptys.length).toBe(1);
  });

  it('同一 Claude 会话 id 正被另一存活会话使用时判为占用', () => {
    const { m, ptys } = harness();
    const a = m.createSession({ label: '甲', cwd: WORK });
    const b = m.createSession({ label: '乙', cwd: WORK });
    writeTranscript(WORK, a.claudeSessionId!);
    ptys[1].emitExit(0);
    // 乙的 hook 上报了甲的 id（模拟同一对话被两处使用）
    m.handleHookMessage({ sessionId: b.id, event: { type: 'tool_finished' }, claudeSessionId: a.claudeSessionId });
    expect(m.checkResume(b.id)).toMatchObject({ resumable: false, reason: 'in_use', inUseBy: { id: a.id, label: '甲' } });
    expect(m.restartSession(b.id).ok).toBe(false);
  });

  it('进程仍在运行：判为 busy，不带 force 拒绝，带 force 结束旧进程再续接', () => {
    const { m, ptys } = harness();
    const s = m.createSession({ label: '运行中', cwd: WORK });
    writeTranscript(WORK, s.claudeSessionId!);
    expect(m.checkResume(s.id)).toMatchObject({ resumable: false, reason: 'busy' });
    expect(m.restartSession(s.id)).toMatchObject({ ok: false, reason: 'busy' });
    expect(m.restartSession(s.id, { mode: 'fresh' })).toMatchObject({ ok: false, reason: 'busy' });
    expect(ptys[0].killed).toBe(false);
    expect(m.restartSession(s.id, { mode: 'resume', force: true }).ok).toBe(true);
    expect(ptys[0].killed).toBe(true);
    expect(ptys.length).toBe(2);
  });

  it('只读认领会话不能续接也不能全新开始', () => {
    const { m } = harness();
    m.adoptSession({
      id: 'ro1', label: '认领', cwd: WORK, status: 'running', statusSince: 1, createdAt: 1, escalated: false,
      readOnly: true, claudeSessionId: uuid(),
    });
    expect(m.checkResume('ro1')).toMatchObject({ resumable: false, reason: 'readonly', canFresh: false });
    expect(m.restartSession('ro1', { mode: 'fresh' }).ok).toBe(false);
  });

  it('工作目录不存在时拒绝', () => {
    const { m, ptys } = harness();
    const gone = path.join(TEST_HOME, 'gone');
    fs.mkdirSync(gone);
    const s = m.createSession({ label: '目录没了', cwd: gone });
    ptys[0].emitExit(0);
    fs.rmSync(gone, { recursive: true });
    expect(m.checkResume(s.id)).toMatchObject({ reason: 'cwd_missing', canFresh: false });
    expect(m.restartSession(s.id, { mode: 'fresh' })).toMatchObject({ ok: false, reason: 'cwd_missing' });
  });

  it('不存在的会话返回 not_found', () => {
    const { m } = harness();
    expect(m.restartSession('nope')).toMatchObject({ ok: false, reason: 'not_found' });
    expect(m.checkResume('nope')).toBeUndefined();
  });
});

describe('续接确认期', () => {
  function resumed(extra: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}): Harness & { id: string; claudeId: string } {
    const h = harness(extra);
    const s = h.m.createSession({ label: '确认', cwd: WORK });
    writeTranscript(WORK, s.claudeSessionId!);
    h.ptys[0].emitExit(0);
    expect(h.m.restartSession(s.id).ok).toBe(true);
    return { ...h, id: s.id, claudeId: s.claudeSessionId! };
  }

  it('确认前非 0 退出且输出含 No conversation found：记为找不到对话，状态转 error', () => {
    const { m, ptys, id, claudeId } = resumed();
    ptys[1].emitData(`\x1b[31mNo conversation found with session ID: ${claudeId}\x1b[0m\r\n`);
    ptys[1].emitExit(1);
    const cur = m.getSession(id)!;
    expect(cur.status).toBe('error');
    expect(cur.resumeFailure).toMatchObject({ reason: 'no_transcript', exitCode: 1 });
    expect(cur.resumeFailure!.detail).toContain('No conversation found');
    expect(cur.resumeFailure!.detail).not.toContain('\x1b');
  });

  it('确认前非 0 退出但没有特征输出：记为立即退出', () => {
    const { m, ptys, id } = resumed();
    ptys[1].emitData('boom\r\n');
    ptys[1].emitExit(3);
    expect(m.getSession(id)!.resumeFailure).toMatchObject({ reason: 'exited_early', exitCode: 3 });
  });

  it('收到 SessionStart 后结束确认期，之后的退出不算续接失败', () => {
    const { m, ptys, id, claudeId } = resumed();
    m.handleHookMessage({ sessionId: id, event: { type: 'session_started', source: 'resume' }, claudeSessionId: claudeId });
    ptys[1].emitExit(1);
    const cur = m.getSession(id)!;
    expect(cur.status).toBe('error');
    expect(cur.resumeFailure).toBeUndefined();
  });

  it('确认期超时视为成功', async () => {
    const { m, ptys, id } = resumed({ resumeConfirmMs: 20 });
    await new Promise(r => setTimeout(r, 60));
    ptys[1].emitExit(1);
    expect(m.getSession(id)!.resumeFailure).toBeUndefined();
  });

  it('确认前以 0 退出不判为失败', () => {
    const { m, ptys, id } = resumed();
    ptys[1].emitExit(0);
    expect(m.getSession(id)!.resumeFailure).toBeUndefined();
    expect(m.getSession(id)!.status).toBe('completed');
  });

  it('再次重启会清掉上一次的续接失败；旧进程迟到的退出不影响新进程', () => {
    const { m, ptys, id } = resumed();
    ptys[1].emitExit(1);
    expect(m.getSession(id)!.resumeFailure).toBeDefined();
    expect(m.restartSession(id).ok).toBe(true);
    expect(m.getSession(id)!.resumeFailure).toBeUndefined();
    ptys[1].emitExit(1);   // 已被替换的进程再次回调
    const cur = m.getSession(id)!;
    expect(cur.status).toBe('running');
    expect(cur.resumeFailure).toBeUndefined();
  });

  it('force 续接时被结束的旧进程迟到退出，不会被当成新进程的续接失败', () => {
    const h = harness();
    const s = h.m.createSession({ label: '强制', cwd: WORK });
    writeTranscript(WORK, s.claudeSessionId!);
    expect(h.m.restartSession(s.id, { mode: 'resume', force: true }).ok).toBe(true);
    h.ptys[0].emitExit(1);
    const cur = h.m.getSession(s.id)!;
    expect(cur.status).toBe('running');
    expect(cur.resumeFailure).toBeUndefined();
  });
});
