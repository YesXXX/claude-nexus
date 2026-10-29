import type { Annotation, AnnotationCheck } from './review-types';

/**
 * 把待发送的批注拼成一条发给 Claude 的消息。纯函数，主进程与测试共用；
 * 输出只含 \n 换行，写入终端前再由 pasteBlock 统一清洗与换行转换。
 */

/** 消息正文上限（UTF-8 字节） */
export const MAX_MESSAGE_BYTES = 32 * 1024;
/** 片段超过这个行数时折叠，只保留首尾 */
const FOLD_OVER = 20;
const FOLD_HEAD = 10;
const FOLD_TAIL = 5;
/** 超长时片段被截到的行数 */
const SHORT_LINES = 2;

export interface FormatContext {
  /** 仓库根（批注路径相对它） */
  repoRoot: string;
  /** 会话 cwd：消息里的路径相对它，Claude 能直接打开 */
  cwd: string;
  /** 正文上限，缺省 32KB */
  maxBytes?: number;
}

export interface FormatResult {
  text: string;
  /** 有片段被截短或有条目被移出 */
  truncated: boolean;
  /** 按消息顺序排列的已包含条目 */
  includedIds: string[];
  /** 因长度限制未包含的条目 */
  omittedIds: string[];
  /** 行号可能已变化的条数 */
  stale: number;
}

/** 去掉 \t、\n 以外的控制字符与 DEL，回车统一成 \n */
export function stripControls(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** 能包住这些行的代码围栏：比片段里最长的连续反引号多一个，至少三个 */
export function fenceFor(lines: string[]): string {
  let longest = 0;
  for (const l of lines) {
    for (const m of l.match(/`+/g) ?? []) longest = Math.max(longest, m.length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

function segments(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter(s => s && s !== '.');
}

/** 驱动器号等根段不区分大小写比较（Windows 路径） */
function sameSeg(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 仓库内路径换算成相对会话 cwd 的路径，必要时带 ../；cwd 与仓库不在同一个盘时返回绝对路径。
 * 只做字符串运算，不访问文件系统。
 */
export function relPath(repoRoot: string, cwd: string, p: string): string {
  const target = [...segments(repoRoot), ...segments(p)];
  const from = segments(cwd);
  if (!from.length || !target.length || !sameSeg(from[0], target[0])) return target.join('/');
  let i = 0;
  while (i < from.length && i < target.length && sameSeg(from[i], target[i])) i++;
  const up = from.slice(i).map(() => '..');
  return [...up, ...target.slice(i)].join('/') || '.';
}

function range(a: number, b: number): string {
  return a === b ? String(a) : `${a}-${b}`;
}

/** 条目标题：路径加行号，删除行、偏移、失效各有写法 */
function titleOf(a: Annotation, check: AnnotationCheck | undefined, shown: string): { title: string; stale: boolean } {
  if (a.side === 'file') return { title: `${shown}（整个文件）`, stale: false };
  if (a.side === 'old') {
    const base = a.refSha ? `，基于 ${a.refSha.slice(0, 7)}` : '';
    return { title: `${shown} 原第 ${range(a.start, a.end)} 行（已删除${base}）`, stale: false };
  }
  if (check?.validity === 'moved' && typeof check.movedTo === 'number') {
    const to = check.movedTo;
    const end = to + (a.end - a.start);
    return { title: `${shown}:${range(to, end)}（原为 ${range(a.start, a.end)}，行号已按当前文件修正）`, stale: false };
  }
  if (check?.validity === 'stale') {
    const why = check.reason === '文件已不存在' ? '文件已不存在，' : '';
    return { title: `${shown}:${range(a.start, a.end)}（${why}行号可能已变化）`, stale: true };
  }
  return { title: `${shown}:${range(a.start, a.end)}`, stale: false };
}

/** 片段折叠：超过 20 行保留前 10 行与后 5 行 */
function foldLines(lines: string[]): string[] {
  if (lines.length <= FOLD_OVER) return lines;
  const omitted = lines.length - FOLD_HEAD - FOLD_TAIL;
  return [...lines.slice(0, FOLD_HEAD), `…省略 ${omitted} 行…`, ...lines.slice(-FOLD_TAIL)];
}

function shortLines(lines: string[]): string[] {
  if (lines.length <= SHORT_LINES + 1) return lines;
  return [...lines.slice(0, SHORT_LINES), `…省略 ${lines.length - SHORT_LINES} 行…`];
}

interface Entry {
  a: Annotation;
  title: string;
  stale: boolean;
  snippet: string[];
  short: boolean;
}

function entryText(n: number, e: Entry): string {
  const out = [`${n}. ${e.title}`];
  if (e.snippet.length) {
    const fence = fenceFor(e.snippet);
    out.push(`${fence}diff`, ...e.snippet, fence);
  }
  out.push(`意见：${stripControls(e.a.comment).trim()}`);
  return out.join('\n');
}

const CLOSING = '（以上行号基于工作区当前文件；带「行号可能已变化」的条目请以引用片段为准）';

function build(entries: Entry[], omitted: number): string {
  const parts = [`请根据以下代码审阅批注修改（共 ${entries.length} 条）：`];
  entries.forEach((e, i) => parts.push(entryText(i + 1, e)));
  parts.push(CLOSING);
  if (omitted > 0) parts.push(`另有 ${omitted} 条批注因长度限制未包含，请在面板中查看`);
  return parts.join('\n\n');
}

const encoder = new TextEncoder();
const bytes = (s: string): number => encoder.encode(s).length;

/** 排序：按路径，再按起始行；整个文件的批注排在该文件最前 */
function compare(x: Annotation, y: Annotation): number {
  if (x.path !== y.path) return x.path < y.path ? -1 : 1;
  const sx = x.side === 'file' ? -1 : x.start;
  const sy = y.side === 'file' ? -1 : y.start;
  return sx !== sy ? sx - sy : x.createdAt - y.createdAt;
}

/**
 * 拼消息。超过上限时先从最长的片段开始截短，仍超出就从末尾整条移出，
 * 移出的条目在 omittedIds 里返回，调用方应让它们保持待发送。至少保留一条。
 */
export function formatAnnotations(items: Annotation[], checks: AnnotationCheck[], ctx: FormatContext): FormatResult {
  const max = ctx.maxBytes ?? MAX_MESSAGE_BYTES;
  const byId = new Map(checks.map(c => [c.id, c]));
  const entries: Entry[] = [...items].sort(compare).map(a => {
    const shown = relPath(ctx.repoRoot, ctx.cwd, a.path);
    const t = titleOf(a, byId.get(a.id), shown);
    const snippet = a.side === 'file' ? [] : foldLines(a.lines.map(stripControls).map(l => l.replace(/\n/g, ' ')));
    return { a, title: t.title, stale: t.stale, snippet, short: false };
  });
  let truncated = false;
  let text = build(entries, 0);
  while (bytes(text) > max) {
    const longest = entries
      .filter(e => !e.short && e.snippet.length > SHORT_LINES + 1)
      .sort((x, y) => bytes(y.snippet.join('\n')) - bytes(x.snippet.join('\n')))[0];
    if (!longest) break;
    longest.snippet = shortLines(longest.snippet);
    longest.short = true;
    truncated = true;
    text = build(entries, 0);
  }
  const omitted: Entry[] = [];
  while (bytes(text) > max && entries.length > 1) {
    omitted.unshift(entries.pop()!);
    truncated = true;
    text = build(entries, omitted.length);
  }
  return {
    text,
    truncated,
    includedIds: entries.map(e => e.a.id),
    omittedIds: omitted.map(e => e.a.id),
    stale: entries.filter(e => e.stale).length,
  };
}
