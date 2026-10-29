import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../src/main/session-manager';
import { SubagentTracker } from '../src/main/subagent-tracker';
import { PtyFactory, Session } from '../src/shared/types';

/**
 * 会话生命周期测试：真 SessionManager 加可追踪的假 PTY
 * - PTY 用 TracePty 代替 node-pty，不起真实进程，只记录 spawn 参数、写入内容与 kill 调用，
 *   并可手动触发输出与退出事件
 * - 覆盖新建 → 写入 → 审批 → 重启 → 结束 → 退出状态迁移 → 会话目录持久化
 *
 * 前置：
 * - CLAUDE_PANEL_MOCK_CLAUDE=1 在模块加载时设置，spawn 的目标是系统 node 加 scripts/mock-claude.js
 * - CLAUDE_PANEL_HOME 指向临时目录，不碰真实数据目录
 */

class TracePty {
  written: string[] = [];
  private dataCbs: Array<(c: string) => void> = [];
  private exitCbs: Array<(c: number | null) => void> = [];
  private resizeCbs: Array<(c: { cols: number; rows: number }) => void> = [];
  killed = false;
  file = '';
  args: string[] = [];
  options: { cwd: string; env: Record<string, string> };
  pid: number;
  constructor(file: string, args: string[], options: { cwd: string; env: Record<string, string> }) {
    this.file = file; this.args = args; this.options = options;
    this.pid = Math.floor(100000 + Math.random() * 800000);
  }
  write(d: string): void { this.written.push(d); }
  resize(cols: number, rows: number): void { this.resizeCbs.forEach(cb => cb({ cols, rows })); }
  kill(): void { this.killed = true; }
  onData(cb: (c: string) => void): void { this.dataCbs.push(cb); }
  onExit(cb: (c: number | null) => void): void { this.exitCbs.push(cb); }
  emitData(chunk: string): void { this.dataCbs.forEach(cb => cb(chunk)); }
  emitExit(code: number | null): void { this.exitCbs.forEach(cb => cb(code)); }
}

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-integ-'));
process.env.CLAUDE_PANEL_HOME = TEST_HOME;
process.env.CLAUDE_PANEL_MOCK_CLAUDE = '1';

const SCRIPT_DIR = path.resolve(__dirname, '..', 'scripts');
const MOCK_CLAUDE_PATH = path.join(SCRIPT_DIR, 'mock-claude.js');
const HOOK_CLIENT_PATH = path.join(SCRIPT_DIR, 'hook-client.js');

describe('会话生命周期（真 SessionManager + 假 PTY）', () => {
  let ptys: TracePty[];
  let manager: SessionManager;
  const transitions: Array<{ from: string; to: string; label: string }> = [];

  beforeAll(() => {
    ptys = [];
    const ptyFactory: PtyFactory = {
      spawn: (file, args, options) => {
        const p = new TracePty(file, args, options);
        ptys.push(p);
        return p;
      },
    };
    manager = new SessionManager({
      ptyFactory,
      hookClientPath: HOOK_CLIENT_PATH,
      mockClaudePath: MOCK_CLAUDE_PATH,
      nodePath: process.execPath,
      now: () => Date.now(),
      onTransition: (prev, curr) => transitions.push({ from: prev.status, to: curr.status, label: curr.label }),
      subagentTracker: new SubagentTracker({}),
    });
  });

  it('新建会话：mock 模式下 spawn 系统 node.exe（不是 electron.exe），状态 running，env 注入 sessionId', () => {
    const s = manager.createSession({ label: 'integ-用户模块', cwd: 'D:\\tmp' });
    const p = ptys.at(-1)!;
    expect(p.file).toMatch(/node(\.exe)?$/i);              // 系统 node，不是 electron.exe
    expect(p.args[0]).toBe(MOCK_CLAUDE_PATH);             // 绝对路径
    // mock 能力全开：预分配的 Claude 会话 id 以 --session-id 传入，会话创建即有值
    expect(p.args).toContain('--session-id');
    expect(p.args[p.args.indexOf('--session-id') + 1]).toBe(s.claudeSessionId);
    expect(p.options.env.CLAUDE_PANEL_SESSION_ID).toBe(s.id);
    expect(s.status).toBe('running');
  });

  it('writeInput 透传到 PTY（GUI 输入任务文本）', () => {
    const s = manager.getSessions()[0];
    expect(manager.writeInput(s.id, 'hello world\n')).toBe(true);
    expect(ptys[0].written).toContain('hello world\n');
  });

  it('approvePermission 写入 y\\r（先把状态推到 waiting_permission，再点 Y）', () => {
    // 新会话默认 running，需先注入 Notification hook 把它推到 waiting_permission
    const s = manager.createSession({ label: 'integ-y', cwd: 'D:\\tmp' });
    manager.handleHookMessage({
      sessionId: s.id,
      event: { type: 'permission_request', toolName: 'Bash', commandText: 'echo hi' },
    });
    expect(manager.approvePermission(s.id, 'yes')).toBe(true);
    // 回车是 CR：LF 不会让终端提交一行
    expect(ptys.at(-1)!.written).toContain('y\r');
  });

  it('approvePermission(no) 写入 n\\r', () => {
    const s2 = manager.createSession({ label: 'integ-拒绝分支', cwd: 'D:\\tmp' });
    manager.handleHookMessage({
      sessionId: s2.id,
      event: { type: 'permission_request', toolName: 'Bash', commandText: 'echo hi' },
    });
    expect(manager.approvePermission(s2.id, 'no')).toBe(true);
    expect(ptys.at(-1)!.written).toContain('n\r');
  });

  it('approvePermission(always) 写入 a\\r', () => {
    const s3 = manager.createSession({ label: 'integ-始终允许', cwd: 'D:\\tmp' });
    manager.handleHookMessage({
      sessionId: s3.id,
      event: { type: 'permission_request', toolName: 'Bash', commandText: 'echo hi' },
    });
    expect(manager.approvePermission(s3.id, 'always')).toBe(true);
    expect(ptys.at(-1)!.written).toContain('a\r');
  });

  it('approvePermission 在非 waiting_permission 状态被拒（守门正确）', () => {
    // 拿一个跑在 running 的会话调批准，必须返回 false，不向 PTY 写
    const running = manager.createSession({ label: 'integ-running守卫', cwd: 'D:\\tmp' });
    const p = ptys.at(-1)!;
    const beforeWritten = [...p.written];
    expect(manager.approvePermission(running.id, 'yes')).toBe(false);
    expect(p.written).toEqual(beforeWritten);  // 没新写入
  });

  it('restartSession 复用 label/cwd，PTY 池新增一项', () => {
    const s = manager.getSessions()[0];
    const beforeCount = ptys.length;
    expect(manager.restartSession(s.id, { mode: 'fresh', force: true }).ok).toBe(true);
    expect(ptys.length).toBe(beforeCount + 1);
    const cur = manager.getSessions().find(x => x.id === s.id)!;
    expect(cur.status).toBe('running');
    expect(cur.exitCode).toBeUndefined();
    expect(cur.pendingAction).toBeUndefined();
  });

  it('killSession 标记会话删除 + 触发 PTY.kill()', () => {
    const s4 = manager.createSession({ label: 'integ-待杀', cwd: 'D:\\tmp' });
    const p = ptys.at(-1)!;
    expect(p.killed).toBe(false);
    manager.killSession(s4.id);
    expect(p.killed).toBe(true);                          // killSession 同步触发 PTY.kill
    expect(manager.getSessions().find(x => x.id === s4.id)).toBeUndefined();
  });

  it('disposeAll 向所有托管 PTY 发送 kill（面板退出收尾）', () => {
    // 前面用例已 killSession 删了一个、restart 复用 +1（仍在 runtimes）、写任务 + 三个 approve + kill
    // 一个共产生若干 runtimes；这里只要确认 disposeAll 至少杀掉了当时还活着的 PTY 即可
    const aliveBefore = ptys.filter(p => !p.killed).length;
    const sent = manager.disposeAll();
    expect(sent).toBe(aliveBefore);                     // 杀的就是当时还活着的所有 PTY
    expect(ptys.filter(p => !p.killed).length).toBe(0); // 杀完一个不剩
  });

  it('会话目录结构（settings.json + metadata.json）正确持久化', () => {
    const s = manager.getSessions().find(x => x.label === 'integ-用户模块')!;
    const dir = path.join(TEST_HOME, 'sessions', s.id);
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'metadata.json'))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    expect(settings.hooks).toHaveProperty('Stop');
    expect(settings.hooks).toHaveProperty('Notification');
    expect(settings.hooks).toHaveProperty('PreToolUse');
    expect(settings.hooks).toHaveProperty('PostToolUse');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')) as Session;
    expect(meta.id).toBe(s.id);
    expect(meta.label).toBe('integ-用户模块');
    expect(meta.cwd).toBe('D:\\tmp');
  });

  it('状态机迁移：PTY 退出（exit=0）→ completed；PTY 退出（exit≠0）→ error；transition 记录状态变更', () => {
    // 新建一条会话：当前应 running
    const s = manager.createSession({ label: 'integ-exit', cwd: 'D:\\tmp' });
    const p = ptys.at(-1)!;
    // 非零退出 → error（这条 transition 必出）
    const beforeTrans = transitions.length;
    p.emitExit(1);
    const after1 = manager.getSessions().find(x => x.id === s.id)!;
    expect(after1.status).toBe('error');
    expect(after1.exitCode).toBe(1);
    expect(transitions.length).toBe(beforeTrans + 1);
    expect(transitions.at(-1)!.to).toBe('error');
    // 零退出 → completed（同一 PTY 不会再次 emitExit；新建一条测）
    const s2 = manager.createSession({ label: 'integ-clean', cwd: 'D:\\tmp' });
    const before2 = transitions.length;
    ptys.at(-1)!.emitExit(0);
    const after2 = manager.getSessions().find(x => x.id === s2.id)!;
    expect(after2.status).toBe('completed');
    expect(after2.exitCode).toBe(0);
    expect(transitions.at(-1)!.to).toBe('completed');
    expect(transitions.length).toBe(before2 + 1);
  });
});
