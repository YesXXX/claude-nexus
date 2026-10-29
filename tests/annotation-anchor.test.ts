import { describe, it, expect } from 'vitest';
import { checkAnchor, MAX_ANNOTATION_LINES, rangeFromHunk, splitFileLines } from '../src/shared/annotation-anchor';
import type { DiffHunk } from '../src/shared/types';

/** 旧 10-13 行 → 新 10-13 行：上下文、删除两行、新增一行、上下文、meta */
const HUNK: DiffHunk = {
  header: '@@ -10,4 +10,3 @@',
  lines: [
    { kind: 'ctx', oldNo: 10, newNo: 10, text: 'a' },
    { kind: 'del', oldNo: 11, text: 'b' },
    { kind: 'del', oldNo: 12, text: 'c' },
    { kind: 'add', newNo: 11, text: 'C' },
    { kind: 'ctx', oldNo: 13, newNo: 12, text: 'd' },
    { kind: 'meta', text: '\\ No newline at end of file' },
  ],
};

describe('rangeFromHunk', () => {
  it('只选删除行：锚在旧文件侧', () => {
    expect(rangeFromHunk(HUNK, 1, 2)).toEqual({ side: 'old', start: 11, end: 12, lines: ['-b', '-c'] });
  });

  it('混合选择：锚在新文件侧，顺序不限', () => {
    expect(rangeFromHunk(HUNK, 4, 1)).toEqual({ side: 'new', start: 11, end: 12, lines: ['-b', '-c', '+C', ' d'] });
    expect(rangeFromHunk(HUNK, 0, 0)).toEqual({ side: 'new', start: 10, end: 10, lines: [' a'] });
  });

  it('跳过 meta 行；只选 meta 行报错', () => {
    expect(rangeFromHunk(HUNK, 4, 5)).toEqual({ side: 'new', start: 12, end: 12, lines: [' d'] });
    expect(rangeFromHunk(HUNK, 5, 5)).toEqual({ error: '所选行不能添加批注' });
  });

  it('越界与非法参数', () => {
    expect(rangeFromHunk(HUNK, 0, 6)).toEqual({ error: '行范围超出分块' });
    expect(rangeFromHunk(HUNK, -1, 2)).toEqual({ error: '行范围超出分块' });
    expect(rangeFromHunk(HUNK, 0.5, 2)).toEqual({ error: '行范围无效' });
    expect(rangeFromHunk(HUNK, Number.NaN, 2)).toEqual({ error: '行范围无效' });
  });

  it('超过行数上限', () => {
    const big: DiffHunk = {
      header: '@@', lines: Array.from({ length: MAX_ANNOTATION_LINES + 1 }, (_, i) => ({ kind: 'add' as const, newNo: i + 1, text: 'x' })),
    };
    expect(rangeFromHunk(big, 0, MAX_ANNOTATION_LINES)).toEqual({ error: `一条批注最多引用 ${MAX_ANNOTATION_LINES} 行` });
    expect(rangeFromHunk(big, 0, MAX_ANNOTATION_LINES - 1)).toMatchObject({ side: 'new', start: 1, end: MAX_ANNOTATION_LINES });
  });
});

describe('checkAnchor', () => {
  const ann = { id: 'x', side: 'new' as const, start: 3, lines: ['-old', '+B', ' C'] };

  it('原行号处内容一致为有效（忽略行尾 \\r）', () => {
    expect(checkAnchor(['a', 'b', 'B\r', 'C'], ann)).toEqual({ id: 'x', validity: 'valid' });
  });

  it('整体移位且唯一命中为偏移，给出新行号', () => {
    expect(checkAnchor(['n', 'n', 'n', 'a', 'b', 'B', 'C'], ann)).toEqual({ id: 'x', validity: 'moved', movedTo: 6 });
  });

  it('找不到或多处命中为失效', () => {
    expect(checkAnchor(['a', 'b', 'X', 'C'], ann)).toEqual({ id: 'x', validity: 'stale', reason: '找不到原内容' });
    expect(checkAnchor(['B', 'C', 'z', 'z', 'B', 'C'], ann)).toEqual({ id: 'x', validity: 'stale', reason: '原内容在文件中出现多处' });
  });

  it('文件已删除为失效', () => {
    expect(checkAnchor(null, ann)).toEqual({ id: 'x', validity: 'stale', reason: '文件已不存在' });
  });

  it('旧文件侧与整个文件总是有效', () => {
    expect(checkAnchor(null, { ...ann, side: 'old' })).toEqual({ id: 'x', validity: 'valid' });
    expect(checkAnchor([], { ...ann, side: 'file' })).toEqual({ id: 'x', validity: 'valid' });
  });

  it('splitFileLines：末尾换行不产生空行', () => {
    expect(splitFileLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitFileLines('a\r\nb')).toEqual(['a\r', 'b']);
    expect(splitFileLines('')).toEqual([]);
  });
});
