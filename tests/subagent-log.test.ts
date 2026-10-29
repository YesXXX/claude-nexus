import { describe, it, expect } from 'vitest';
import {
  extractTaskDescription, isAcompactAgent, judgeAlive, parseJsonlLine, renderSubagentLine, renderSubagentLines,
  unseenPart,
} from '../src/shared/subagent-log';

const userPrompt = (text: string): string => JSON.stringify({
  type: 'user', message: { role: 'user', content: text },
});
const userToolResult = (toolUseId: string): string => JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
});
const assistantText = (text: string): string => JSON.stringify({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const assistantToolUse = (name: string, input: object): string => JSON.stringify({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, id: 'x', input }] },
});
const assistantThinking = (text: string): string => JSON.stringify({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] },
});

describe('subagent-log', () => {
  it('isAcompactAgent 命中文件名内的 acompact', () => {
    expect(isAcompactAgent('acompact-058d7808616eb3a9')).toBe(true);
    expect(isAcompactAgent('abc123')).toBe(false);
  });

  it('parseJsonlLine 半行（写入中）/损坏 JSON 返回 null', () => {
    expect(parseJsonlLine('{"type":"user"')).toBeNull();
    expect(parseJsonlLine('not json at all')).toBeNull();
  });

  it('首行 user 字符串 prompt → 「▸ 任务：<截断到 120 字符>」', () => {
    const line = userPrompt('重构用户模块'.repeat(30));   // 180 字符 > 120，触发截断
    expect(renderSubagentLine(parseJsonlLine(line))).toMatch(/^▸ 任务：/);
    expect(renderSubagentLine(parseJsonlLine(line))).toContain('…');
  });

  it('assistant 文本块原文输出', () => {
    const line = assistantText('最终报告第一段\n第二段');
    expect(renderSubagentLine(parseJsonlLine(line))).toBe('最终报告第一段\n第二段');
  });

  it('assistant tool_use → 「⚙ <工具名> <brief>」，brief 取 description/command/file_path', () => {
    expect(renderSubagentLine(parseJsonlLine(assistantToolUse('Read', { file_path: 'D:\\work\\a.ts' }))))
      .toMatch(/^⚙ Read D:\\work\\a\.ts$/);
    expect(renderSubagentLine(parseJsonlLine(assistantToolUse('Bash', { command: 'npm test' }))))
      .toMatch(/^⚙ Bash npm test$/);
    expect(renderSubagentLine(parseJsonlLine(assistantToolUse('Agent', { description: '调研依赖' }))))
      .toMatch(/^⚙ Agent 调研依赖$/);
    expect(renderSubagentLine(parseJsonlLine(assistantToolUse('Bash', {})))).toBe('⚙ Bash');   // 无 brief 退化
  });

  it('user tool_result 块跳过（噪音）；含 text 注入块也跳过', () => {
    expect(renderSubagentLine(parseJsonlLine(userToolResult('x')))).toBeNull();
    expect(renderSubagentLine(parseJsonlLine(JSON.stringify({
      type: 'user', message: { content: [{ type: 'text', text: 'system injected' }] },
    })))).toBeNull();
  });

  it('thinking / system / progress / attachment / fork-context-ref 跳过', () => {
    expect(renderSubagentLine(parseJsonlLine(assistantThinking('reasoning')))).toBeNull();
    expect(renderSubagentLine(parseJsonlLine(JSON.stringify({ type: 'system' })))).toBeNull();
    expect(renderSubagentLine(parseJsonlLine(JSON.stringify({ type: 'progress' })))).toBeNull();
    expect(renderSubagentLine(parseJsonlLine(JSON.stringify({ type: 'attachment' })))).toBeNull();
    expect(renderSubagentLine(parseJsonlLine(JSON.stringify({ type: 'fork-context-ref' })))).toBeNull();
  });

  it('未知 type 跳过', () => {
    expect(renderSubagentLine(parseJsonlLine(JSON.stringify({ type: 'future-event' })))).toBeNull();
  });

  it('renderSubagentLines 半行容错：损坏行跳过，不抛错', () => {
    const text = [
      userPrompt('任务描述'),
      'this is not json',
      assistantText('报告'),
    ].join('\n');
    expect(renderSubagentLines(text)).toBe('▸ 任务：任务描述\n报告');
  });

  it('extractTaskDescription 优先 user 首行 prompt 字符串；缺失则降级 fork 型 Agent tool_use', () => {
    const text = userPrompt('顶层任务');
    expect(extractTaskDescription(text)).toBe('顶层任务');
    const forkText = assistantToolUse('Agent', { prompt: 'fork 的 prompt', description: 'fork 描述' });
    expect(extractTaskDescription(forkText)).toBe('fork 描述');
    const forkTextNoDesc = assistantToolUse('Agent', { prompt: 'only prompt' });
    expect(extractTaskDescription(forkTextNoDesc)).toBe('only prompt');
    expect(extractTaskDescription(assistantToolUse('Read', { file_path: 'x' }))).toBeUndefined();
  });

  it('judgeAlive 末行为 user tool_result → running；末行 assistant text → 不重建', () => {
    expect(judgeAlive(userToolResult('x'))).toBe(true);
    expect(judgeAlive(assistantText('最终报告'))).toBe(false);
    expect(judgeAlive(assistantToolUse('Bash', { command: 'x' }))).toBe(true);   // tool_use 未闭合
    expect(judgeAlive(assistantThinking('思考中'))).toBe(true);                  // thinking 中
    expect(judgeAlive('')).toBe(false);                                          // 空壳不重建
    expect(judgeAlive('garbage\nnot json')).toBe(false);                          // 结构行不计
  });

  it('unseenPart 按累计偏移裁掉已写入部分', () => {
    expect(unseenPart('abc', 3, 3)).toBe('');        // 快照已含整块
    expect(unseenPart('abc', 3, 5)).toBe('');        // 快照比该块更新
    expect(unseenPart('cdef', 6, 4)).toBe('ef');     // 部分重叠：只写尾部
    expect(unseenPart('ghi', 9, 6)).toBe('ghi');     // 紧接着的新块
    expect(unseenPart('xyz', 20, 6)).toBe('xyz');    // 中间有缺口时也整块写入
  });
});