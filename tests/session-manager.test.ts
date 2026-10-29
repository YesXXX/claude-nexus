import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionManager, findNodePath } from '../src/main/session-manager';
import { HOOKS_VERSION } from '../src/main/hook-config';
import { SessionRecordStore } from '../src/main/session-record-store';
import { projectDirName } from '../src/main/claude-paths';
import { PtyFactory, PtyProcess, Session, SessionRecord } from '../src/shared/types';
import type { SessionUsageSummary } from '../src/shared/usage-types';

class MockPty implements PtyProcess {
  written: string[] = [];
  private dataCbs: Array<(c: string) => void> = [];
  private exitCbs: Array<(c: number | null) => void> = [];
  killed = false;
  static nextPid = 9000;
  constructor(public file: string, public args: string[], public options: { cwd: string; env: Record<string, string> }) {}
  write(d: string): void { this.written.push(d); }
  kill(): void { this.killed = true; }
  onData(cb: (c: string) => void): void { this.dataCbs.push(cb); }
  onExit(cb: (c: number | null) => void): void { this.exitCbs.push(cb); }
  emitData(chunk: string): void { this.dataCbs.forEach(cb => cb(chunk)); }
  emitExit(code: number | null): void { this.exitCbs.forEach(cb => cb(code)); }
  readonly pid: number = MockPty.nextPid++;
}

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-sm-'));
process.env.CLAUDE_PANEL_HOME = TEST_HOME;

describe('SessionManager', () => {
  let manager: SessionManager;
  let ptys: MockPty[];
  const transitions: Array<{ prev: Session; curr: Session }> = [];

  function makeFactory(): PtyFactory {
    return {
      spawn: (file, args, options) => {
        const p = new MockPty(file, args, options);
        ptys.push(p);
        return p;
      },
    };
  }

  function makeManager(): SessionManager {
    ptys = [];
    return new SessionManager({
      ptyFactory: makeFactory(),
      hookClientPath: 'D:\\fake\\hook-client.js',
      mockClaudePath: 'D:\\fake\\mock-claude.js',
      now: () => 12345,
      onTransition: (prev, curr) => transitions.push({ prev, curr }),
    });
  }

  beforeAll(() => { manager = makeManager(); });

  it('createSession：写 settings/metadata、注入 sessionId 环境变量、状态 running', () => {
    const s = manager.createSession({ label: '重构用户模块', cwd: TEST_HOME });
    expect(s.status).toBe('running');
    expect(s.label).toBe('重构用户模块');
    const dir = path.join(TEST_HOME, 'sessions', s.id);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).hooks).toHaveProperty('Stop');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'))).toMatchObject({ id: s.id, label: '重构用户模块' });
    // Windows 上 node-pty 走 cmd.exe 包装 claude.cmd 并注入 --settings（见 spawnPty）
    if (process.platform === 'win32') {
      expect(ptys[0].file).toBe('cmd.exe');
      expect(ptys[0].args.slice(0, 2)).toEqual(['/c', 'claude.cmd']);
      expect(ptys[0].args).toEqual(['/c', 'claude.cmd', '--settings',
        path.join(TEST_HOME, 'sessions', s.id, 'settings.json')]);
    } else {
      expect(ptys[0].file).toBe('claude');
      expect(ptys[0].args).toContain('--settings');
    }
    expect(ptys[0].options.cwd).toBe(TEST_HOME);
    expect(ptys[0].options.env.CLAUDE_PANEL_SESSION_ID).toBe(s.id);
  });

  it('PTY 输出原样进入 raw 缓冲（xterm 需要原始流，不按行拆分）', () => {
    const s = manager.getSessions()[0];
    ptys[0].emitData('第一行\n第二行\r\n第三行');
    expect(manager.getSessionOutput(s.id)).toBe('第一行\n第二行\r\n第三行');
  });

  it('hook 消息驱动状态机：权限请求 → waiting_permission', () => {
    const s = manager.getSessions()[0];
    manager.handleHookMessage({
      sessionId: s.id,
      event: { type: 'permission_request', toolName: 'Bash', commandText: 'npm test' },
    });
    const curr = manager.getSessions().find(x => x.id === s.id)!;
    expect(curr.status).toBe('waiting_permission');
    expect(curr.pendingAction).toEqual({ toolName: 'Bash', commandText: 'npm test' });
    expect(transitions.at(-1)!.curr.status).toBe('waiting_permission');
  });

  it('未知 sessionId 的 hook 消息被安全忽略', () => {
    expect(() => manager.handleHookMessage({
      sessionId: 'no-such', event: { type: 'turn_completed' },
    })).not.toThrow();
  });

  it('approvePermission(yes) 向 PTY 写 y\\r', () => {
    const s = manager.getSessions()[0];
    expect(manager.approvePermission(s.id, 'yes')).toBe(true);
    // 回车是 CR：LF 不会让终端提交一行
    expect(ptys[0].written).toContain('y\r');
  });

  it('writeInput 直接透传到 PTY', () => {
    const s = manager.getSessions()[0];
    expect(manager.writeInput(s.id, '继续继续输入')).toBe(true);
    expect(ptys[0].written).toContain('继续继续输入');
  });

  it('PTY 非零退出 → error + exitCode', () => {
    const s = manager.getSessions()[0];
    ptys[0].emitExit(1);
    const curr = manager.getSessions().find(x => x.id === s.id)!;
    expect(curr.status).toBe('error');
    expect(curr.exitCode).toBe(1);
  });

  it('restartSession 复用 label/cwd 重新 spawn，状态回到 running，并把新 pid 写回 metadata（否则孤儿扫描按旧 pid 误判）', () => {
    const s = manager.getSessions()[0];
    const oldPty = ptys[0];
    expect(manager.restartSession(s.id, { mode: 'fresh' }).ok).toBe(true);
    expect(ptys.length).toBe(2);
    expect(ptys[1].options.env.CLAUDE_PANEL_SESSION_ID).toBe(s.id);
    const curr = manager.getSessions().find(x => x.id === s.id)!;
    expect(curr.status).toBe('running');
    expect(curr.exitCode).toBeUndefined();
    // restart 后 metadata 里的 pid 必须是新 PTY 的 pid（MockPty.pid 自增分配，与旧 pid 不同）
    const meta = JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'sessions', s.id, 'metadata.json'), 'utf8'));
    expect(meta.pid).toBe(ptys[1].pid);
    expect(meta.pid).not.toBe(oldPty.pid);
  });

  it('重启后旧 PTY 迟到的输出与退出回调被丢弃，不影响新会话', async () => {
    const outputs: string[] = [];
    const m2 = new SessionManager({
      ptyFactory: makeFactory(),
      hookClientPath: 'D:\\fake\\hook-client.js',
      mockClaudePath: 'D:\\fake\\mock-claude.js',
      onOutput: (_id, chunk) => outputs.push(chunk),
    });
    const s = m2.createSession({ label: '重启竞态', cwd: TEST_HOME });
    const oldPty = ptys.at(-1)!;
    expect(m2.restartSession(s.id, { mode: 'fresh', force: true }).ok).toBe(true);
    const newPty = ptys.at(-1)!;
    expect(newPty).not.toBe(oldPty);

    oldPty.emitData('旧输出');
    oldPty.emitExit(1);   // 旧进程被 kill 后异步触发 onExit
    const cur = m2.getSessions().find(x => x.id === s.id)!;
    expect(cur.status).toBe('running');
    expect(cur.exitCode).toBeUndefined();

    newPty.emitData('新输出');
    await new Promise(r => setTimeout(r, 40));   // 等输出合并定时器（16ms）落地
    expect(outputs).toEqual(['新输出']);
    expect(m2.getSessionOutput(s.id)).toBe('新输出');

    // 新进程退出仍正常生效
    newPty.emitExit(0);
    expect(m2.getSessions().find(x => x.id === s.id)!.status).toBe('completed');
  });

  it('mock 模式：CLAUDE_PANEL_MOCK_CLAUDE=1 时用系统 node.exe 跑 mock-claude（不能用 process.execPath / ELECTRON_RUN_AS_NODE）', () => {
    process.env.CLAUDE_PANEL_MOCK_CLAUDE = '1';
    try {
      // 显式 nodePath：测试可预期、不依赖宿主 PATH
      const expectedNode = process.platform === 'win32' ? 'D:\\nodejs\\node.exe' : '/usr/local/bin/node';
      const m2 = new SessionManager({
        ptyFactory: makeFactory(),
        hookClientPath: 'D:\\fake\\hook-client.js',
        mockClaudePath: 'D:\\fake\\mock-claude.js',
        nodePath: expectedNode,
      });
      m2.createSession({ label: 'mock', cwd: 'D:\\tmp' });
      const p = ptys.at(-1)!;
      expect(p.file).toBe(expectedNode);                          // 走系统 node，不是 electron.exe
      expect(p.args[0]).toBe('D:\\fake\\mock-claude.js');         // 绝对路径（不依赖 cwd）
      // mock 能力全开：脚本之后是与真实 CLI 相同的参数（--settings、预分配的 --session-id、--name）
      expect(p.args.slice(1, 2)).toEqual(['--settings']);
      expect(p.args).toContain('--session-id');
      expect(p.args.slice(-2)).toEqual(['--name', 'mock']);
      expect(p.options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');  // 不再设该 env
      expect(p.options.env.CLAUDE_PANEL_SESSION_ID).toBeDefined(); // sessionId 照常注入
    } finally {
      delete process.env.CLAUDE_PANEL_MOCK_CLAUDE;
    }
  });

  it('findNodePath：通过 where/which 解析且找不到时回退到 node/node.exe（不抛错）', () => {
    // 仅断言"返回非空字符串且符合平台约定"——不绑死具体路径
    const p = findNodePath();
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
    if (process.platform === 'win32') {
      expect(/node(\.exe)?$/i.test(p)).toBe(true);
    } else {
      expect(p).toBe('node');
    }
  });

  it('disposeAll：向全部托管 PTY 发送终止并返回计数，单个失败不阻断其余（主动退出收尾）', () => {
    const m3 = makeManager();
    m3.createSession({ label: '存活会话A', cwd: 'D:\\a' });
    m3.createSession({ label: '已退出会话', cwd: 'D:\\b' });
    m3.createSession({ label: '杀失败会话', cwd: 'D:\\c' });
    m3.createSession({ label: '存活会话B', cwd: 'D:\\d' });
    const [aliveA, dead, failing, aliveB] = ptys.slice(-4);
    dead.emitExit(0);                                          // 已完成退出（runtime 仍在、进程已死）
    failing.kill = () => { throw new Error('already dead'); }; // 模拟 kill 抛错
    expect(m3.disposeAll()).toBe(3);                           // 4 个托管 PTY 中 3 个 kill 成功发出（抛错的不计数）
    expect(aliveA.killed).toBe(true);                          // 存活会话被杀（兑现退出对话框承诺）
    expect(dead.killed).toBe(true);                            // 已死会话的 kill 调用被 try/catch 吞掉，不抛错
    expect(aliveB.killed).toBe(true);                          // 抛错会话之后的仍被杀：失败不阻断循环继续
  });

  it('权限请求缺命令文本时，用同工具最近一次 PreToolUse 的参数补全；工具名不符/工具已结束则不补', () => {
    const m = makeManager();
    const s = m.createSession({ label: '补全命令', cwd: 'D:\\a' });
    const pending = (): Session['pendingAction'] => m.getSessions().find(x => x.id === s.id)!.pendingAction;

    m.handleHookMessage({ sessionId: s.id, event: { type: 'tool_started', toolName: 'Bash', commandText: 'npm test' } });
    m.handleHookMessage({ sessionId: s.id, event: { type: 'permission_request', toolName: 'Bash', commandText: '' } });
    expect(pending()).toEqual({ toolName: 'Bash', commandText: 'npm test' });

    // 提示文本抠不出工具名时同样借用
    m.handleHookMessage({ sessionId: s.id, event: { type: 'permission_request', toolName: '未知工具', commandText: '' } });
    expect(pending()).toEqual({ toolName: 'Bash', commandText: 'npm test' });

    // 工具名不符：不借用
    m.handleHookMessage({ sessionId: s.id, event: { type: 'permission_request', toolName: 'Write', commandText: '' } });
    expect(pending()).toEqual({ toolName: 'Write', commandText: '' });

    // payload 自带命令文本：以自带为准
    m.handleHookMessage({ sessionId: s.id, event: { type: 'permission_request', toolName: 'Bash', commandText: 'ls' } });
    expect(pending()).toEqual({ toolName: 'Bash', commandText: 'ls' });

    // 工具结束后记录作废
    m.handleHookMessage({ sessionId: s.id, event: { type: 'tool_finished' } });
    m.handleHookMessage({ sessionId: s.id, event: { type: 'permission_request', toolName: 'Bash', commandText: '' } });
    expect(pending()).toEqual({ toolName: 'Bash', commandText: '' });
  });

  it('hook 消息附带的 claudeSessionId 写入会话与 metadata（子代理事件同样生效），变化时以最新为准', () => {
    const m = makeManager();
    const s = m.createSession({ label: '关联 claude 会话', cwd: 'D:\\a' });
    const metaOf = (): { sessionId?: string } =>
      JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'sessions', s.id, 'metadata.json'), 'utf8'));

    m.handleHookMessage({ sessionId: s.id, event: { type: 'subagent_start', raw: {} }, claudeSessionId: 'claude-1' });
    expect(m.getSessions().find(x => x.id === s.id)!.claudeSessionId).toBe('claude-1');
    expect(metaOf().sessionId).toBe('claude-1');

    m.handleHookMessage({ sessionId: s.id, event: { type: 'tool_finished' }, claudeSessionId: 'claude-2' });
    expect(m.getSessions().find(x => x.id === s.id)!.claudeSessionId).toBe('claude-2');
    expect(metaOf().sessionId).toBe('claude-2');

    // 不带该字段的消息不清除已有值
    m.handleHookMessage({ sessionId: s.id, event: { type: 'turn_completed' } });
    expect(metaOf().sessionId).toBe('claude-2');
  });

  it('工作区会话：可指定 id，worktree 写入会话与 metadata，claudeSessionId 回写时不丢', () => {
    const m = makeManager();
    const worktree = { repoRoot: 'D:\\repo', path: 'D:\\repo\\.claude\\worktrees\\nexus-abcd1234', branch: 'nexus/abcd1234', baseRef: 'main', baseCommit: 'f'.repeat(40) };
    const s = m.createSession({ id: 'abcd1234-0000-0000-0000-000000000000', label: 'wt', cwd: worktree.path, worktree });
    expect(s.id).toBe('abcd1234-0000-0000-0000-000000000000');
    expect(m.getSession(s.id)?.worktree).toEqual(worktree);
    const metaPath = path.join(TEST_HOME, 'sessions', s.id, 'metadata.json');
    expect(JSON.parse(fs.readFileSync(metaPath, 'utf8')).worktree).toEqual(worktree);
    m.handleHookMessage({ sessionId: s.id, event: { type: 'tool_finished' }, claudeSessionId: 'c1' });
    expect(JSON.parse(fs.readFileSync(metaPath, 'utf8')).worktree).toEqual(worktree);
  });

  it('onEvent 旁路收到状态机事件；changeSummary 合并进会话列表', () => {
    ptys = [];
    const events: string[] = [];
    const summary = { mode: 'working' as const, files: 2, additions: 5, deletions: 1, updatedAt: 1 };
    const m = new SessionManager({
      ptyFactory: makeFactory(), hookClientPath: 'x', mockClaudePath: 'y', now: () => 1,
      onEvent: (_id, e) => events.push(e.type),
      changeSummary: () => summary,
    });
    const s = m.createSession({ label: 'c', cwd: 'D:\\a' });
    m.handleHookMessage({ sessionId: s.id, event: { type: 'tool_finished' } });
    m.handleHookMessage({ sessionId: s.id, event: { type: 'turn_completed' } });
    expect(events).toEqual(['tool_finished', 'turn_completed']);
    expect(m.getSessions()[0].changes).toEqual(summary);
  });

  it('onHookMessage 对所有 hook（含子代理事件）调用；usageSummary 合并进会话列表', () => {
    ptys = [];
    const seen: string[] = [];
    let usage: SessionUsageSummary | undefined = { state: 'ok', updatedAt: 1 };
    const m = new SessionManager({
      ptyFactory: makeFactory(), hookClientPath: 'x', mockClaudePath: 'y', now: () => 1,
      onHookMessage: msg => seen.push(`${msg.event.type}:${msg.transcriptPath ?? ''}`),
      usageSummary: () => usage,
    });
    const s = m.createSession({ label: 'u', cwd: 'D:\\a' });
    const raw = { hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'x' };
    m.handleHookMessage({ sessionId: s.id, event: { type: 'session_started', source: 'startup' }, transcriptPath: 'D:\\t\\a.jsonl' });
    m.handleHookMessage({ sessionId: s.id, event: { type: 'subagent_start', raw } });
    m.handleHookMessage({ sessionId: s.id, event: { type: 'subagent_stop', raw } });
    m.handleHookMessage({ sessionId: s.id, event: { type: 'turn_completed' } });
    m.handleHookMessage({ sessionId: 'missing', event: { type: 'turn_completed' } });
    expect(seen).toEqual(['session_started:D:\\t\\a.jsonl', 'subagent_start:', 'subagent_stop:', 'turn_completed:']);
    expect(m.getSessions()[0].usage).toEqual({ state: 'ok', updatedAt: 1 });
    usage = undefined;
    expect(m.getSessions()[0].usage).toBeUndefined();
  });

  it('killSessionAndWait：进程退出即返回 true，超时返回 false；无 PTY 直接 true', async () => {
    const m = makeManager();
    const a = m.createSession({ label: 'a', cwd: 'D:\\a' });
    const pa = ptys[ptys.length - 1];
    const waiting = m.killSessionAndWait(a.id, 1000);
    expect(pa.killed).toBe(true);
    pa.emitExit(0);
    expect(await waiting).toBe(true);
    expect(m.getSession(a.id)).toBeUndefined();

    const b = m.createSession({ label: 'b', cwd: 'D:\\b' });
    expect(await m.killSessionAndWait(b.id, 20)).toBe(false);
    expect(await m.killSessionAndWait('missing', 20)).toBe(true);
  });

  it('restartSession：目录已不存在时拒绝重启', () => {
    const m = makeManager();
    const gone = path.join(TEST_HOME, 'gone-dir');
    fs.mkdirSync(gone);
    const s = m.createSession({ label: 'g', cwd: gone });
    fs.rmSync(gone, { recursive: true });
    expect(m.restartSession(s.id, { mode: 'fresh' }).ok).toBe(false);
  });

  describe('Claude 会话 id 与启动参数', () => {
    const FULL_CAPS = { version: 't', resume: true, sessionId: true, forkSession: true, name: true, probedAt: 0 };
    const U1 = '11111111-1111-4111-8111-111111111111';
    const U2 = '22222222-2222-4222-8222-222222222222';
    const U3 = '33333333-3333-4333-8333-333333333333';
    function fullManager(uuids: string[], extra: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}): SessionManager {
      ptys = [];
      const queue = [...uuids];
      return new SessionManager({
        ptyFactory: makeFactory(), hookClientPath: 'x', mockClaudePath: 'y', now: () => 1,
        caps: () => FULL_CAPS, newUuid: () => queue.shift()!, ...extra,
      });
    }
    const metaOf = (id: string): Record<string, unknown> =>
      JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'sessions', id, 'metadata.json'), 'utf8'));

    it('CLI 支持 --session-id 时预分配 id：创建后立即有值并写盘，参数带 --session-id 与 --name', () => {
      const m = fullManager([U1, U2]);
      const s = m.createSession({ label: '修复 & 导入', cwd: TEST_HOME, launch: { model: 'opus', permissionMode: 'bad mode' } });
      expect(s.id).toBe(U1);
      expect(s.claudeSessionId).toBe(U2);
      expect(s.claudeSessionIds).toEqual([U2]);
      expect(s.launch).toEqual({ model: 'opus' });
      expect(metaOf(s.id)).toMatchObject({ sessionId: U2, sessionIds: [U2], launch: { model: 'opus' } });
      const args = ptys[0].args;
      const settingsPath = path.join(TEST_HOME, 'sessions', s.id, 'settings.json');
      const tail = ['--settings', settingsPath, '--session-id', U2, '--name', '修复 导入', '--model', 'opus'];
      expect(args.slice(-tail.length)).toEqual(tail);
    });

    it('默认（保守）能力下参数只有 --settings，claudeSessionId 等 hook 回填', () => {
      ptys = [];
      const m = new SessionManager({ ptyFactory: makeFactory(), hookClientPath: 'x', mockClaudePath: 'y' });
      const s = m.createSession({ label: 'x', cwd: TEST_HOME });
      expect(s.claudeSessionId).toBeUndefined();
      expect(ptys[0].args.filter(a => a.startsWith('--'))).toEqual(['--settings']);
    });

    it('子进程 env 剥离 Claude Code 父子进程标记、保留用户配置，并注入本会话 id', () => {
      const saved = { ...process.env };
      Object.assign(process.env, {
        CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PANEL_SESSION_ID: 'outer',
        CLAUDE_CODE_GIT_BASH_PATH: 'D:\\git\\bash.exe', ANTHROPIC_BASE_URL: 'http://x',
      });
      try {
        const m = fullManager([U1, U2]);
        const s = m.createSession({ label: 'env', cwd: TEST_HOME });
        const env = ptys[0].options.env;
        expect(env.CLAUDECODE).toBeUndefined();
        expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
        expect(env.CLAUDE_PANEL_SESSION_ID).toBe(s.id);
        expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe('D:\\git\\bash.exe');
        expect(env.ANTHROPIC_BASE_URL).toBe('http://x');
      } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
      }
    });

    it('/clear 换 id：以最新为准，旧 id 留在 claudeSessionIds；对话记录路径只认与当前 id 对应的', () => {
      const m = fullManager([U1, U2]);
      const s = m.createSession({ label: 'clear', cwd: TEST_HOME });
      const tp2 = `C:\\p\\proj\\${U2}.jsonl`;
      m.handleHookMessage({ sessionId: s.id, event: { type: 'prompt_submitted' }, claudeSessionId: U2, transcriptPath: tp2 });
      expect(m.getSession(s.id)!.claudeTranscriptPath).toBe(tp2);
      m.handleHookMessage({ sessionId: s.id, event: { type: 'session_started', source: 'clear' }, claudeSessionId: U3,
        transcriptPath: `C:\\p\\proj\\${U3}.jsonl` });
      const cur = m.getSession(s.id)!;
      expect(cur.claudeSessionId).toBe(U3);
      expect(cur.claudeSessionIds).toEqual([U2, U3]);
      expect(cur.claudeTranscriptPath).toBe(`C:\\p\\proj\\${U3}.jsonl`);
      expect(metaOf(s.id)).toMatchObject({ sessionId: U3, sessionIds: [U2, U3] });
      // 与当前 id 不符的记录路径不采用
      m.handleHookMessage({ sessionId: s.id, event: { type: 'tool_finished' }, transcriptPath: tp2 });
      expect(m.getSession(s.id)!.claudeTranscriptPath).toBe(`C:\\p\\proj\\${U3}.jsonl`);
    });

    it('session_started 不进状态机但走 onEvent 旁路；prompt_submitted 把会话推回运行中', () => {
      const events: string[] = [];
      const m = fullManager([U1, U2], { onEvent: (_id, e) => events.push(e.type) });
      const s = m.createSession({ label: 'side', cwd: TEST_HOME });
      m.handleHookMessage({ sessionId: s.id, event: { type: 'idle_prompt' } });
      m.handleHookMessage({ sessionId: s.id, event: { type: 'session_started', source: 'startup' }, claudeSessionId: U2 });
      expect(m.getSession(s.id)!.status).toBe('waiting_input');
      m.handleHookMessage({ sessionId: s.id, event: { type: 'prompt_submitted' } });
      expect(m.getSession(s.id)!.status).toBe('running');
      expect(events).toEqual(['idle_prompt', 'session_started', 'prompt_submitted']);
    });
  });

  describe('忙碌与粘贴模式信号', () => {
    function plainManager(extra: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}): SessionManager {
      ptys = [];
      return new SessionManager({ ptyFactory: makeFactory(), hookClientPath: 'x', mockClaudePath: 'y', now: () => 1, ...extra });
    }
    const metaOf = (id: string): Record<string, unknown> =>
      JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'sessions', id, 'metadata.json'), 'utf8'));

    it('新会话初始空闲，带当前 hooks 版本并写入 metadata', () => {
      const m = plainManager();
      const s = m.createSession({ label: 'b', cwd: TEST_HOME });
      expect(s.busy).toBe(false);
      expect(s.hooksVersion).toBe(HOOKS_VERSION);
      expect(metaOf(s.id).hooksVersion).toBe(HOOKS_VERSION);
      expect(m.isBusy(s.id)).toBe(false);
      expect(m.hasLivePty(s.id)).toBe(true);
    });

    it('busy 随 hook 事件流转：提交 → 工具 → 权限 → 回合结束', () => {
      const m = plainManager();
      const s = m.createSession({ label: 'b', cwd: TEST_HOME });
      const steps: Array<[Parameters<SessionManager['handleHookMessage']>[0]['event'], boolean]> = [
        [{ type: 'prompt_submitted' }, true],
        [{ type: 'tool_started', toolName: 'Bash' }, true],
        [{ type: 'permission_request', toolName: 'Bash', commandText: '' }, true],
        [{ type: 'tool_finished' }, true],
        [{ type: 'turn_completed' }, false],
        [{ type: 'session_started', source: 'clear' }, false],
        [{ type: 'tool_started' }, true],
        [{ type: 'idle_prompt' }, false],
      ];
      for (const [event, want] of steps) {
        m.handleHookMessage({ sessionId: s.id, event });
        expect(m.getSession(s.id)!.busy, event.type).toBe(want);
        expect(m.isBusy(s.id), event.type).toBe(want);
      }
      m.handleHookMessage({ sessionId: s.id, event: { type: 'prompt_submitted' } });
      ptys[0].emitExit(0);
      expect(m.getSession(s.id)!.busy).toBe(false);
      expect(m.hasLivePty(s.id)).toBe(false);
    });

    it('老会话（无 hooksVersion）一律视为可能正忙；重启后按当前版本重写 hooks 配置并归零', () => {
      const m = plainManager();
      const legacy: Session = {
        id: 'legacy-1', label: '老会话', cwd: TEST_HOME, status: 'completed', statusSince: 1, createdAt: 1, escalated: false,
      };
      m.adoptSession(legacy);
      expect(m.isBusy('legacy-1')).toBe(true);
      m.handleHookMessage({ sessionId: 'legacy-1', event: { type: 'turn_completed' } });
      expect(m.getSession('legacy-1')!.busy).toBe(false);
      expect(m.isBusy('legacy-1')).toBe(true);
      const settings = path.join(TEST_HOME, 'sessions', 'legacy-1', 'settings.json');
      fs.mkdirSync(path.dirname(settings), { recursive: true });
      fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [] } }));
      expect(m.restartSession('legacy-1', { mode: 'fresh' }).ok).toBe(true);
      const cur = m.getSession('legacy-1')!;
      expect(cur.hooksVersion).toBe(HOOKS_VERSION);
      expect(cur.busy).toBe(false);
      expect(m.isBusy('legacy-1')).toBe(false);
      expect(Object.keys(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks)).toContain('UserPromptSubmit');
      expect(metaOf('legacy-1').hooksVersion).toBe(HOOKS_VERSION);
    });

    it('正忙时重启：busy 与粘贴模式归零', async () => {
      const m = plainManager();
      const s = m.createSession({ label: 'b', cwd: TEST_HOME });
      ptys[0].emitData('\x1b[?2004h');
      await new Promise(r => setTimeout(r, 40));
      m.handleHookMessage({ sessionId: s.id, event: { type: 'prompt_submitted' } });
      expect(m.getSession(s.id)).toMatchObject({ busy: true, pasteMode: true });
      expect(m.restartSession(s.id, { mode: 'fresh', force: true }).ok).toBe(true);
      const cur = m.getSession(s.id)!;
      expect(cur.busy).toBe(false);
      expect(cur.pasteMode).toBeUndefined();
    });

    it('粘贴模式按输出里最后出现的序列更新（序列可被切开），变化时推送会话列表', async () => {
      let pushes = 0;
      const m = plainManager({ onChange: () => { pushes++; } });
      const s = m.createSession({ label: 'p', cwd: TEST_HOME });
      const flush = () => new Promise(r => setTimeout(r, 40));
      ptys[0].emitData('欢迎\x1b[?20');
      await flush();
      expect(m.getSession(s.id)!.pasteMode).toBeUndefined();
      const before = pushes;
      ptys[0].emitData('04h>');
      await flush();
      expect(m.getSession(s.id)!.pasteMode).toBe(true);
      expect(pushes).toBe(before + 1);
      ptys[0].emitData('普通输出');
      await flush();
      expect(pushes).toBe(before + 1);
      ptys[0].emitData('\x1b[?2004l');
      await flush();
      expect(m.getSession(s.id)!.pasteMode).toBe(false);
      ptys[0].emitData('\x1b[?2004h');
      await flush();
      ptys[0].emitExit(0);
      expect(m.getSession(s.id)!.pasteMode).toBe(false);
    });

    it('订阅者收到事件、输出与 pty 脱离通知；取消订阅后不再收到', async () => {
      const m = plainManager();
      const got: string[] = [];
      const off = m.addListener({
        onEvent: (_id, e) => got.push(`event:${e.type}`),
        onOutput: (_id, c) => got.push(`out:${c}`),
        onDetach: (_id, reason) => got.push(`detach:${reason}`),
      });
      // 抛错的订阅者不影响其他订阅者
      m.addListener({ onEvent: () => { throw new Error('boom'); } });
      const s = m.createSession({ label: 'l', cwd: TEST_HOME });
      m.handleHookMessage({ sessionId: s.id, event: { type: 'session_started', source: 'startup' } });
      m.handleHookMessage({ sessionId: s.id, event: { type: 'prompt_submitted' } });
      ptys[0].emitData('abc');
      await new Promise(r => setTimeout(r, 40));
      expect(m.restartSession(s.id, { mode: 'fresh', force: true }).ok).toBe(true);
      m.killSession(s.id);
      expect(got).toEqual(['event:session_started', 'event:prompt_submitted', 'out:abc', 'detach:restarted', 'detach:killed']);
      off();
      const s2 = m.createSession({ label: 'l2', cwd: TEST_HOME });
      m.handleHookMessage({ sessionId: s2.id, event: { type: 'turn_completed' } });
      expect(got).toHaveLength(5);
    });
  });

  describe('会话记录写入', () => {
    const CAPS = { version: 't', resume: true, sessionId: true, forkSession: true, name: true, probedAt: 0 };
    let seq = 0;
    const uuid = (): string => `aaaaaaaa-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

    function withRecords(extra: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}): {
      m: SessionManager; store: SessionRecordStore; projects: string; clock: { t: number };
    } {
      ptys = [];
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-smrec-'));
      const projects = path.join(root, 'projects');
      fs.mkdirSync(projects);
      const clock = { t: 1000 };
      const store = new SessionRecordStore(path.join(root, 'records'), { now: () => clock.t, deferMs: 60_000 });
      store.load();
      const m = new SessionManager({
        ptyFactory: makeFactory(), hookClientPath: 'x', mockClaudePath: 'y', now: () => clock.t,
        caps: () => CAPS, newUuid: uuid, projectsRoot: () => projects, records: store, ...extra,
      });
      return { m, store, projects, clock };
    }

    function writeTranscript(projects: string, cwd: string, id: string): void {
      const dir = path.join(projects, projectDirName(cwd));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.jsonl`), '{"type":"user"}\n');
    }

    it('创建写 live 记录，带当前 Claude 会话 id', () => {
      const { m, store } = withRecords();
      const s = m.createSession({ label: '记录', cwd: TEST_HOME, launch: { model: 'opus' } });
      expect(store.get(s.id)).toMatchObject({
        state: 'live', label: '记录', cwd: TEST_HOME, lastStatus: 'running', turns: 0, resumeCount: 0,
        claudeSessionId: s.claudeSessionId, claudeSessionIds: [s.claudeSessionId], launch: { model: 'opus' },
      });
    });

    it('hook 刷新最近活动时间，Stop 轮数加一，id 变化追加历史并记录对话路径', () => {
      const { m, store, clock } = withRecords();
      const s = m.createSession({ label: 'hook', cwd: TEST_HOME });
      clock.t = 2000;
      m.handleHookMessage({ sessionId: s.id, event: { type: 'tool_finished' } });
      expect(store.get(s.id)!.lastActiveAt).toBe(2000);
      m.handleHookMessage({ sessionId: s.id, event: { type: 'turn_completed' } });
      m.handleHookMessage({ sessionId: s.id, event: { type: 'turn_completed' } });
      expect(store.get(s.id)).toMatchObject({ turns: 2, lastStatus: 'completed' });
      const next = uuid();
      m.handleHookMessage({
        sessionId: s.id, event: { type: 'session_started', source: 'clear' }, claudeSessionId: next,
        transcriptPath: `C:\\p\\${next}.jsonl`,
      });
      expect(store.get(s.id)).toMatchObject({
        claudeSessionId: next, claudeSessionIds: [s.claudeSessionId, next], transcriptPath: `C:\\p\\${next}.jsonl`,
      });
    });

    it('进程退出转 exited 并记下退出码', () => {
      const { m, store } = withRecords();
      const s = m.createSession({ label: 'exit', cwd: TEST_HOME });
      ptys[0].emitExit(2);
      expect(store.get(s.id)).toMatchObject({ state: 'exited', exitCode: 2, lastStatus: 'error' });
    });

    it('续接转回 live，确认后续接次数加一；全新开始换 id', () => {
      const { m, store, projects } = withRecords();
      const s = m.createSession({ label: 'resume', cwd: TEST_HOME });
      writeTranscript(projects, TEST_HOME, s.claudeSessionId!);
      ptys[0].emitExit(0);
      expect(m.restartSession(s.id).ok).toBe(true);
      expect(store.get(s.id)).toMatchObject({ state: 'live', resumeCount: 0, lastStatus: 'running' });
      expect(store.get(s.id)!.exitCode).toBeUndefined();
      m.handleHookMessage({ sessionId: s.id, event: { type: 'session_started', source: 'resume' }, claudeSessionId: s.claudeSessionId });
      expect(store.get(s.id)!.resumeCount).toBe(1);
      ptys[1].emitExit(0);
      expect(m.restartSession(s.id, { mode: 'fresh' }).ok).toBe(true);
      const r = store.get(s.id)!;
      expect(r.claudeSessionId).not.toBe(s.claudeSessionId);
      expect(r.claudeSessionIds).toEqual([s.claudeSessionId, r.claudeSessionId]);
      expect(r.resumeCount).toBe(1);
    });

    it('续接确认超时也计为成功续接', async () => {
      const { m, store, projects } = withRecords({ resumeConfirmMs: 10 });
      const s = m.createSession({ label: 'timeout', cwd: TEST_HOME });
      writeTranscript(projects, TEST_HOME, s.claudeSessionId!);
      ptys[0].emitExit(0);
      m.restartSession(s.id);
      await new Promise(r => setTimeout(r, 40));
      expect(store.get(s.id)!.resumeCount).toBe(1);
    });

    it('续接失败写入记录，再次重启时清除', () => {
      const { m, store, projects } = withRecords();
      const s = m.createSession({ label: 'fail', cwd: TEST_HOME });
      writeTranscript(projects, TEST_HOME, s.claudeSessionId!);
      ptys[0].emitExit(0);
      m.restartSession(s.id);
      ptys[1].emitData('No conversation found with session ID\r\n');
      ptys[1].emitExit(1);
      expect(store.get(s.id)).toMatchObject({ state: 'exited', lastResumeFailure: { reason: 'no_transcript' } });
      m.restartSession(s.id, { mode: 'fresh' });
      expect(store.get(s.id)!.lastResumeFailure).toBeUndefined();
    });

    it('结束会话转 ended（killed）并按上限清理历史', () => {
      const { m, store, clock } = withRecords({ historyLimits: () => ({ historyMaxCount: 1, historyMaxDays: 90 }) });
      const a = m.createSession({ label: 'a', cwd: TEST_HOME });
      const b = m.createSession({ label: 'b', cwd: TEST_HOME });
      clock.t = 3000;
      m.killSession(a.id);
      expect(store.get(a.id)).toMatchObject({ state: 'ended', endReason: 'killed', endedAt: 3000 });
      clock.t = 4000;
      m.killSession(b.id);
      expect(store.get(b.id)).toMatchObject({ state: 'ended' });
      expect(store.get(a.id)).toBeUndefined();
    });

    it('结束后旧进程迟到的退出不把记录改回 exited', () => {
      const { m, store } = withRecords();
      const s = m.createSession({ label: 'late', cwd: TEST_HOME });
      m.killSession(s.id);
      ptys[0].emitExit(1);
      expect(store.get(s.id)!.state).toBe('ended');
    });

    it('认领沿用已有记录并转 live；没有记录时补建；认领进程死亡转 exited', () => {
      const { m, store } = withRecords();
      const base = { label: '认领', cwd: TEST_HOME, status: 'running' as const, statusSince: 1, createdAt: 1, escalated: false, readOnly: true };
      store.upsert({ ...newRecordFor('o1'), turns: 7 });
      m.adoptSession({ ...base, id: 'o1', claudeSessionId: 'c-o1' }, 501);
      expect(store.get('o1')).toMatchObject({ state: 'live', turns: 7, claudeSessionId: 'c-o1' });
      m.adoptSession({ ...base, id: 'o2' }, 502);
      expect(store.get('o2')).toMatchObject({ state: 'live', turns: 0 });
      m.pollOrphans(() => false);
      expect(store.get('o1')!.state).toBe('exited');
      expect(store.get('o2')!.state).toBe('exited');
    });

    it('接管检查按解除只读、进程存活评估；解除认领后不再只读且只解除一次', () => {
      const { m } = withRecords();
      const base = { label: '认领', cwd: TEST_HOME, status: 'running' as const, statusSince: 1, createdAt: 1, escalated: false, readOnly: true };
      m.adoptSession({ ...base, id: 'o3' }, 503);
      expect(m.checkResume('o3')!.reason).toBe('readonly');
      expect(m.checkTakeover('o3')!.reason).toBe('no_id');
      expect(m.checkTakeover('none')).toBeUndefined();
      expect(m.orphanPid('o3')).toBe(503);
      expect(m.releaseOrphan('o3')).toBe(true);
      expect(m.getSession('o3')!.readOnly).toBe(false);
      expect(m.orphanPid('o3')).toBeUndefined();
      expect(m.isProcessAlive('o3')).toBe(false);
      expect(m.releaseOrphan('o3')).toBe(false);
    });

    function newRecordFor(id: string): SessionRecord {
      return {
        version: 1, id, label: 'old', cwd: TEST_HOME, createdAt: 1, updatedAt: 1, lastActiveAt: 1,
        state: 'live', lastStatus: 'running', claudeSessionIds: [], turns: 0, resumeCount: 0,
      };
    }
  });
});
