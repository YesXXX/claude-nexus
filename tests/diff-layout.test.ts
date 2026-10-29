import { describe, expect, it } from 'vitest';
import { buildSplitRows, lineText, type SplitRow } from '../src/shared/diff-layout';
import type { DiffHunk, DiffLine } from '../src/shared/types';

/** 把分栏行转成 [左, 右] 文本，空白占位记为 '·'，分块标题记为 '@' + 标题 */
function shape(rows: SplitRow[]): string[] {
  return rows.map(r => (r.kind === 'hunk' ? `@${r.header}` : `${r.left?.line.text ?? '·'}|${r.right?.line.text ?? '·'}`));
}

const L = (kind: DiffLine['kind'], text: string): DiffLine => ({ kind, text });

describe('buildSplitRows 分栏行序列', () => {
  it('上下文两侧对齐，删增按序配对，多出的一侧留空白占位', () => {
    const hunks: DiffHunk[] = [{
      header: '@@ -1,5 +1,4 @@',
      lines: [L('ctx', 'c1'), L('del', 'd1'), L('del', 'd2'), L('del', 'd3'), L('add', 'a1'), L('ctx', 'c2'),
        L('add', 'a2'), L('add', 'a3'), L('del', 'd4')],
    }];
    expect(shape(buildSplitRows(hunks))).toEqual([
      '@@@ -1,5 +1,4 @@', 'c1|c1', 'd1|a1', 'd2|·', 'd3|·', 'c2|c2', '·|a2', '·|a3', 'd4|·',
    ]);
  });

  it('单元格带分块内行下标与分块序号', () => {
    const rows = buildSplitRows([
      { header: 'h0', lines: [L('ctx', 'x')] },
      { header: 'h1', lines: [L('del', 'o'), L('add', 'n')] },
    ]);
    const r = rows[3];
    expect(r).toMatchObject({ kind: 'line', hunk: 1, left: { index: 0 }, right: { index: 1 } });
    expect(rows[2]).toEqual({ kind: 'hunk', header: 'h1', hunk: 1 });
  });

  it('元信息行归属上一行所在的一侧', () => {
    const meta = L('meta', 'No newline at end of file');
    expect(shape(buildSplitRows([{ header: 'h', lines: [L('del', 'd'), meta, L('add', 'a'), meta] }]))).toEqual([
      '@h', 'd|a', `${meta.text}|${meta.text}`,
    ]);
    expect(shape(buildSplitRows([{ header: 'h', lines: [L('del', 'd'), meta, L('add', 'a')] }]))).toEqual([
      '@h', 'd|a', `${meta.text}|·`,
    ]);
    expect(shape(buildSplitRows([{ header: 'h', lines: [L('add', 'a'), meta] }]))).toEqual([
      '@h', '·|a', `·|${meta.text}`,
    ]);
    expect(shape(buildSplitRows([{ header: 'h', lines: [L('ctx', 'c'), meta] }]))).toEqual([
      '@h', 'c|c', `${meta.text}|${meta.text}`,
    ]);
  });

  it('分块标题各占一行，空分块列表返回空', () => {
    expect(buildSplitRows([])).toEqual([]);
    const rows = buildSplitRows([{ header: 'a', lines: [] }, { header: 'b', lines: [L('ctx', 'x')] }]);
    expect(shape(rows)).toEqual(['@a', '@b', 'x|x']);
  });

  it('lineText 去掉行尾回车', () => {
    expect(lineText(L('ctx', 'abc\r'))).toBe('abc');
    expect(lineText(L('ctx', 'a\rb'))).toBe('a\rb');
  });
});
