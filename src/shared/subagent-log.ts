/**
 * 子代理 transcript（jsonl）→ 可读文本流的纯函数集。
 * 不碰 fs / 定时器，全部可注入可单测；主进程 SubagentTracker 消费。
 *
 * 实测 jsonl 行结构（~/.claude/projects/<proj>/<sessionId>/subagents/agent-*.jsonl）：
 * - {"type":"user","message":{"content":"<任务 prompt 字符串>"}}          首行任务
 * - {"type":"user","message":{"content":[{type:"tool_result"...}]}}      工具结果（跳过）
 * - {"type":"assistant","message":{"content":[{type:"text"|"thinking"|"tool_use"}]}}
 * - {"type":"fork-context-ref"|"attachment"|"system"|"progress"}          结构行（跳过）
 * fork 型子代理无 user 首行：任务 prompt 在首条 assistant 的 Agent tool_use input.prompt 里。
 */

export const TASK_PROMPT_MAX = 120;
export const TOOL_BRIEF_MAX = 80;

/** acompact 内部压缩代理（文件名 agent-acompact-<hex>.jsonl）：不建条目不展示 */
export function isAcompactAgent(agentId: string): boolean {
  return agentId.includes('acompact');
}

/** 单行 JSON 安全解析：半行（写入中）/损坏行返回 null，由调用方回退偏移下轮重读 */
export function parseJsonlLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: { description?: string; command?: string; file_path?: string; [k: string]: unknown };
}

interface JsonlLine {
  type?: string;
  message?: { role?: string; content?: string | ContentBlock[] };
}

/** 截断到 max 字符（按 JS 字符计），超长补省略号 */
function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max) + '…';
}

/** tool_use 的单行摘要：description / command / file_path 取先命中者，前 80 字符 */
function toolBrief(name: string, input: ContentBlock['input']): string {
  const raw = input?.description ?? input?.command ?? input?.file_path;
  const brief = typeof raw === 'string' && raw.trim() ? truncate(raw, TOOL_BRIEF_MAX) : '';
  return brief ? `⚙ ${name} ${brief}` : `⚙ ${name}`;
}

/**
 * 解析后的 jsonl 行 → 渲染文本（不带换行）；该行不产生输出（tool_result/thinking/结构行）返回 null。
 */
export function renderSubagentLine(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const line = parsed as JsonlLine;

  if (line.type === 'user') {
    const content = line.message?.content;
    if (typeof content === 'string' && content.trim()) {
      return `▸ 任务：${truncate(content, TASK_PROMPT_MAX)}`;
    }
    return null;   // tool_result / 注入 text 块：体积大噪音多，跳过
  }

  if (line.type === 'assistant') {
    const content = line.message?.content;
    if (!Array.isArray(content)) return null;
    const out: string[] = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push(block.text);                       // 助手文本：原文输出
      } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
        out.push(toolBrief(block.name, block.input));
      }
      // thinking 块：内部推理，不渲染
    }
    return out.length > 0 ? out.join('\n') : null;
  }

  return null;   // fork-context-ref / attachment / system / progress / 未知行
}

/** 完整 jsonl 文本 → 渲染文本流（逐行，坏行跳过）。reconstruct 回放与单测用。 */
export function renderSubagentLines(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const rendered = renderSubagentLine(parseJsonlLine(line));
    if (rendered !== null) out.push(rendered);
  }
  return out.join('\n');
}

/** 任务短标题降级提取：首个 user 字符串行，或 fork 型首条 Agent tool_use 的 input.prompt */
export function extractTaskDescription(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseJsonlLine(line);
    if (typeof parsed !== 'object' || parsed === null) continue;
    const l = parsed as JsonlLine;
    const content = l.message?.content;
    if (l.type === 'user' && typeof content === 'string' && content.trim()) {
      return truncate(content, TASK_PROMPT_MAX);
    }
    if (l.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name === 'Agent') {
          const prompt = block.input?.prompt;
          const desc = block.input?.description;
          const hit = typeof desc === 'string' && desc.trim() ? desc
            : typeof prompt === 'string' && prompt.trim() ? prompt : undefined;
          if (hit) return truncate(hit, TASK_PROMPT_MAX);
        }
      }
    }
  }
  return undefined;
}

/**
 * 末段活性判定（重启重建用）：
 * 自末向前找最后一条"有意义"行（跳过 attachment/system/progress/fork-context-ref），
 * 它是 assistant 且末块为 text（闭合的最终报告）→ 已完成不重建；否则（tool_use 未闭合 /
 * thinking 中 / tool_result 待回复 / 无有意义行）→ 视为 running。
 * 注意"无有意义行"也返回 false：空壳 transcript 不重建。
 */
export function judgeAlive(text: string): boolean {
  const lines = text.split('\n').filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseJsonlLine(lines[i]);
    if (typeof parsed !== 'object' || parsed === null) continue;
    const l = parsed as JsonlLine;
    if (l.type !== 'assistant' && l.type !== 'user') continue;   // 结构行不算数
    if (l.type === 'user') return true;                          // tool_result 已回、等 assistant 接话
    const content = l.message?.content;
    if (!Array.isArray(content) || content.length === 0) continue;
    const last = content[content.length - 1];
    if (last?.type === 'text') return false;                     // 闭合的最终报告
    return true;                                                 // tool_use / thinking 未闭合
  }
  return false;
}

/**
 * 子代理增量去重：回放快照与实时增量可能重叠（快照生成前已推送的块也包含在快照里），
 * 按累计偏移裁掉已写过的部分。
 * received = 终端已写入的累计字符数；end = 该块追加后主进程缓冲的累计字符数。
 * 返回仍需写入的尾部，整块都已写过时返回空串。
 */
export function unseenPart(chunk: string, end: number, received: number): string {
  if (end <= received) return '';
  const start = end - chunk.length;
  return start < received ? chunk.slice(received - start) : chunk;
}
