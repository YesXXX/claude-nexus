import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { HOOK_MAX_BODY_BYTES, HookReceiver, extractClaudeSessionId, extractTranscriptPath } from '../src/main/hook-receiver';
import { HookMessage } from '../src/shared/types';

// 测试用临时面板数据目录
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-test-'));
process.env.CLAUDE_PANEL_HOME = TEST_HOME;

const received: HookMessage[] = [];
let receiver: HookReceiver;
let port = 0;
let token = '';

/** 带本次令牌与 JSON 类型的上报；headers 可覆盖或去掉其中的字段 */
const hook = (body: string, headers: Record<string, string> = {}): Promise<Response> => fetch(`http://127.0.0.1:${port}/hook`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-nexus-token': token, ...headers }, body,
});
const post = (sessionId: string, payload: object): Promise<Response> => hook(JSON.stringify({ sessionId, payload }));

beforeAll(async () => {
  receiver = new HookReceiver(msg => received.push(msg));
  port = await receiver.start();
  token = fs.readFileSync(path.join(TEST_HOME, 'receiver.token'), 'utf8').trim();
});

afterAll(async () => {
  await receiver.stop();
});

describe('HookReceiver', () => {
  it('启动后把端口写入 <panelHome>/receiver.port，随机令牌写入 receiver.token', () => {
    const written = fs.readFileSync(path.join(TEST_HOME, 'receiver.port'), 'utf8').trim();
    expect(Number(written)).toBe(port);
    expect(token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('POST /hook 收到 { sessionId, payload } 并交给回调', async () => {
    const res = await post('s1', { hook_event_name: 'Stop' });
    expect(res.status).toBe(200);
    expect(received).toContainEqual({
      sessionId: 's1',
      event: { type: 'turn_completed' },
    });
  });

  it('缺少令牌或令牌不对返回 401，不分发事件', async () => {
    const body = JSON.stringify({ sessionId: 'forged', payload: { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' } });
    const none = await fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(none.status).toBe(401);
    expect((await hook(body, { 'x-nexus-token': 'f'.repeat(48) })).status).toBe(401);
    expect((await hook(body, { 'x-nexus-token': 'short' })).status).toBe(401);
    expect(received.some(m => m.sessionId === 'forged')).toBe(false);
  });

  it('Content-Type 不是 JSON（浏览器跨域简单请求）返回 415', async () => {
    const res = await hook(JSON.stringify({ sessionId: 'forged2', payload: { hook_event_name: 'Stop' } }), { 'content-type': 'text/plain' });
    expect(res.status).toBe(415);
    expect(received.some(m => m.sessionId === 'forged2')).toBe(false);
  });

  it('请求体超过上限返回 413，服务仍可用', async () => {
    const big = JSON.stringify({ sessionId: 'big', payload: { hook_event_name: 'Stop', pad: 'x'.repeat(HOOK_MAX_BODY_BYTES) } });
    expect((await hook(big)).status).toBe(413);
    expect(received.some(m => m.sessionId === 'big')).toBe(false);
    expect((await post('after-big', { hook_event_name: 'Stop' })).status).toBe(200);
  });

  it('非法 JSON 返回 400 且不崩溃', async () => {
    const res = await hook('not-json{');
    expect(res.status).toBe(400);
  });

  it('未知路径返回 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/other`);
    expect(res.status).toBe(404);
  });

  it('payload 带 session_id 时消息附带 claudeSessionId（子代理事件同样附带）', async () => {
    await post('s2', { hook_event_name: 'PostToolUse', session_id: 'claude-abc' });
    await post('s2', { hook_event_name: 'SubagentStart', session_id: 'claude-def', agent_id: 'a1' });
    expect(received).toContainEqual({ sessionId: 's2', event: { type: 'tool_finished' }, claudeSessionId: 'claude-abc' });
    expect(received.find(m => m.event.type === 'subagent_start' && m.sessionId === 's2')?.claudeSessionId).toBe('claude-def');
  });

  it('SessionStart → session_started（带 source），UserPromptSubmit → prompt_submitted；transcript_path 随消息附带', async () => {
    const tp = 'C:\\x\\.claude\\projects\\D--a\\c-1.jsonl';
    await post('s3', { hook_event_name: 'SessionStart', source: 'resume', session_id: 'c-1', transcript_path: tp });
    await post('s3', { hook_event_name: 'SessionStart', source: 'weird', session_id: 'c-1' });
    await post('s3', { hook_event_name: 'UserPromptSubmit', prompt: 'hi', session_id: 'c-1', transcript_path: tp });
    expect(received).toContainEqual({
      sessionId: 's3', event: { type: 'session_started', source: 'resume' }, claudeSessionId: 'c-1', transcriptPath: tp,
    });
    expect(received).toContainEqual({
      sessionId: 's3', event: { type: 'session_started', source: 'unknown' }, claudeSessionId: 'c-1',
    });
    expect(received).toContainEqual({
      sessionId: 's3', event: { type: 'prompt_submitted', prompt: 'hi' }, claudeSessionId: 'c-1', transcriptPath: tp,
    });
  });

  it('PostToolUse、Stop 与子代理事件同样透传 transcript_path', async () => {
    const tp = 'C:\\x\\projects\\D--a\\c-4.jsonl';
    await post('s4', { hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 'c-4', transcript_path: tp });
    await post('s4', { hook_event_name: 'Stop', session_id: 'c-4', transcript_path: tp });
    await post('s4', { hook_event_name: 'SubagentStop', session_id: 'c-4', agent_id: 'a9', transcript_path: tp });
    const mine = received.filter(m => m.sessionId === 's4');
    expect(mine.map(m => m.event.type)).toEqual(['tool_finished', 'turn_completed', 'subagent_stop']);
    expect(mine.every(m => m.transcriptPath === tp)).toBe(true);
  });
});

describe('extractTranscriptPath', () => {
  it('只接受 .jsonl 字符串路径', () => {
    expect(extractTranscriptPath({ transcript_path: 'C:\\p\\a.jsonl' })).toBe('C:\\p\\a.jsonl');
    expect(extractTranscriptPath({ transcript_path: 'C:\\p\\a.txt' })).toBeUndefined();
    expect(extractTranscriptPath({ transcript_path: 3 as unknown as string })).toBeUndefined();
    expect(extractTranscriptPath(undefined)).toBeUndefined();
  });
});

describe('extractClaudeSessionId', () => {
  it('优先 session_id，缺失时取 transcript_path 文件名，都没有返回 undefined', () => {
    expect(extractClaudeSessionId({ session_id: 'x1', transcript_path: 'p/y2.jsonl' })).toBe('x1');
    expect(extractClaudeSessionId({ transcript_path: 'C:\\Users\\u\\.claude\\projects\\proj\\y2.jsonl' })).toBe('y2');
    expect(extractClaudeSessionId({ transcript_path: '/home/u/.claude/projects/proj/z3.jsonl' })).toBe('z3');
    expect(extractClaudeSessionId({ hook_event_name: 'Stop' })).toBeUndefined();
    expect(extractClaudeSessionId(undefined)).toBeUndefined();
  });
});

describe('hook-client.js 端到端', () => {
  it('子进程方式运行：stdin payload + 环境变量 sessionId → 读取令牌上报，事件到达 receiver', async () => {
    const repoRoot = path.resolve(__dirname, '..');
    const child = execFile('node', [path.join(repoRoot, 'scripts', 'hook-client.js')], {
      env: { ...process.env, CLAUDE_PANEL_SESSION_ID: 'e2e-1' },
    });
    child.stdin!.write(JSON.stringify({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', tool_name: 'Bash', tool_input: { command: 'npm test' } }));
    child.stdin!.end();
    await new Promise(resolve => child.on('exit', resolve));

    await new Promise(r => setTimeout(r, 300));
    expect(received).toContainEqual({
      sessionId: 'e2e-1',
      event: { type: 'permission_request', toolName: 'Bash', commandText: 'npm test' },
    });
  }, 20000);
});
