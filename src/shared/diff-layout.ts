import type { DiffHunk, DiffLine } from './types';

/**
 * 分栏视图的行序列：上下文行左右同一行；一段连续删除与紧随的连续新增按序号配对，
 * 多出的一侧留空白占位；「\ No newline」元信息行归属紧挨着的上一行所在的一侧。
 */

/** 单元格：分块内行下标与行本身；null 为空白占位 */
export type SplitCell = { line: DiffLine; index: number } | null;
export type SplitRow =
  | { kind: 'hunk'; header: string; hunk: number }
  | { kind: 'line'; hunk: number; left: SplitCell; right: SplitCell };

/** 显示用的行文本：去掉 CRLF 文件残留的行尾 \r，分词与绘制都以它为准 */
export function lineText(l: DiffLine): string {
  return l.text.endsWith('\r') ? l.text.slice(0, -1) : l.text;
}

export function buildSplitRows(hunks: DiffHunk[]): SplitRow[] {
  const rows: SplitRow[] = [];
  hunks.forEach((h, hi) => {
    rows.push({ kind: 'hunk', header: h.header, hunk: hi });
    const lines = h.lines;
    let i = 0;
    let prevKind: DiffLine['kind'] | undefined;
    while (i < lines.length) {
      const l = lines[i];
      if (l.kind === 'ctx') {
        rows.push({ kind: 'line', hunk: hi, left: { line: l, index: i }, right: { line: l, index: i } });
        prevKind = 'ctx';
        i++;
        continue;
      }
      if (l.kind === 'meta') {
        // 不在删增段内的元信息行：跟随上一行所在的一侧，上一行是上下文时两侧都显示
        const cell = { line: l, index: i };
        rows.push({
          kind: 'line', hunk: hi,
          left: prevKind === 'add' ? null : cell,
          right: prevKind === 'del' ? null : cell,
        });
        i++;
        continue;
      }
      const dels: NonNullable<SplitCell>[] = [];
      const adds: NonNullable<SplitCell>[] = [];
      while (i < lines.length && (lines[i].kind === 'del' || (lines[i].kind === 'meta' && dels.length > 0 && adds.length === 0))) {
        dels.push({ line: lines[i], index: i });
        i++;
      }
      while (i < lines.length && (lines[i].kind === 'add' || (lines[i].kind === 'meta' && adds.length > 0))) {
        adds.push({ line: lines[i], index: i });
        i++;
      }
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) rows.push({ kind: 'line', hunk: hi, left: dels[k] ?? null, right: adds[k] ?? null });
      prevKind = adds.length ? 'add' : 'del';
    }
  });
  return rows;
}
