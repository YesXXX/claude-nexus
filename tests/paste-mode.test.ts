import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pasteBlock, sanitizeForPaste, scanPasteMode, PASTE_END, PASTE_START } from '../src/shared/paste-mode';
import { ptyTraceFile, traceLine, traceWrites } from '../src/main/pty-trace';

const ON = '\x1b[?2004h';
const OFF = '\x1b[?2004l';

/** 依次扫描多个数据块，返回每块之后的模式（未出现序列的块沿用上一块） */
function scanAll(chunks: string[]): Array<boolean | undefined> {
  let tail = '';
  let mode: boolean | undefined;
  return chunks.map(c => {
    const r = scanPasteMode(tail, c);
    tail = r.tail;
    if (r.mode !== undefined) mode = r.mode;
    return mode;
  });
}

describe('scanPasteMode', () => {
  it('无序列时不给出模式', () => {
    expect(scanPasteMode('', 'hello world').mode).toBeUndefined();
    expect(scanAll(['a', 'b', '\x1b[?25h'])).toEqual([undefined, undefined, undefined]);
  });

  it('序列被切在两个数据块之间也能识别（任意切分位置）', () => {
    const text = `xx${ON}yy`;
    for (let cut = 1; cut < text.length; cut++) {
      expect(scanAll([text.slice(0, cut), text.slice(cut)])[1], `cut=${cut}`).toBe(true);
    }
    // 三段切分
    expect(scanAll(['\x1b[', '?20', '04h'])).toEqual([undefined, undefined, true]);
  });

  it('h / l 交替：以同一块里最后出现的为准', () => {
    expect(scanPasteMode('', `${ON}abc${OFF}`).mode).toBe(false);
    expect(scanPasteMode('', `${OFF}abc${ON}`).mode).toBe(true);
    expect(scanAll([ON, 'x', OFF, 'y', ON])).toEqual([true, true, false, false, true]);
  });

  it('尾巴不超过 7 个字符，不会把上一块已识别的序列重复计入', () => {
    const r = scanPasteMode('', `${ON}0123456789`);
    expect(r.tail).toBe('3456789');
    expect(scanPasteMode(r.tail, 'x').mode).toBeUndefined();
  });
});

describe('sanitizeForPaste / pasteBlock', () => {
  it('换行统一成 \\r，去掉除 \\t 与换行以外的控制字符和 DEL', () => {
    expect(sanitizeForPaste('a\r\nb\rc\nd')).toBe('a\rb\rc\rd');
    expect(sanitizeForPaste('x\ty\x07z\x7f')).toBe('x\tyz');
    // 正文里的结束标记失去 ESC 后不再能提前结束粘贴
    expect(sanitizeForPaste(`a${PASTE_END}b`)).toBe('a[201~b');
  });

  it('粘贴块 = 开始标记 + 清洗后的正文 + 结束标记，不含回车提交', () => {
    const block = pasteBlock('第一行\n第二行\x1b[31m');
    expect(block).toBe(`${PASTE_START}第一行\r第二行[31m${PASTE_END}`);
    expect(block.endsWith('\r')).toBe(false);
  });
});

describe('pty-trace', () => {
  it('只在隔离实例且设置了追踪文件时开启', () => {
    expect(ptyTraceFile({})).toBeUndefined();
    expect(ptyTraceFile({ CLAUDE_PANEL_PTY_TRACE: 'C:\\t.jsonl' })).toBeUndefined();
    expect(ptyTraceFile({ CLAUDE_PANEL_PTY_TRACE: ' ', CLAUDE_PANEL_HOME: 'C:\\h' })).toBeUndefined();
    expect(ptyTraceFile({ CLAUDE_PANEL_PTY_TRACE: 'C:\\t.jsonl', CLAUDE_PANEL_HOME: 'C:\\h' })).toBe('C:\\t.jsonl');
  });

  it('每次写入先追加一行 JSON 再写入，未开启时原样返回写入函数', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-trace-'));
    const file = path.join(dir, 'trace.jsonl');
    const written: string[] = [];
    const raw = (d: string) => { written.push(d); };
    expect(traceWrites('s1', raw, {})).toBe(raw);
    const traced = traceWrites('s1', raw, { CLAUDE_PANEL_PTY_TRACE: file, CLAUDE_PANEL_HOME: dir });
    traced(`${PASTE_START}a\rb${PASTE_END}`);
    traced('\r');
    expect(written).toEqual([`${PASTE_START}a\rb${PASTE_END}`, '\r']);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { t: number; id: string; data: string });
    expect(lines.map(l => [l.id, l.data])).toEqual([['s1', `${PASTE_START}a\rb${PASTE_END}`], ['s1', '\r']]);
    expect(traceLine('x', 'y', 5)).toBe('{"t":5,"id":"x","data":"y"}\n');
  });
});
