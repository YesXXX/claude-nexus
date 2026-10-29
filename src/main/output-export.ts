import * as fs from 'fs';
import * as path from 'path';
import { Terminal } from '@xterm/headless';
import { stripAnsi } from '../shared/ansi-text';
import type { ExportFormat, ExportResult } from '../shared/types';

/**
 * 终端输出导出。原始流里有光标移动、擦除行等控制序列，Claude 的界面会反复重绘动态区，
 * 直接去控制符会留下大量重复残行，所以默认格式在主进程用无界面终端把原始流重放一遍再取文本。
 * 不依赖渲染层的终端实例：渲染层只有 5000 行滚动历史，没挂载过的会话也没有实例。
 */

/** 重放用的滚动历史行数，足以容纳缓冲上限内的全部输出 */
const REPLAY_SCROLLBACK = 100_000;
/** 重放超时，超时按失败处理并退回直接去除控制符 */
const REPLAY_TIMEOUT_MS = 20_000;

const FORMAT_TEXT: Record<ExportFormat, string> = {
  rendered: '纯文本（按屏幕重放）',
  plain: '纯文本（直接去除控制符）',
  ansi: '原始 ANSI',
};

/** 取终端缓冲的全部文本：isWrapped 的折行拼回上一行，末尾空行去掉 */
function bufferText(term: Terminal): string {
  const normal = term.buffer.normal;
  // 停在备用屏（全屏程序）且主屏为空时改取备用屏
  const buf = normal.length <= 1 && term.buffer.active.type === 'alternate' ? term.buffer.active : normal;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    // 后面接着折行时保留行尾空格，否则拼接后会丢掉恰好落在折行处的空格
    const keepTail = buf.getLine(i + 1)?.isWrapped === true;
    const text = line.translateToString(!keepTail);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.map(l => l.replace(/\s+$/, '')).join('\n');
}

/** 用无界面终端按给定列宽重放原始流，返回与屏幕所见一致的文本 */
export function renderToText(raw: string, cols: number, rows = 30): Promise<string> {
  const term = new Terminal({
    cols: Math.max(20, Math.floor(cols) || 120),
    rows: Math.max(5, Math.floor(rows) || 30),
    scrollback: REPLAY_SCROLLBACK,
    allowProposedApi: true,
  });
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fn(); } finally { term.dispose(); }
    };
    const timer = setTimeout(() => finish(() => reject(new Error('重放超时'))), REPLAY_TIMEOUT_MS);
    try {
      term.write(raw, () => finish(() => {
        try { resolve(bufferText(term)); } catch (err) { reject(err); }
      }));
    } catch (err) {
      finish(() => reject(err));
    }
  });
}

export interface ExportContent {
  content: string;
  /** 重放失败，内容已改用直接去除控制符 */
  fallback: boolean;
}

export interface BuildOptions {
  label: string;
  cols: number;
  rows: number;
  /** 缓冲超限丢弃的较早字符数 */
  dropped: number;
  now: Date;
}

/** 文件头：截断提示放第一行，文本格式再注明导出方式；原始 ANSI 只在截断时加一行提示 */
function header(format: ExportFormat, o: BuildOptions, fallback: boolean): string {
  const lines: string[] = [];
  if (o.dropped > 0) lines.push(`[较早的 ${o.dropped} 个字符已被丢弃]`);
  if (format !== 'ansi') {
    const way = fallback ? `${FORMAT_TEXT.plain}，按屏幕重放失败后改用` : FORMAT_TEXT[format];
    lines.push(`[会话「${o.label}」终端输出，导出方式：${way}，导出时间：${formatStamp(o.now, true)}]`);
  }
  return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}

/** 按格式生成导出内容 */
export async function buildExportContent(raw: string, format: ExportFormat, o: BuildOptions): Promise<ExportContent> {
  if (format === 'ansi') return { content: header(format, o, false) + raw, fallback: false };
  if (format === 'plain') return { content: header(format, o, false) + stripAnsi(raw).replace(/\s+$/, '') + '\n', fallback: false };
  try {
    const text = await renderToText(raw, o.cols, o.rows);
    return { content: header(format, o, false) + text + '\n', fallback: false };
  } catch {
    return { content: header(format, o, true) + stripAnsi(raw).replace(/\s+$/, '') + '\n', fallback: true };
  }
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** yyyyMMdd-HHmm；readable 为 true 时为 yyyy-MM-dd HH:mm */
export function formatStamp(d: Date, readable = false): string {
  const y = d.getFullYear();
  const md = `${pad(d.getMonth() + 1)}${readable ? '-' : ''}${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}${readable ? ':' : ''}${pad(d.getMinutes())}`;
  return readable ? `${y}-${md} ${hm}` : `${y}${md}-${hm}`;
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** 文件名清洗：去掉 Windows 不允许的字符与控制符，去掉结尾的点和空格，保留名加前缀，过长截断 */
export function sanitizeFileName(name: string): string {
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, 80).join('').replace(/[. ]+$/, '');
  if (!s) s = 'session';
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

export function defaultExportName(label: string, format: ExportFormat, now: Date): string {
  return `${sanitizeFileName(label)}-${formatStamp(now)}${format === 'ansi' ? '.log' : '.txt'}`;
}

/** 目录里已有同名文件时依次加 -1、-2 后缀（只用于跳过保存对话框的自测目录） */
export function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base}-${i}${ext}`);
  return p;
}

export interface ExportDeps {
  output(id: string): string;
  dropped(id: string): number;
  termSize(id: string): { cols: number; rows: number };
  /** 会话不在列表里时返回 undefined */
  label(id: string): string | undefined;
  /** 选择保存路径，取消返回 null */
  pickPath(defaultName: string, format: ExportFormat): Promise<string | null>;
  now?: () => Date;
}

export const NO_OUTPUT = '无可导出的输出';

/** 导出一个会话的终端输出：缓冲为空时直接返回提示，不弹保存对话框 */
export async function exportOutput(deps: ExportDeps, id: string, format: ExportFormat): Promise<ExportResult> {
  const label = deps.label(id);
  if (label === undefined) return { ok: false, error: '会话不存在' };
  const raw = deps.output(id);
  if (!raw) return { ok: false, error: NO_OUTPUT };
  const now = deps.now?.() ?? new Date();
  const dropped = deps.dropped(id);
  const file = await deps.pickPath(defaultExportName(label, format, now), format);
  if (!file) return { ok: false, canceled: true };
  const { cols, rows } = deps.termSize(id);
  const { content, fallback } = await buildExportContent(raw, format, { label, cols, rows, dropped, now });
  try {
    await fs.promises.writeFile(file, content, 'utf8');
  } catch (err) {
    return { ok: false, error: `写入失败：${(err as Error).message}` };
  }
  const r: ExportResult = { ok: true, path: file, truncated: dropped > 0 };
  if (dropped > 0) r.dropped = dropped;
  if (fallback) r.fallback = true;
  return r;
}

export function isExportFormat(v: unknown): v is ExportFormat {
  return v === 'rendered' || v === 'plain' || v === 'ansi';
}
