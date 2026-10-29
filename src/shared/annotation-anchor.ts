import type { DiffHunk } from './types';
import type { Annotation, AnnotationCheck, AnnotationSide } from './review-types';

/**
 * 批注锚点：从 diff 分块截取选中范围，以及文件变化后按内容校验锚点。纯函数，不访问文件系统。
 */

/** 单条批注最多引用的行数 */
export const MAX_ANNOTATION_LINES = 200;

export interface HunkRange {
  side: Exclude<AnnotationSide, 'file'>;
  start: number;
  end: number;
  /** diff 原样行，含 '+' / '-' / ' ' 前缀 */
  lines: string[];
}

const PREFIX = { add: '+', del: '-', ctx: ' ' } as const;

/**
 * 按分块内行序号（从 0 起，含首尾，顺序不限）截取范围。
 * 范围里有新增或上下文行时锚在新文件侧，行号取这些行的新行号；只有删除行时锚在旧文件侧。
 * meta 行（如「\ No newline at end of file」）不计入。
 */
export function rangeFromHunk(hunk: DiffHunk, from: number, to: number): HunkRange | { error: string } {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return { error: '行范围无效' };
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  if (a < 0 || b >= hunk.lines.length) return { error: '行范围超出分块' };
  const picked = hunk.lines.slice(a, b + 1).filter(l => l.kind !== 'meta');
  if (!picked.length) return { error: '所选行不能添加批注' };
  if (picked.length > MAX_ANNOTATION_LINES) return { error: `一条批注最多引用 ${MAX_ANNOTATION_LINES} 行` };
  const lines = picked.map(l => `${PREFIX[l.kind as keyof typeof PREFIX]}${l.text}`);
  const newNos = picked.filter(l => l.kind !== 'del' && typeof l.newNo === 'number').map(l => l.newNo!);
  if (newNos.length) return { side: 'new', start: Math.min(...newNos), end: Math.max(...newNos), lines };
  const oldNos = picked.filter(l => typeof l.oldNo === 'number').map(l => l.oldNo!);
  if (!oldNos.length) return { error: '所选行没有行号' };
  return { side: 'old', start: Math.min(...oldNos), end: Math.max(...oldNos), lines };
}

const noCR = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s);

/** 新文件侧应当出现的内容：去掉删除行，再去掉前缀 */
export function expectedNewLines(lines: string[]): string[] {
  return lines.filter(l => !l.startsWith('-')).map(l => noCR(l.slice(1)));
}

/**
 * 校验锚点。fileLines 为工作区当前文件按行拆开的内容，文件不存在时传 null。
 * 新文件侧：原行号处内容一致为有效；否则全文查找这段连续行，唯一命中为偏移，零次或多次为失效。
 * 旧文件侧与整个文件的批注不随工作区变化，总是有效。
 */
export function checkAnchor(fileLines: string[] | null, ann: Pick<Annotation, 'id' | 'side' | 'start' | 'lines'>): AnnotationCheck {
  if (ann.side !== 'new') return { id: ann.id, validity: 'valid' };
  if (!fileLines) return { id: ann.id, validity: 'stale', reason: '文件已不存在' };
  const want = expectedNewLines(ann.lines);
  if (!want.length) return { id: ann.id, validity: 'valid' };
  const have = fileLines.map(noCR);
  const matchAt = (i: number): boolean => {
    if (i < 0 || i + want.length > have.length) return false;
    for (let k = 0; k < want.length; k++) if (have[i + k] !== want[k]) return false;
    return true;
  };
  if (matchAt(ann.start - 1)) return { id: ann.id, validity: 'valid' };
  const hits: number[] = [];
  for (let i = 0; i + want.length <= have.length && hits.length < 2; i++) {
    if (matchAt(i)) hits.push(i);
  }
  if (hits.length === 1) return { id: ann.id, validity: 'moved', movedTo: hits[0] + 1 };
  return { id: ann.id, validity: 'stale', reason: hits.length ? '原内容在文件中出现多处' : '找不到原内容' };
}

/** 文件文本拆行：末尾换行不产生多余的空行 */
export function splitFileLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
