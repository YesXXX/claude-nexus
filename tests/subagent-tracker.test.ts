import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { SubagentTracker, POLL_INTERVAL_MS, SUBAGENT_BUFFER_MAX_CHARS, SUBAGENT_ENTRY_MAX } from '../src/main/subagent-tracker';
import { Session } from '../src/shared/types';

/** 内存 fs mock：用 Map 模拟文件读写；key 统一归一化为 / 以便跨平台兼容 tracker 内部 path.replace 的行为 */
const normPath = (p: string): string => p.replace(/\\/g, '/');

class MemFs {
  files = new Map<string, Buffer>();
  read(p: string): Buffer {
    const key = normPath(p);
    const b = this.files.get(key);
    if (!b) {
      const err: NodeJS.ErrnoException = new Error('mock ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return b;
  }
  write(p: string, body: string | Buffer): void {
    this.files.set(normPath(p), Buffer.isBuffer(body) ? body : Buffer.from(body));
  }
  delete(p: string): boolean { return this.files.delete(normPath(p)); }
  exists(p: string): boolean {
    const key = normPath(p);
    if (this.files.has(key)) return true;
    // 目录判定：任何 key 以该路径加斜杠开头即视为存在
    const dirPrefix = key.endsWith('/') ? key : key + '/';
    for (const k of this.files.keys()) if (k.startsWith(dirPrefix)) return true;
    return false;
  }
  /** 返回该目录下的直接子项（取首个分隔段），用于模拟 fs.readdirSync 单层语义 */
  list(dir: string): string[] {
    const prefix = normPath(dir).replace(/\/$/, '') + '/';
    const out = new Set<string>();
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix)) {
        const rest = k.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first) out.add(first);
      }
    }
    return [...out];
  }
}

function makeSession(id = 'sess-1'): Session {
  return { id, label: 'test', cwd: 'D:\\x', status: 'running', statusSince: 1, createdAt: 1, escalated: false, claudeSessionId: 'claude-1' };
}

describe('SubagentTracker', () => {
  let fs: MemFs;
  let changes: number;
  let outputs: Array<{ sessionId: string; agentId: string; chunk: string; end: number }>;
  let tracker: SubagentTracker;

  beforeEach(() => {
    fs = new MemFs();
    changes = 0;
    outputs = [];
    tracker = new SubagentTracker({
      now: () => 100,
      readFileSync: (p) => fs.read(p),    // 闭包绑定 this，避免方法引用丢失上下文
      existsSync: (p) => fs.exists(p),
      readdirSync: (dir) => fs.list(dir),
      onChange: () => { changes++; },
      onOutput: (sessionId, agentId, chunk, end) => outputs.push({ sessionId, agentId, chunk, end }),
    });
  });

  it('Start 建条目：description 优先 meta.json，降级 jsonl 首行 prompt', () => {
    const tp = path.join('proj', 'claude-1', 'subagents', 'agent-abc123.jsonl');
    const mp = path.join('proj', 'claude-1', 'subagents', 'agent-abc123.meta.json');
    fs.write(mp, JSON.stringify({ agentType: 'Explore', description: '调研模块结构' }));
    fs.write(tp, JSON.stringify({ type: 'user', message: { content: 'fallback prompt' } }) + '\n');
    tracker.handleHook('s1', {
      hook_event_name: 'SubagentStart', session_id: 's1',
      agent_id: 'abc123', agent_type: 'Explore', agent_transcript_path: tp,
    });
    const subs = tracker.getSubagents('s1');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ agentId: 'abc123', agentType: 'Explore', description: '调研模块结构', status: 'running' });
    expect(changes).toBe(1);
  });

  it('Start 阶段 transcript 尚未建盘 → 路径由父 transcript 推导；首次 tick 不因 ENOENT 转 aborted', () => {
    // 用 / 分隔符，与 tracker 内部 deriveTranscriptFromParent 的 path.slice 行为对齐
    const parentTp = 'proj/claude-1.jsonl';
    const expectTp = 'proj/claude-1/subagents/agent-abc123.jsonl';
    tracker.handleHook('s1', {
      hook_event_name: 'SubagentStart', session_id: 's1',
      agent_id: 'abc123', agent_type: 'Explore', transcript_path: parentTp,
    });
    expect(tracker.getSubagents('s1')[0].transcriptPath).toBe(expectTp);
    // transcript 还不存在 → ENOENT → 应当保持 running，不算变化
    expect(() => tracker.tick()).not.toThrow();
    expect(tracker.getSubagents('s1')[0].status).toBe('running');
    expect(changes).toBe(1);   // 只有 Start 触发了一次
  });

  it('Stop：转 completed、写入 lastMessage、停止轮询；迟到 Stop（条目不存在）忽略', () => {
    tracker.handleHook('s1', {
      hook_event_name: 'SubagentStart', session_id: 's1',
      agent_id: 'abc123', agent_type: 'general-purpose', agent_transcript_path: path.join('p', 'a.jsonl'),
    });
    tracker.handleHook('s1', {
      hook_event_name: 'SubagentStop', session_id: 's1',
      agent_id: 'abc123', agent_type: 'general-purpose',
      last_assistant_message: '报告正文',
    });
    expect(tracker.getSubagents('s1')[0]).toMatchObject({ status: 'completed', lastMessage: '报告正文' });
    // tick 也不再读取（已 completed）→ outputs 不增长
    outputs.length = 0;
    tracker.tick();
    expect(outputs).toHaveLength(0);
    // 迟到 Stop
    expect(() => tracker.handleHook('s1', {
      hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'no-such',
    })).not.toThrow();
  });

  it('轮询：字节偏移正确推进；半行（最后无 \n）跳过', () => {
    const tp = path.join('p', 'agent-a.jsonl');
    fs.write(tp, '');
    tracker.handleHook('s1', {
      hook_event_name: 'SubagentStart', session_id: 's1',
      agent_id: 'a', agent_type: 'Explore', agent_transcript_path: tp,
    });
    fs.write(tp, JSON.stringify({ type: 'user', message: { content: '任务' } }) + '\n');   // 完整一行
    outputs.length = 0;
    tracker.tick();
    expect(outputs).toHaveLength(1);
    expect(outputs[0].chunk).toContain('▸ 任务：任务');
    // 半行追加：偏移不前进
    outputs.length = 0;
    fs.write(tp, Buffer.concat([fs.read(tp), Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '未完待续' }] } }))]));
    tracker.tick();
    expect(outputs).toHaveLength(0);   // 没有 \n 不消费
    // 补换行后消费
    fs.write(tp, Buffer.concat([fs.read(tp), Buffer.from('\n')]));
    tracker.tick();
    expect(outputs).toHaveLength(1);
    expect(outputs[0].chunk).toContain('未完待续');
  });

  it('轮询：文件消失（曾读过） → running 转 aborted；EBUSY/未读过的 ENOENT 静默跳过', () => {
    const tp = path.join('p', 'agent-a.jsonl');
    fs.write(tp, JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n');
    tracker.handleHook('s1', { hook_event_name: 'SubagentStart', session_id: 's1',
      agent_id: 'a', agent_type: 'Explore', agent_transcript_path: tp });
    tracker.tick();   // everRead=true
    fs.delete(tp);   // 删文件（归一化 key）
    tracker.tick();
    expect(tracker.getSubagents('s1')[0].status).toBe('aborted');
  });

  it('生命周期回调：开始、完成、父进程退出中止、文件消失中止各回调一次；回调抛错不影响状态', () => {
    const phases: string[] = [];
    const t = new SubagentTracker({
      now: () => 100,
      readFileSync: (p) => fs.read(p),
      existsSync: (p) => fs.exists(p),
      readdirSync: (dir) => fs.list(dir),
      onChange: () => undefined,
      onOutput: () => undefined,
      onLifecycle: (sid, entry, phase) => {
        phases.push(`${sid}:${entry.agentId}:${phase}`);
        if (entry.agentId === 'c') throw new Error('boom');
      },
    });
    const tp = path.join('p', 'agent-a.jsonl');
    fs.write(tp, '');
    for (const id of ['a', 'b', 'c']) {
      t.handleHook('s1', { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: id, agent_type: 'Explore', agent_transcript_path: tp });
    }
    t.handleHook('s1', { hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'b', agent_type: 'Explore', last_assistant_message: 'ok' });
    t.abortChildren('s1');
    expect(phases).toEqual(['s1:a:start', 's1:b:start', 's1:c:start', 's1:b:stop', 's1:a:abort', 's1:c:abort']);
    expect(t.getSubagents('s1').find(x => x.agentId === 'c')!.status).toBe('aborted');

    phases.length = 0;
    const tp2 = path.join('p', 'agent-d.jsonl');
    fs.write(tp2, JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n');
    t.handleHook('s2', { hook_event_name: 'SubagentStart', session_id: 's2', agent_id: 'd', agent_type: 'Explore', agent_transcript_path: tp2 });
    t.tick();
    fs.delete(tp2);
    t.tick();
    expect(phases).toEqual(['s2:d:start', 's2:d:abort']);
  });

  it('abortChildren：父 PTY 退出时其全部 running 子代理转 aborted；已完成的不动', () => {
    const tp = path.join('p', 'agent-a.jsonl');
    fs.write(tp, '');
    tracker.handleHook('s1', { hook_event_name: 'SubagentStart', session_id: 's1',
      agent_id: 'a', agent_type: 'Explore', agent_transcript_path: tp });
    tracker.handleHook('s1', { hook_event_name: 'SubagentStart', session_id: 's1',
      agent_id: 'b', agent_type: 'Explore', agent_transcript_path: tp });
    tracker.handleHook('s1', { hook_event_name: 'SubagentStop', session_id: 's1',
      agent_id: 'b', agent_type: 'Explore', last_assistant_message: 'done' });
    tracker.abortChildren('s1');
    const subs = tracker.getSubagents('s1');
    expect(subs.find(x => x.agentId === 'a')!.status).toBe('aborted');
    expect(subs.find(x => x.agentId === 'b')!.status).toBe('completed');
  });

  it('clearSession：父会话从列表移除 → 条目 + 缓冲全清', () => {
    const tp = path.join('p', 'agent-a.jsonl');
    fs.write(tp, JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n');
    tracker.handleHook('s1', { hook_event_name: 'SubagentStart', session_id: 's1',
      agent_id: 'a', agent_type: 'Explore', agent_transcript_path: tp });
    tracker.tick();
    expect(tracker.getSubagents('s1')).toHaveLength(1);
    expect(tracker.getLog('s1', 'a')).not.toBe('');
    tracker.clearSession('s1');
    expect(tracker.getSubagents('s1')).toHaveLength(0);
    expect(tracker.getLog('s1', 'a')).toBe('');
  });

  it('reconstruct：末行闭合不重建；未闭合重建并续 poll（offset 从末尾开始只追增量）', () => {
    // reconstruct 会扫 <root>/<proj>/<claudeId>/subagents/ 下所有 jsonl
    const root = 'proj';
    const projDir = 'proj/work';
    const claudeId = 'claude-1';
    const subDir = `${projDir}/${claudeId}/subagents`;
    const liveTp = `${subDir}/agent-live.jsonl`;
    const doneTp = `${subDir}/agent-done.jsonl`;
    const cmpTp  = `${subDir}/agent-acompact-x.jsonl`;
    fs.write(liveTp, JSON.stringify({ type: 'user', message: { content: 'live' } }) + '\n'
      + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a' } }] } }) + '\n');
    fs.write(doneTp, JSON.stringify({ type: 'user', message: { content: 'done' } }) + '\n'
      + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '完成' }] } }) + '\n');
    fs.write(cmpTp, JSON.stringify({ type: 'user', message: { content: 'compact' } }) + '\n');
    fs.write(`${subDir}/agent-live.meta.json`, JSON.stringify({ agentType: 'Explore', description: '活' }));
    fs.write(`${subDir}/agent-done.meta.json`, JSON.stringify({ agentType: 'Explore', description: '死' }));

    const built = tracker.reconstruct({ ...makeSession('sess-1'), claudeSessionId: claudeId }, root);
    expect(built).toBe(1);   // 只重建活的那一个
    const subs = tracker.getSubagents('sess-1');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ agentId: 'live', agentType: 'Explore', description: '活', status: 'running' });
    // 回放已含历史内容
    expect(tracker.getLog('sess-1', 'live')).toContain('▸ 任务：live');
    expect(tracker.getLog('sess-1', 'live')).toContain('⚙ Read a');
    // 后续追加 → tick 推流（offset 已置末尾）
    fs.write(liveTp, Buffer.concat([fs.read(liveTp), Buffer.from(JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'text', text: '增量' }] },
    }) + '\n')]));
    outputs.length = 0;
    tracker.tick();
    expect(outputs.some(o => o.chunk.includes('增量'))).toBe(true);
  });

  it('reconstruct：根目录不存在 / session 无 claudeSessionId 安全返回 0', () => {
    const s = { ...makeSession(), claudeSessionId: undefined } as unknown as Session;
    expect(tracker.reconstruct(s, 'no-such-root')).toBe(0);
    expect(tracker.reconstruct(makeSession(), 'no-such-root')).toBe(0);
  });

  it('buffer 上限：超 SUBAGENT_BUFFER_MAX_CHARS 字符后丢头', () => {
    const tp = path.join('p', 'agent-a.jsonl');
    fs.write(tp, '');
    tracker.handleHook('s1', { hook_event_name: 'SubagentStart', session_id: 's1',
      agent_id: 'a', agent_type: 'Explore', agent_transcript_path: tp });
    // 写足够多完整行，让 chunk 累计超过 400K 触发丢头；user prompt 行渲染前 120 字符
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(200) }] } }) + '\n';
    let body = '';
    while (body.length < SUBAGENT_BUFFER_MAX_CHARS + 5000) body += line;
    fs.write(tp, body);
    tracker.tick();
    const buf = tracker.getLog('s1', 'a');
    expect(buf.length).toBeLessThanOrEqual(SUBAGENT_BUFFER_MAX_CHARS);
    expect(buf.endsWith('x\n') || buf.endsWith('x')).toBe(true);
  });

  it('累计偏移：快照 end 与最后一次推送的 end 一致；丢头后 end 继续增长；clearSession 归零', () => {
    const tp = path.join('p', 'agent-a.jsonl');
    fs.write(tp, '');
    tracker.handleHook('s1', { hook_event_name: 'SubagentStart', session_id: 's1',
      agent_id: 'a', agent_type: 'Explore', agent_transcript_path: tp });
    expect(tracker.getLogSnapshot('s1', 'a')).toEqual({ text: '', end: 0 });

    fs.write(tp, JSON.stringify({ type: 'user', message: { content: '任务' } }) + '\n');
    outputs.length = 0;
    tracker.tick();
    const first = outputs[0];
    expect(first.end).toBe(first.chunk.length);
    expect(tracker.getLogSnapshot('s1', 'a')).toEqual({ text: first.chunk, end: first.end });

    // 再追加一批超过缓冲上限的内容：缓冲丢头，但 end 仍是全量累计
    // 渲染后文本比 jsonl 原文短，按两倍上限造数据确保丢头
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(200) }] } }) + '\n';
    let body = '';
    while (body.length < SUBAGENT_BUFFER_MAX_CHARS * 2) body += line;
    fs.write(tp, Buffer.concat([fs.read(tp), Buffer.from(body)]));
    outputs.length = 0;
    tracker.tick();
    const second = outputs[outputs.length - 1];
    expect(second.end).toBe(first.end + second.chunk.length);
    const snap = tracker.getLogSnapshot('s1', 'a');
    expect(snap.end).toBe(second.end);
    expect(snap.text.length).toBeLessThanOrEqual(SUBAGENT_BUFFER_MAX_CHARS);
    expect(snap.end).toBeGreaterThan(SUBAGENT_BUFFER_MAX_CHARS);

    tracker.clearSession('s1');
    expect(tracker.getLogSnapshot('s1', 'a')).toEqual({ text: '', end: 0 });
  });

  it('isAcompact 不会被 rebuild 进条目（设计约束）', () => {
    const tp = path.join('proj', 'claude-1', 'subagents', 'agent-acompact-x.jsonl');
    fs.write(tp, JSON.stringify({ type: 'user', message: { content: 'compact prompt' } }) + '\n'
      + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a' } }] } }) + '\n');
    const built = tracker.reconstruct(makeSession(), 'proj');
    expect(built).toBe(0);
  });

  it('常量：POLL_INTERVAL_MS 为 1s', () => {
    expect(POLL_INTERVAL_MS).toBe(1000);
  });

  it('dismissSubagent：运行中拒绝关闭；已结束可关闭并清缓冲；不存在返回 false', () => {
    const tp = path.join('p', 'agent-a.jsonl');
    fs.write(tp, JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n');
    tracker.handleHook('s1', { hook_event_name: 'SubagentStart', session_id: 's1',
      agent_id: 'a', agent_type: 'Explore', agent_transcript_path: tp });
    tracker.tick();
    expect(tracker.getLog('s1', 'a')).not.toBe('');
    expect(tracker.dismissSubagent('s1', 'a')).toBe(false);   // 仍 running：拒绝
    expect(tracker.getSubagents('s1')).toHaveLength(1);

    tracker.handleHook('s1', { hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a' });
    const before = changes;
    expect(tracker.dismissSubagent('s1', 'a')).toBe(true);
    expect(tracker.getSubagents('s1')).toHaveLength(0);
    expect(tracker.getLog('s1', 'a')).toBe('');
    expect(changes).toBe(before + 1);

    expect(tracker.dismissSubagent('s1', 'no-such')).toBe(false);
  });

  it('自动淘汰：已结束条目超过 SUBAGENT_ENTRY_MAX 时淘汰最旧的；运行中的永不参与淘汰', () => {
    let t = 0;
    const local = new SubagentTracker({
      now: () => ++t,
      readFileSync: (p) => fs.read(p),
      existsSync: (p) => fs.exists(p),
      readdirSync: (dir) => fs.list(dir),
    });
    local.handleHook('s1', { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'keep-running', agent_type: 'Explore' });
    for (let i = 0; i < SUBAGENT_ENTRY_MAX + 5; i++) {
      const id = `a${i}`;
      local.handleHook('s1', { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: id, agent_type: 'Explore' });
      local.handleHook('s1', { hook_event_name: 'SubagentStop', session_id: 's1', agent_id: id });
    }
    const subs = local.getSubagents('s1');
    expect(subs.find(x => x.agentId === 'keep-running')?.status).toBe('running');
    const done = subs.filter(x => x.status !== 'running');
    expect(done).toHaveLength(SUBAGENT_ENTRY_MAX);
    expect(subs.find(x => x.agentId === 'a0')).toBeUndefined();   // 最旧的几个已淘汰
    expect(subs.find(x => x.agentId === 'a4')).toBeUndefined();
    expect(subs.find(x => x.agentId === `a${SUBAGENT_ENTRY_MAX + 4}`)).toBeDefined();   // 最新的保留
  });
});