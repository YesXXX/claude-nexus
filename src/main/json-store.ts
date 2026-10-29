import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

/**
 * 小型 JSON 文件读写：写入走「临时文件 + rename」原子替换，读取失败返回 null。
 * 适用于记录、设置、缓存这类单文件状态，不适合频繁追加的大文件。
 */

/** rename 遇到这些错误码时（多为杀毒软件或索引服务短暂占用）等待后重试一次 */
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAY_MS = 50;

/** 同步等待：退出流程等同步路径也能用，不依赖事件循环 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 忙等兜底 */ }
  }
}

export interface ReadJsonOptions {
  /** 日志标签，缺省 json */
  tag?: string;
  /** 文件不存在时也记日志（缺省不记：不存在通常是正常的首次运行） */
  logMissing?: boolean;
}

/**
 * 读取并解析 JSON 文件。文件不存在、读失败或解析失败都返回 null；
 * 除「不存在」外的失败都记一行日志，便于排查损坏文件。
 */
export function readJson<T = unknown>(file: string, opts: ReadJsonOptions = {}): T | null {
  const tag = opts.tag ?? 'json';
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' || opts.logMissing) log(tag, `读取失败 ${file}：${code ?? String(err)}`);
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    log(tag, `解析失败 ${file}：${String(err)}`);
    return null;
  }
}

export interface WriteJsonOptions {
  tag?: string;
  /** 缩进格式化输出（缺省 2 空格；传 0 输出紧凑单行） */
  indent?: number;
}

/**
 * 原子写入 JSON：先写同目录的 `<file>.tmp`，再 rename 覆盖目标文件。
 * 目录不存在时自动创建；rename 被占用时等 50ms 重试一次。
 * 返回是否写入成功；失败只记日志，不抛出，调用方不应因写盘失败中断业务。
 */
export function writeJsonAtomic(file: string, data: unknown, opts: WriteJsonOptions = {}): boolean {
  const indent = opts.indent ?? 2;
  let text: string;
  try {
    text = indent > 0 ? JSON.stringify(data, null, indent) : JSON.stringify(data);
  } catch (err) {
    log(opts.tag ?? 'json', `序列化失败 ${file}：${String(err)}`);
    return false;
  }
  return writeTextAtomic(file, text, opts.tag);
}

/**
 * 原子写入任意文本（如整体重写的 JSONL 文件），规则与 writeJsonAtomic 相同：
 * 写临时文件再 rename，失败只记日志并返回 false。
 */
export function writeTextAtomic(file: string, text: string, tagName?: string): boolean {
  const tag = tagName ?? 'json';
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text);
  } catch (err) {
    log(tag, `写入临时文件失败 ${tmp}：${String(err)}`);
    removeQuietly(tmp);
    return false;
  }
  try {
    renameWithRetry(tmp, file);
    return true;
  } catch (err) {
    log(tag, `替换文件失败 ${file}：${String(err)}`);
    removeQuietly(tmp);
    return false;
  }
}

function renameWithRetry(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!code || !RETRY_CODES.has(code)) throw err;
    sleepSync(RETRY_DELAY_MS);
    fs.renameSync(from, to);
  }
}

function removeQuietly(file: string): void {
  try { fs.rmSync(file, { force: true }); } catch { /* 清理失败无碍 */ }
}
