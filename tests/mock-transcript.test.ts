import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { parseLine } from '../src/shared/usage-parse';
import type { ParsedLine, UsageRecord } from '../src/shared/usage-types';

/**
 * mock-claude 写带用量的假 transcript：真实起 node 子进程，临时 HTTP 接收 hook，
 * 断言生成的记录能被用量解析读出预期数字；未指定记录根目录时不写用量记录。
 */

const MOCK = path.resolve(__dirname, '..', 'scripts', 'mock-claude.js');
const { projectDirName, agentPathOf } = createRequire(__filename)(MOCK) as {
  projectDirName(c: string): string;
  agentPathOf(t: string, id: string): string;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-mock-usage-'));
const HOME = path.join(TMP, 'home');
const ROOT = path.join(TMP, 'projects');
const CWD = path.join(TMP, 'work');

const hooks: Array<Record<string, unknown>> = [];
let server: http.Server;

beforeAll(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(CWD, { recursive: true });
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => { hooks.push((JSON.parse(body) as { payload: Record<string, unknown> }).payload); res.end('ok'); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(HOME, 'receiver.token'), 'test-token');
  fs.writeFileSync(path.join(HOME, 'receiver.port'), String((server.address() as AddressInfo).port));
});

afterAll(async () => {
  await new Promise(r => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function until(pred: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 8000;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`等待${what}超时`);
    await new Promise(r => setTimeout(r, 30));
  }
}

/** 起一个 mock，依次跑完给定任务（每轮都同意），返回会话 id */
async function runTasks(id: string, tasks: string[], env: Record<string, string | undefined>): Promise<void> {
  const child: ChildProcess = spawn(process.execPath, [MOCK, '--session-id', id], {
    cwd: CWD,
    env: { ...process.env, CLAUDE_PANEL_HOME: HOME, CLAUDE_PANEL_SESSION_ID: 'p1', CLAUDE_PANEL_TRANSCRIPT_ROOT: undefined, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exit = new Promise(r => child.once('exit', r));
  const of = (name: string) => hooks.filter(h => h.session_id === id && h.hook_event_name === name).length;
  await until(() => of('SessionStart') === 1, 'SessionStart');
  for (const [i, task] of tasks.entries()) {
    child.stdin!.write(`${task}\n`);
    await until(() => of('Notification') === i + 1, '权限通知');
    child.stdin!.write('y\n');
    await until(() => of('Stop') === i + 1, 'Stop');
  }
  child.stdin!.write('/exit\n');
  await exit;
}

const parsedOf = (file: string): ParsedLine[] =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(parseLine).filter((x): x is ParsedLine => !!x);
const usagesOf = (file: string): UsageRecord[] => parsedOf(file).filter((x): x is UsageRecord => x.kind === 'usage');

describe('mock 写带用量的假 transcript', () => {
  it('每轮同一 id 三行，output 1、800、2000，最后一行为固定用量；模型取环境变量', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    await runTasks(id, ['first', 'second'], { CLAUDE_PANEL_TRANSCRIPT_ROOT: ROOT, CLAUDE_PANEL_MOCK_MODEL: 'claude-sonnet-5' });
    const file = path.join(ROOT, projectDirName(CWD), `${id}.jsonl`);
    const us = usagesOf(file);
    expect(us).toHaveLength(6);
    expect(new Set(us.map(u => u.id)).size).toBe(2);
    expect(us.slice(0, 3).map(u => u.output)).toEqual([1, 800, 2000]);
    expect(new Set(us.slice(0, 3).map(u => u.id)).size).toBe(1);
    expect(us[2]).toMatchObject({
      model: 'claude-sonnet-5', input: 1000, output: 2000, cacheRead: 100000, cacheWrite5m: 20000, cacheWrite1h: 0, sidechain: false,
    });
    expect(us[2].ts).toBeGreaterThan(0);
    const users = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.includes('"type":"user"'));
    expect(users).toHaveLength(2);
  });

  it('big 写到 1M 窗口的 85%，unknown 换未知模型，compact 写压缩边界', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    await runTasks(id, ['big', 'unknown', 'compact'], { CLAUDE_PANEL_TRANSCRIPT_ROOT: ROOT });
    const file = path.join(ROOT, projectDirName(CWD), `${id}.jsonl`);
    const all = parsedOf(file);
    const us = all.filter((x): x is UsageRecord => x.kind === 'usage');
    const big = us[2];
    expect(big.model).toBe('claude-opus-5');
    expect(big.input + big.cacheRead + big.cacheWrite5m + big.cacheWrite1h).toBe(850_000);
    expect(us[5].model).toBe('mock-unknown-1');
    const ci = all.findIndex(x => x.kind === 'compact');
    expect(all[ci]).toMatchObject({ kind: 'compact', postTokens: 30000 });
    expect(all.slice(ci + 1).filter(x => x.kind === 'usage')).toHaveLength(3);
  });

  it('sub 写子代理记录并上报 SubagentStart / SubagentStop', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    await runTasks(id, ['sub task'], { CLAUDE_PANEL_TRANSCRIPT_ROOT: ROOT });
    const file = path.join(ROOT, projectDirName(CWD), `${id}.jsonl`);
    const agent = agentPathOf(file, 'mock1');
    expect(agent).toBe(path.join(ROOT, projectDirName(CWD), id, 'subagents', 'agent-mock1.jsonl'));
    const us = usagesOf(agent);
    expect(us).toHaveLength(1);
    expect(us[0]).toMatchObject({ input: 500, output: 1000, cacheRead: 10000, cacheWrite5m: 0, sidechain: true });
    const start = hooks.find(h => h.session_id === id && h.hook_event_name === 'SubagentStart')!;
    const stop = hooks.find(h => h.session_id === id && h.hook_event_name === 'SubagentStop')!;
    expect(start).toMatchObject({ agent_id: 'mock1', agent_type: 'general-purpose' });
    expect(stop).toMatchObject({ agent_id: 'mock1', agent_transcript_path: agent });
  });

  it('未指定记录根目录时不写用量记录', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    await runTasks(id, ['sub big'], {});
    const file = path.join(HOME, 'mock-claude', 'projects', projectDirName(CWD), `${id}.jsonl`);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines).toEqual([JSON.stringify({ type: 'user', text: 'sub big' })]);
    expect(fs.existsSync(file.slice(0, -'.jsonl'.length))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, projectDirName(CWD), `${id}.jsonl`))).toBe(false);
    expect(hooks.some(h => h.session_id === id && String(h.hook_event_name).startsWith('Subagent'))).toBe(false);
  });
});
