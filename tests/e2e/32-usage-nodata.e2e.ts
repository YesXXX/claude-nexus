import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { useApp } from './harness';
import { createSessionViaForm, mkWorkDir, rowSel, runTurn } from './fixtures';

/**
 * 上下文的异常与边界：mock 不写对话记录时显示无数据；根目录之外的 transcript 路径被忽略；
 * 首次接入约 50MB 的对话记录时界面仍可操作，读到最后一行后上下文取最后一条记录。
 */

const app = useApp({ env: { CLAUDE_PANEL_TRANSCRIPT_ROOT: '{claude}/projects', CLAUDE_PANEL_MOCK_NO_TRANSCRIPT: '1' } });

interface Usage { state: string; reason?: string; context?: { used: number } }

async function usageOf(id: string): Promise<Usage | undefined> {
  return (await app.session(id))?.usage as Usage | undefined;
}

/** 写一份带用量的 assistant 记录，每行独立 message.id，input 与 output 各 n 个 token；最后一行的 input 为 lastInput */
function writeTranscript(file: string, lines: number, n: number, lastInput = n): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  try {
    const now = new Date().toISOString();
    const pad = 'x'.repeat(200);
    let buf: string[] = [];
    for (let i = 0; i < lines; i++) {
      buf.push(JSON.stringify({
        type: 'assistant', uuid: randomUUID(), sessionId: 'big', timestamp: now,
        message: {
          id: `msg_big_${i}`, type: 'message', role: 'assistant', model: 'claude-opus-5',
          content: [{ type: 'text', text: pad }],
          usage: { input_tokens: i === lines - 1 ? lastInput : n, output_tokens: n, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }));
      if (buf.length >= 5000) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = []; }
    }
    if (buf.length > 0) fs.writeSync(fd, buf.join('\n') + '\n');
  } finally {
    fs.closeSync(fd);
  }
}

describe('上下文的无数据与边界', () => {
  it('没有对话记录时属性面板不显示上下文节，原因只在日志里记一次', async () => {
    const id = await createSessionViaForm(app, 'nodata', mkWorkDir(app, 'nodata'));
    await runTurn(app, id, 'hello');
    await app.until(async () => (await usageOf(id))?.state === 'no_data', { message: '会话标为无数据' });
    expect((await usageOf(id))?.reason).toContain('transcript 文件不存在');
    await app.waitVisible('#inspector .status-sec');
    expect(await app.exists('.usage-sec')).toBe(false);

    await runTurn(app, id, 'again');
    await new Promise(r => setTimeout(r, 800));
    const lines = app.logs().split('\n').filter(l => l.includes(`会话 ${id.slice(0, 8)} 无用量数据`));
    expect(lines.length).toBe(1);
    expect(await app.exists('.modal-backdrop:not([hidden])')).toBe(false);
  });

  it('transcript 根目录之外的路径被忽略，不统计', async () => {
    const id = await createSessionViaForm(app, 'outside', mkWorkDir(app, 'outside'));
    const file = path.join(app.work, 'outside-root', `${randomUUID()}.jsonl`);
    writeTranscript(file, 10, 1000);
    expect(await app.postHook(id, { hook_event_name: 'Stop', transcript_path: file })).toBe(200);
    await app.until(() => app.logs().includes(`忽略 transcript 根目录之外的路径：${file}`), { message: '日志记录忽略根目录之外的路径' });
    await new Promise(r => setTimeout(r, 800));
    const u = await usageOf(id);
    expect(u?.context).toBeUndefined();
    expect(u?.state).not.toBe('ok');
  });

  it('首次接入约 50MB 的对话记录时界面仍可操作，读完后上下文取最后一条', async () => {
    const lines = 95_000;
    const last = 123_456;
    const file = path.join(app.claude, 'projects', 'big-proj', `${randomUUID()}.jsonl`);
    writeTranscript(file, lines, 10, last);
    const size = fs.statSync(file).size;
    expect(size).toBeGreaterThan(45 * 1024 * 1024);

    const other = await createSessionViaForm(app, 'big-other', mkWorkDir(app, 'big-other'));
    const id = await createSessionViaForm(app, 'big', mkWorkDir(app, 'big'));
    // mock 的 SessionStart 也带着自己的（不存在的）对话记录路径：等它先到，再让大文件成为当前主文件
    await app.until(async () => !!(await app.session(id))?.claudeTranscriptPath, { message: 'mock 的 SessionStart 已处理' });
    const started = Date.now();
    expect(await app.postHook(id, { hook_event_name: 'Stop', transcript_path: file })).toBe(200);

    // 读取期间反复切换会话、开关命令面板，记录每次往返主进程的最长耗时
    let worst = 0;
    let rounds = 0;
    let done = false;
    while (!done && Date.now() - started < 60_000) {
      const t0 = Date.now();
      const u = await usageOf(id);
      worst = Math.max(worst, Date.now() - t0);
      if (u?.state === 'ok' && u.context?.used === last) { done = true; break; }
      await app.click(rowSel(rounds % 2 === 0 ? other : id));
      if (rounds % 5 === 0) {
        await app.blur();
        await app.press('Control+K');
        await app.waitVisible('#palette-backdrop', 3000);
        await app.press('Escape');
        await app.waitHidden('#palette-backdrop', 3000);
      }
      rounds++;
    }
    const elapsed = Date.now() - started;
    console.log(`[e2e] 50MB 读取：${(size / 1024 / 1024).toFixed(1)}MB，耗时 ${elapsed}ms，交互 ${rounds} 轮，list() 最长往返 ${worst}ms`);
    expect(done).toBe(true);
    expect(worst).toBeLessThan(1000);
  });
});
