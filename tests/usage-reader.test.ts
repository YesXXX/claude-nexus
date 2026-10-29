import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readIncrement } from '../src/main/usage-reader';
import { parseLine } from '../src/shared/usage-parse';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-reader-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readIncrement', () => {
  it('只消费到最后一个换行；CRLF 去掉回车；空行跳过', async () => {
    const f = path.join(dir, 'a.jsonl');
    fs.writeFileSync(f, 'one\r\n\ntwo\nthr');
    const lines: Array<[string, number]> = [];
    const r = await readIncrement(f, 0, { onLine: (l, end) => lines.push([l, end]) });
    expect(r).toEqual({ state: 'ok', offset: 10, size: 13 });
    expect(lines).toEqual([['one', 5], ['two', 10]]);
    fs.appendFileSync(f, 'ee\n');
    const more: string[] = [];
    const r2 = await readIncrement(f, 10, { onLine: l => more.push(l) });
    expect(more).toEqual(['three']);
    expect(r2).toMatchObject({ state: 'ok', offset: 16 });
  });

  it('不存在返回 missing；比 offset 短返回 truncated', async () => {
    expect(await readIncrement(path.join(dir, 'nope.jsonl'), 0, { onLine: () => undefined })).toEqual({ state: 'missing' });
    const f = path.join(dir, 'b.jsonl');
    fs.writeFileSync(f, 'x\n');
    expect(await readIncrement(f, 100, { onLine: () => undefined })).toEqual({ state: 'truncated', size: 2 });
  });

  it('多字节字符跨块不乱码', async () => {
    const f = path.join(dir, 'c.jsonl');
    const text = '用量与上下文'.repeat(100);
    fs.writeFileSync(f, `${text}\n`);
    const lines: string[] = [];
    await readIncrement(f, 0, { chunkSize: 7, onLine: l => lines.push(l) });
    expect(lines).toEqual([text]);
  });

  it('50MB 文件：每块处理耗时低于 50 毫秒', async () => {
    const f = path.join(dir, 'big.jsonl');
    const line = JSON.stringify({
      type: 'assistant', timestamp: '2026-10-17T02:00:00.000Z',
      message: { id: 'm', model: 'claude-opus-5', content: [{ type: 'text', text: 'y'.repeat(1500) }],
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 } },
    }) + '\n';
    const block = line.repeat(Math.ceil((4 * 1024 * 1024) / line.length));
    const fd = fs.openSync(f, 'w');
    let size = 0;
    while (size < 50 * 1024 * 1024) { fs.writeSync(fd, block); size += Buffer.byteLength(block); }
    fs.closeSync(fd);
    const timings: number[] = [];
    let parsed = 0;
    const r = await readIncrement(f, 0, {
      onLine: l => { if (parseLine(l)) parsed++; },
      onChunkTiming: ms => timings.push(ms),
    });
    expect(r).toMatchObject({ state: 'ok', offset: size });
    expect(parsed).toBe(size / Buffer.byteLength(line));
    expect(timings.length).toBeGreaterThanOrEqual(50);
    expect(Math.max(...timings)).toBeLessThan(50);
  }, 60_000);
});
