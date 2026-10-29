import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';

/**
 * mock-claude 协议测试：真实起 node 子进程，临时 HTTP 接收 hook 上报，
 * 临时 CLAUDE_PANEL_HOME 存放端口文件，临时目录作为对话记录根。
 */

const MOCK = path.resolve(__dirname, '..', 'scripts', 'mock-claude.js');
const { parseArgs, projectDirName, createInputParser } = createRequire(__filename)(MOCK) as {
  parseArgs(a: string[]): Record<string, unknown>;
  projectDirName(c: string): string;
  createInputParser(o: { submit(line: string): void; echo?(text: string): void }): { feed(chunk: string): void };
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-mock-'));
const HOME = path.join(TMP, 'home');
const ROOT = path.join(TMP, 'projects');
const CWD = path.join(TMP, 'work dir');
const A = '9f1e2c4a-1111-4222-8333-444455556666';
const B = '0b0c0d0e-aaaa-4bbb-8ccc-ddddeeeeffff';

interface Hook { sessionId: string; payload: Record<string, unknown> }
const hooks: Hook[] = [];
let server: http.Server;

beforeAll(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(CWD, { recursive: true });
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => { hooks.push(JSON.parse(body) as Hook); res.end('ok'); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(HOME, 'receiver.token'), 'test-token');
  fs.writeFileSync(path.join(HOME, 'receiver.port'), String((server.address() as AddressInfo).port));
});

afterAll(async () => {
  await new Promise(r => server.close(r));
});

interface Run {
  child: ChildProcess;
  out: () => string;
  send(line: string): void;
  waitOut(text: string): Promise<void>;
  exit: Promise<number | null>;
}

function run(args: string[], env: Record<string, string> = {}): Run {
  const panelId = `p-${Math.random().toString(36).slice(2)}`;
  const child = spawn(process.execPath, [MOCK, ...args], {
    cwd: CWD,
    env: { ...process.env, CLAUDE_PANEL_HOME: HOME, CLAUDE_PANEL_TRANSCRIPT_ROOT: ROOT, CLAUDE_PANEL_SESSION_ID: panelId, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', c => (out += String(c)));
  const exit = new Promise<number | null>(r => child.once('exit', code => r(code)));
  const waitOut = async (text: string) => {
    const end = Date.now() + 8000;
    while (!out.includes(text)) {
      if (Date.now() > end) throw new Error(`等待输出「${text}」超时，当前输出：${out}`);
      await new Promise(r => setTimeout(r, 30));
    }
  };
  return { child, out: () => out, send: l => child.stdin!.write(`${l}\n`), waitOut, exit };
}

async function waitHooks(pred: (h: Hook[]) => boolean): Promise<void> {
  const end = Date.now() + 8000;
  while (!pred(hooks)) {
    if (Date.now() > end) throw new Error(`等待 hook 超时：${JSON.stringify(hooks.map(h => h.payload.hook_event_name))}`);
    await new Promise(r => setTimeout(r, 30));
  }
}

function hooksOf(id: string): Array<Record<string, unknown>> {
  return hooks.map(h => h.payload).filter(p => p.session_id === id);
}

const transcriptOf = (id: string) => path.join(ROOT, projectDirName(CWD), `${id}.jsonl`);

describe('mock-claude 参数解析', () => {
  it('识别续接相关参数，忽略未知参数', () => {
    expect(parseArgs(['--settings', 's.json', '--resume', A, '--fork-session', '--session-id', B, '--name', 'x', '--model', 'm', '--permission-mode', 'plan', '--verbose']))
      .toEqual({ sessionId: B, resumeId: A, fork: true, name: 'x', model: 'm', permissionMode: 'plan' });
  });
  it('项目目录名：非字母数字替换为 -', () => {
    expect(projectDirName('D:\\a b\\c')).toBe('D--a-b-c');
  });
});

describe('mock-claude 生命周期', () => {
  it('新建：用 --session-id，上报 SessionStart(startup)，多轮输入写对话记录', async () => {
    const r = run(['--settings', 'x.json', '--session-id', A]);
    await r.waitOut('mock-claude 已启动');
    await r.waitOut('CLAUDE_CODE_CHILD=');
    await waitHooks(() => hooksOf(A).some(p => p.hook_event_name === 'SessionStart'));
    const start = hooksOf(A).find(p => p.hook_event_name === 'SessionStart')!;
    expect(start.source).toBe('startup');
    expect(start.transcript_path).toBe(transcriptOf(A));
    expect(fs.existsSync(transcriptOf(A))).toBe(false);

    for (const task of ['first', 'second']) {
      r.send(task);
      await r.waitOut(`收到任务："${task}"`);
      await waitHooks(() => hooksOf(A).filter(p => p.hook_event_name === 'Notification').length >= (task === 'first' ? 1 : 2));
      r.send('y');
      await waitHooks(() => hooksOf(A).filter(p => p.hook_event_name === 'Stop').length >= (task === 'first' ? 1 : 2));
    }
    await r.waitOut('回合结束');
    const events = hooksOf(A).map(p => p.hook_event_name);
    expect(events).toEqual(['SessionStart',
      'UserPromptSubmit', 'PreToolUse', 'Notification', 'PostToolUse', 'Stop',
      'UserPromptSubmit', 'PreToolUse', 'Notification', 'PostToolUse', 'Stop']);
    expect(hooksOf(A).every(p => p.transcript_path === transcriptOf(A))).toBe(true);
    const lines = fs.readFileSync(transcriptOf(A), 'utf8').trim().split('\n').map(l => JSON.parse(l))
      .filter(l => l.type === 'user');
    expect(lines).toEqual([{ type: 'user', text: 'first' }, { type: 'user', text: 'second' }]);
    r.child.kill();
    await r.exit;
  });

  it('续接：记录存在时打印历史条数并沿用原 id，SessionStart(resume)', async () => {
    const r = run(['--resume', A]);
    await r.waitOut('已续接，历史 2 条');
    await waitHooks(() => hooksOf(A).some(p => p.hook_event_name === 'SessionStart' && p.source === 'resume'));
    r.child.kill();
    await r.exit;
  });

  it('分叉：换新 id，复制原记录', async () => {
    const r = run(['--resume', A, '--fork-session', '--session-id', B]);
    await r.waitOut(`已分叉自 ${A}`);
    await waitHooks(() => hooksOf(B).some(p => p.hook_event_name === 'SessionStart' && p.source === 'resume'));
    expect(fs.readFileSync(transcriptOf(B), 'utf8')).toBe(fs.readFileSync(transcriptOf(A), 'utf8'));
    r.child.kill();
    await r.exit;
  });

  it('续接不存在的 id 或强制失败：打印找不到对话并以 1 退出', async () => {
    const missing = 'aaaaaaaa-0000-4000-8000-000000000000';
    const r1 = run(['--resume', missing]);
    expect(await r1.exit).toBe(1);
    expect(r1.out()).toContain(`No conversation found with session ID: ${missing}`);
    expect(hooksOf(missing)).toEqual([]);

    const r2 = run(['--resume', A], { CLAUDE_PANEL_MOCK_RESUME_FAIL: '1' });
    expect(await r2.exit).toBe(1);
    expect(r2.out()).toContain('No conversation found');
  });

  it('无 --session-id 时自行生成 id；NO_TRANSCRIPT 不写记录；打印 CLAUDE_CODE_CHILD', async () => {
    const before = hooks.length;
    const r = run([], { CLAUDE_PANEL_MOCK_NO_TRANSCRIPT: '1', CLAUDE_CODE_CHILD: '1' });
    await r.waitOut('CLAUDE_CODE_CHILD=1');
    await waitHooks(h => h.slice(before).some(x => x.payload.hook_event_name === 'SessionStart'));
    const id = String(hooks.slice(before).find(x => x.payload.hook_event_name === 'SessionStart')!.payload.session_id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    r.send('task');
    await r.waitOut('收到任务："task"');
    r.send('n');
    await r.waitOut('已拒绝');
    await waitHooks(() => hooksOf(id).some(p => p.hook_event_name === 'Stop'));
    expect(fs.existsSync(transcriptOf(id))).toBe(false);
    r.child.kill();
    await r.exit;
  });

  it('/exit 以退出码 0 退出，不写对话记录', async () => {
    const r = run(['--resume', A]);
    await r.waitOut('已续接');
    const before = fs.readFileSync(transcriptOf(A), 'utf8');
    r.send('/exit');
    expect(await r.exit).toBe(0);
    expect(r.out()).toContain('已退出');
    expect(fs.readFileSync(transcriptOf(A), 'utf8')).toBe(before);
  });

  it('启动后输出粘贴模式开启序列；粘贴整段算一条任务并回显行数；原始输入写入记录文件', async () => {
    const log = path.join(TMP, 'mock-in.log');
    const r = run([], { CLAUDE_PANEL_MOCK_NO_TRANSCRIPT: '1', CLAUDE_PANEL_MOCK_INPUT_LOG: log });
    await r.waitOut('\x1b[?2004h');
    const paste = '\x1b[200~第一行\r第二行\r第三行\x1b[201~';
    r.child.stdin!.write(paste);
    await new Promise(res => setTimeout(res, 60));
    r.child.stdin!.write('\r');
    await r.waitOut('收到任务（3 行）："第一行"');
    r.send('n');
    await r.waitOut('已拒绝');
    const prompts = hooks.map(h => h.payload).filter(p => p.hook_event_name === 'UserPromptSubmit' && String(p.prompt).startsWith('第一行'));
    expect(prompts.map(p => p.prompt)).toEqual(['第一行\n第二行\n第三行']);
    const writes = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => (JSON.parse(l) as { data: string }).data);
    expect(writes.slice(0, 2)).toEqual([paste, '\r']);
    r.child.kill();
    await r.exit;
  });

  it('信任确认：回车前不上报 SessionStart、不开启粘贴模式，确认后照常启动', async () => {
    const id = 'c0c0c0c0-1111-4222-8333-000000000001';
    const r = run(['--session-id', id], { CLAUDE_PANEL_MOCK_NO_TRANSCRIPT: '1', CLAUDE_PANEL_MOCK_TRUST: '1' });
    await r.waitOut('Do you trust the files in this folder?');
    await new Promise(res => setTimeout(res, 300));
    expect(hooksOf(id)).toEqual([]);
    expect(r.out()).not.toContain('\x1b[?2004h');
    r.send('');
    await r.waitOut('\x1b[?2004h');
    await waitHooks(() => hooksOf(id).some(p => p.hook_event_name === 'SessionStart'));
    r.child.kill();
    await r.exit;
  });

  it('信任确认选 2 以退出码 1 退出', async () => {
    const r = run([], { CLAUDE_PANEL_MOCK_NO_TRANSCRIPT: '1', CLAUDE_PANEL_MOCK_TRUST: '1' });
    await r.waitOut('2. No, exit');
    r.send('2');
    expect(await r.exit).toBe(1);
  });

  it('不请求权限的回合直接执行到 Stop，并把任务首行追加到指定文件', async () => {
    const id = 'c0c0c0c0-1111-4222-8333-000000000002';
    const edit = 'mock-edit.txt';
    const r = run(['--session-id', id], {
      CLAUDE_PANEL_MOCK_NO_TRANSCRIPT: '1', CLAUDE_PANEL_MOCK_NO_PERMISSION: '1',
      CLAUDE_PANEL_MOCK_EDIT: edit, CLAUDE_PANEL_MOCK_TURN_MS: '50',
    });
    await r.waitOut('\x1b[?2004h');
    r.send('改一下');
    await waitHooks(() => hooksOf(id).some(p => p.hook_event_name === 'Stop'));
    expect(hooksOf(id).map(p => p.hook_event_name)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
    expect(fs.readFileSync(path.join(CWD, edit), 'utf8')).toBe('改一下\n');
    r.child.kill();
    await r.exit;
  });
});

describe('mock-claude 输入解析', () => {
  function parse(chunks: string[]): string[] {
    const out: string[] = [];
    const p = createInputParser({ submit: (l: string) => out.push(l) });
    for (const c of chunks) p.feed(c);
    return out;
  }

  it('回车提交；\\r\\n 只提交一次；退格删除', () => {
    expect(parse(['ab\rcd\r\nef\n'])).toEqual(['ab', 'cd', 'ef']);
    expect(parse(['ab\x7fc\r'])).toEqual(['ac']);
  });

  it('粘贴内的换行不提交，回车单独到达后整段提交', () => {
    expect(parse(['\x1b[200~a\rb\r\nc\x1b[201~', '\r'])).toEqual(['a\nb\nc']);
    // 粘贴后没有回车：不提交
    expect(parse(['\x1b[200~a\rb\x1b[201~'])).toEqual([]);
  });

  it('标记被切在两个数据块之间也能识别', () => {
    const whole = 'x\x1b[200~a\rb\x1b[201~\r';
    for (let cut = 1; cut < whole.length; cut++) {
      expect(parse([whole.slice(0, cut), whole.slice(cut)]), `cut=${cut}`).toEqual(['xa\nb']);
    }
  });

  it('其他控制序列（焦点、方向键）忽略', () => {
    expect(parse(['\x1b[I\x1b[Aab\x1b[O\r'])).toEqual(['ab']);
  });

  it('回显：可见字符原样，控制字符为 ^X，提交时换行', () => {
    let echoed = '';
    const p = createInputParser({ submit: () => undefined, echo: (t: string) => { echoed += t; } });
    p.feed('a\x0bb\r');
    expect(echoed).toBe('a^Kb\r\n');
  });
});
