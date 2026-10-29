/**
 * 孤儿恢复集成测试：真 scanOrphans + 真文件系统
 * 模拟两种场景：
 *   A. metadata.pid 指向存活进程 → 认领为 readOnly
 *   B. metadata.pid 指向死进程 → 删除目录
 *   C. metadata 损坏 → 跳过不抛错
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { scanOrphans } from '../src/main/orphan-reclaimer';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-orphan-'));
const SESSIONS_DIR = path.join(TEST_HOME, 'sessions');

function writeSession(id: string, meta: object): void {
  const dir = path.join(SESSIONS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta));
}

describe('孤儿恢复集成（真 scanOrphans + 真进程存活判定）', () => {
  let alivePid: number;
  let aliveChild: ReturnType<typeof spawn>;

  beforeAll(() => {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    // 长跑子进程作为"存活 PID"：scanOrphans 调用 process.kill(pid, 0) 判活
    aliveChild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      detached: false,
      windowsHide: true,
    });
    alivePid = aliveChild.pid!;
  });

  it('A. metadata.pid 存活 → 认领为 readOnly 的 running 会话，保留 label/cwd/sessionId', () => {
    const id = 'aaaa-alive-1111';
    writeSession(id, {
      id,
      label: 'orphan-alive-会话',
      cwd: 'D:\\work\\orphan',
      createdAt: 1700000000000,
      pid: alivePid,
      sessionId: 'claude-sess-orphan-1',
    });

    const result = scanOrphans({ home: TEST_HOME, now: 1800000000000, isAlive: pid => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    } });

    expect(result.removedIds).not.toContain(id);
    const adopted = result.adopted.find(s => s.id === id);
    expect(adopted).toBeDefined();
    expect(adopted!.readOnly).toBe(true);                 // 关键：孤儿会话必须 readOnly
    expect(adopted!.status).toBe('running');
    expect(adopted!.label).toBe('orphan-alive-会话');
    expect(adopted!.cwd).toBe('D:\\work\\orphan');
    expect(adopted!.createdAt).toBe(1700000000000);
    expect(adopted!.statusSince).toBe(1800000000000);
    expect(adopted!.claudeSessionId).toBe('claude-sess-orphan-1');
    expect(result.adoptedPids.get(id)).toBe(alivePid);    // pid 交给 SessionManager 轮询存活
  });

  it('B. metadata.pid 已死 → 删除会话目录，记录到 removedIds', () => {
    const id = 'bbbb-dead-2222';
    const deadPid = 999_999_999;                         // 肯定不存在的 pid
    writeSession(id, { id, label: 'orphan-dead', cwd: 'D:\\x', createdAt: 1, pid: deadPid });
    expect(fs.existsSync(path.join(SESSIONS_DIR, id))).toBe(true);

    const result = scanOrphans({ home: TEST_HOME, now: 2, isAlive: pid => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    } });

    expect(result.removedIds).toContain(id);
    expect(result.adopted.find(s => s.id === id)).toBeUndefined();
    expect(fs.existsSync(path.join(SESSIONS_DIR, id))).toBe(false);   // 真删了
  });

  it('C. metadata.json 损坏 → 跳过该目录不抛错（健壮性）', () => {
    const id = 'cccc-corrupt-3333';
    const dir = path.join(SESSIONS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'metadata.json'), '{ this is not json');

    const result = scanOrphans({ home: TEST_HOME, now: 1, isAlive: () => false });
    // 损坏的 metadata 因 JSON.parse 失败被 try/catch 吞掉；不会出现在 adopted 也不会出现在 removedIds
    expect(result.adopted.find(s => s.id === id)).toBeUndefined();
  });

  it('D. 混合扫描：1 活 + 1 死 + 1 损坏 + 1 缺 pid → 各按规则处理', () => {
    const liveId = 'live-1';
    writeSession(liveId, { id: liveId, label: 'live', cwd: 'D:\\l', createdAt: 1, pid: alivePid });

    const deadId = 'dead-1';
    writeSession(deadId, { id: deadId, label: 'dead', cwd: 'D:\\d', createdAt: 1, pid: 888_888_888 });

    const noPidId = 'nopid-1';
    writeSession(noPidId, { id: noPidId, label: 'nopid', cwd: 'D:\\n', createdAt: 1 });   // 无 pid 字段

    const corruptId = 'corrupt-1';
    fs.mkdirSync(path.join(SESSIONS_DIR, corruptId), { recursive: true });
    fs.writeFileSync(path.join(SESSIONS_DIR, corruptId, 'metadata.json'), 'xxx');

    const result = scanOrphans({ home: TEST_HOME, now: 1, isAlive: pid => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    } });

    expect(result.adopted.find(s => s.id === liveId)).toBeDefined();
    expect(result.removedIds).toContain(deadId);
    expect(result.removedIds).toContain(noPidId);          // 无 pid 视作死
    expect(result.adopted.find(s => s.id === corruptId)).toBeUndefined();
    expect(result.removedIds).not.toContain(corruptId);   // 损坏跳过
  });

  it('E. 只读约束：readOnly 会话 writeInput/restart 必须被拒（防止误操作僵尸 PTY）', async () => {
    // 借真 SessionManager 验证
    process.env.CLAUDE_PANEL_HOME = TEST_HOME;
    const { SessionManager } = await import('../src/main/session-manager');
    const ptys: any[] = [];
    const sm = new SessionManager({
      ptyFactory: { spawn: () => { const p = { pid: 4242, written: [], write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} }; ptys.push(p); return p; } },
      hookClientPath: 'D:\\fake\\hc.js',
      mockClaudePath: 'D:\\fake\\mc.js',
    });
    sm.adoptSession({
      id: 'r1', label: 'orphan-restored', cwd: 'D:\\r',
      status: 'running', statusSince: 1, createdAt: 1, escalated: false, readOnly: true,
    });
    expect(sm.writeInput('r1', 'x')).toBe(false);          // writeInput 拒只读
    expect(sm.restartSession('r1').ok).toBe(false);         // restartSession 拒只读
    expect(ptys.length).toBe(0);                          // adopt 不 spawn，没副作用
    const cur = sm.getSessions().find(s => s.id === 'r1')!;
    expect(cur.readOnly).toBe(true);
    expect(cur.status).toBe('running');                   // 状态没被 restart 改
  });

  it('F. 认领会话进程退出 → pollOrphans 解除只读并转 disconnected，之后可重启', async () => {
    process.env.CLAUDE_PANEL_HOME = TEST_HOME;
    const { SessionManager } = await import('../src/main/session-manager');
    const ptys: any[] = [];
    const transitions: string[] = [];
    const sm = new SessionManager({
      ptyFactory: { spawn: () => { const p = { pid: 4242, written: [], write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} }; ptys.push(p); return p; } },
      hookClientPath: 'D:\\fake\\hc.js',
      mockClaudePath: 'D:\\fake\\mc.js',
      onTransition: (prev, curr) => transitions.push(`${prev.status}->${curr.status}`),
    });
    sm.adoptSession({
      id: 'r2', label: 'orphan-dies', cwd: os.tmpdir(),
      status: 'running', statusSince: 1, createdAt: 1, escalated: false, readOnly: true,
    }, 7777);
    let alive = true;
    expect(sm.pollOrphans(() => alive)).toBe(0);
    expect(sm.getSessions().find(s => s.id === 'r2')!.readOnly).toBe(true);

    alive = false;
    expect(sm.pollOrphans(() => alive)).toBe(1);
    const cur = sm.getSessions().find(s => s.id === 'r2')!;
    expect(cur.readOnly).toBe(false);
    expect(cur.status).toBe('disconnected');
    expect(cur.exitCode).toBeNull();
    expect(transitions).toEqual(['running->disconnected']);
    expect(sm.pollOrphans(() => alive)).toBe(0);          // 已处理过的不再重复判定

    expect(sm.restartSession('r2', { mode: 'fresh' }).ok).toBe(true);
    expect(ptys.length).toBe(1);
    expect(sm.getSessions().find(s => s.id === 'r2')!.status).toBe('running');
  });
});
