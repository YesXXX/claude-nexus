import { describe, it, expect } from 'vitest';
import {
  fenceFor, formatAnnotations, relPath, stripControls,
} from '../src/shared/annotation-format';
import type { Annotation, AnnotationCheck } from '../src/shared/review-types';

let seq = 0;
function ann(p: Partial<Annotation> & Pick<Annotation, 'path'>): Annotation {
  seq++;
  return {
    id: p.id ?? `a${seq}`, mode: 'working', refSha: 'abc1234def', side: 'new', start: 1, end: 1,
    lines: ['+x'], comment: '意见', status: 'pending', createdAt: seq, updatedAt: seq, ...p,
  };
}

const CTX = { repoRoot: 'D:/repo', cwd: 'D:/repo' };
const CLOSING = '（以上行号基于工作区当前文件；带「行号可能已变化」的条目请以引用片段为准）';
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

describe('formatAnnotations', () => {
  it('完整消息按字面量输出，按路径与行号排序', () => {
    const items = [
      ann({ id: 'b', path: 'src/b.ts', side: 'old', start: 7, end: 8, lines: ['-x', '-y'], comment: '为什么删' }),
      ann({ id: 'm', path: 'src/a.ts', start: 40, end: 42, lines: ['+a', '+b', '+c'], comment: '改名' }),
      ann({ id: 'a', path: 'src/a.ts', start: 11, end: 11, lines: ['-return x;', '+return x + 1;'], comment: '这里应该处理 x 为空的情况' }),
      ann({ id: 'n', path: 'note.md', side: 'file', start: 0, end: 0, lines: [], comment: '文档要写成中文' }),
    ];
    const checks: AnnotationCheck[] = [{ id: 'm', validity: 'moved', movedTo: 44 }];
    const r = formatAnnotations(items, checks, CTX);
    expect(r.text).toBe([
      '请根据以下代码审阅批注修改（共 4 条）：',
      '1. note.md（整个文件）\n意见：文档要写成中文',
      '2. src/a.ts:11\n```diff\n-return x;\n+return x + 1;\n```\n意见：这里应该处理 x 为空的情况',
      '3. src/a.ts:44-46（原为 40-42，行号已按当前文件修正）\n```diff\n+a\n+b\n+c\n```\n意见：改名',
      '4. src/b.ts 原第 7-8 行（已删除，基于 abc1234）\n```diff\n-x\n-y\n```\n意见：为什么删',
      CLOSING,
    ].join('\n\n'));
    expect(r.includedIds).toEqual(['n', 'a', 'm', 'b']);
    expect(r.omittedIds).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(r.stale).toBe(0);
  });

  it('同一文件里整个文件的批注排在行批注之前', () => {
    const r = formatAnnotations([
      ann({ id: 'l', path: 'a.ts', start: 1, end: 1 }),
      ann({ id: 'f', path: 'a.ts', side: 'file', start: 0, end: 0, lines: [] }),
    ], [], CTX);
    expect(r.includedIds).toEqual(['f', 'l']);
  });

  it('失效条目注明行号可能已变化并计数；文件已删除时写明', () => {
    const r = formatAnnotations([
      ann({ id: 's', path: 'a.ts', start: 3, end: 4, lines: ['+p', '+q'] }),
      ann({ id: 'g', path: 'gone.ts', start: 2, end: 2 }),
    ], [
      { id: 's', validity: 'stale', reason: '找不到原内容' },
      { id: 'g', validity: 'stale', reason: '文件已不存在' },
    ], CTX);
    expect(r.text).toContain('1. a.ts:3-4（行号可能已变化）');
    expect(r.text).toContain('2. gone.ts:2（文件已不存在，行号可能已变化）');
    expect(r.stale).toBe(2);
  });

  it('删除行在空仓库（无旧侧提交）时不写基于哪个提交', () => {
    const r = formatAnnotations([ann({ path: 'a.ts', side: 'old', start: 2, end: 2, refSha: '', lines: ['-z'] })], [], CTX);
    expect(r.text).toContain('1. a.ts 原第 2 行（已删除）');
  });

  it('路径相对会话 cwd，必要时带 ../', () => {
    const r = formatAnnotations([ann({ path: 'src/a.ts', start: 5, end: 5 })], [], { repoRoot: 'D:/repo', cwd: 'D:/repo/sub/x' });
    expect(r.text).toContain('1. ../../src/a.ts:5');
  });

  it('片段含三个反引号时围栏加长', () => {
    const r = formatAnnotations([ann({ path: 'a.md', lines: ['+```js', '+x'] })], [], CTX);
    expect(r.text).toContain('````diff\n+```js\n+x\n````');
  });

  it('清除意见与片段里的控制字符', () => {
    const r = formatAnnotations([
      ann({ path: 'a.ts', lines: ['+a\x1b[31mred\x07'], comment: '  修\x1b[0m改\r\n第二行\x00  ' }),
    ], [], CTX);
    expect(r.text).toContain('+a[31mred\n');
    expect(r.text).toContain('意见：修[0m改\n第二行');
    expect(r.text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  });

  it('片段超过 20 行折叠为前 10 行与后 5 行', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `+L${i + 1}`);
    const r = formatAnnotations([ann({ path: 'a.ts', start: 1, end: 30, lines })], [], CTX);
    const body = r.text.split('```diff\n')[1].split('\n```')[0].split('\n');
    expect(body).toEqual([...lines.slice(0, 10), '…省略 15 行…', ...lines.slice(25)]);
    expect(r.truncated).toBe(false);
  });

  it('超过上限先截短最长片段，仍超出再从末尾整条移出', () => {
    const long = (n: number, tag: string) => Array.from({ length: 18 }, (_, i) => `+${tag}${i}`.padEnd(n, '.'));
    const items = [
      ann({ id: 'x1', path: 'a1.ts', start: 1, end: 18, lines: long(200, 'a') }),
      ann({ id: 'x2', path: 'a2.ts', start: 1, end: 18, lines: long(100, 'b') }),
      ann({ id: 'x3', path: 'a3.ts', start: 1, end: 18, lines: long(100, 'c') }),
    ];
    const full = formatAnnotations(items, [], CTX);
    // 只截短最长的那个片段就能放下
    const max1 = bytes(full.text) - 3000;
    const r1 = formatAnnotations(items, [], { ...CTX, maxBytes: max1 });
    expect(bytes(r1.text)).toBeLessThanOrEqual(max1);
    expect(r1.truncated).toBe(true);
    expect(r1.omittedIds).toEqual([]);
    expect(r1.text).toContain('+a0'.padEnd(200, '.') + '\n+a1'.padEnd(201, '.') + '\n…省略 16 行…');
    expect(r1.text).toContain('+b17');

    // 全部截短仍放不下：移出末尾条目，并写明剩余条数
    const r2 = formatAnnotations(items, [], { ...CTX, maxBytes: 800 });
    expect(bytes(r2.text)).toBeLessThanOrEqual(800);
    expect(r2.includedIds.length).toBeGreaterThanOrEqual(1);
    expect(r2.omittedIds.length).toBe(3 - r2.includedIds.length);
    expect(r2.omittedIds).toContain('x3');
    expect(r2.text).toContain(`另有 ${r2.omittedIds.length} 条批注因长度限制未包含，请在面板中查看`);
    expect(r2.text.startsWith(`请根据以下代码审阅批注修改（共 ${r2.includedIds.length} 条）：`)).toBe(true);
  });

  it('默认上限 32KB', () => {
    const lines = Array.from({ length: 20 }, () => '+' + '中'.repeat(800));
    const items = Array.from({ length: 20 }, (_, i) => ann({ path: `f${String(i).padStart(2, '0')}.ts`, start: 1, end: 20, lines }));
    const r = formatAnnotations(items, [], CTX);
    expect(bytes(r.text)).toBeLessThanOrEqual(32 * 1024);
    expect(r.omittedIds.length).toBeGreaterThan(0);
  });
});

describe('辅助函数', () => {
  it('relPath：同目录、上跳、盘符大小写、跨盘', () => {
    expect(relPath('D:/repo', 'D:/repo', 'a/b.ts')).toBe('a/b.ts');
    expect(relPath('D:\\repo', 'D:\\repo\\a', 'a/b.ts')).toBe('b.ts');
    expect(relPath('D:/repo', 'D:/repo/x', 'a/b.ts')).toBe('../a/b.ts');
    expect(relPath('D:/Repo', 'd:/repo', 'a.ts')).toBe('a.ts');
    expect(relPath('D:/repo', 'E:/other', 'a.ts')).toBe('D:/repo/a.ts');
  });

  it('fenceFor：至少三个，比最长连续反引号多一个', () => {
    expect(fenceFor(['a', 'b'])).toBe('```');
    expect(fenceFor(['``', '`'])).toBe('```');
    expect(fenceFor(['`````'])).toBe('``````');
  });

  it('stripControls：保留 \\t 与 \\n，回车统一为 \\n', () => {
    expect(stripControls('a\tb\r\nc\rd\x1b\x7f')).toBe('a\tb\nc\nd');
  });
});
