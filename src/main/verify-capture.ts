import * as fs from 'fs';
import { log } from './logger';
import { decodeAs, detectEncoding, type ConsoleEncoding } from '../shared/text-decode';

/**
 * 验证输出的收集：内存里只留开头与结尾两段（界面展示用），完整输出边收边写到临时文件，
 * 结束时按判定出的编码转成 UTF-8 日志。超过日志上限的部分不再落盘，并在日志末尾注明。
 */

export const HEAD_BYTES = 64 * 1024;
export const TAIL_BYTES = 192 * 1024;
/** 完整日志的上限：超过后不再写入，也不再转码，避免主进程读入过大的文件 */
export const LOG_MAX_BYTES = 32 * 1024 * 1024;

export interface CaptureResult {
  output: string;
  omittedBytes: number;
  encoding: ConsoleEncoding;
  totalBytes: number;
  logFile?: string;
}

/** 跳过开头被截断的 UTF-8 续字节（最多 3 个） */
function trimLeadingContinuation(b: Buffer): Buffer {
  let i = 0;
  while (i < 3 && i < b.length && (b[i] & 0xc0) === 0x80) i++;
  return i ? b.subarray(i) : b;
}

export function omittedMarker(bytes: number): string {
  const kb = bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} 字节`;
  return `\r\n…省略 ${kb}，完整内容见日志…\r\n`;
}

export class OutputCapture {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private total = 0;
  private logged = 0;
  private fd: number | null = null;
  private closed = false;

  /** partFile 缺省时不落盘（只保留头尾） */
  constructor(private readonly partFile?: string, private readonly headMax = HEAD_BYTES, private readonly tailMax = TAIL_BYTES) {
    if (!partFile) return;
    try {
      this.fd = fs.openSync(partFile, 'w');
    } catch (err) {
      log('verify', `无法创建验证日志 ${partFile}：${String(err)}`);
    }
  }

  get totalBytes(): number { return this.total; }

  write(chunk: Buffer | string): void {
    if (this.closed) return;
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (b.length === 0) return;
    this.total += b.length;
    this.writeLog(b);
    let rest = b;
    if (this.head.length < this.headMax) {
      const take = Math.min(this.headMax - this.head.length, rest.length);
      this.head = Buffer.concat([this.head, rest.subarray(0, take)]);
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    this.tail = Buffer.concat([this.tail, rest]);
    if (this.tail.length > this.tailMax * 2) this.tail = this.tail.subarray(this.tail.length - this.tailMax);
  }

  private writeLog(b: Buffer): void {
    if (this.fd === null || this.logged >= LOG_MAX_BYTES) return;
    const part = b.subarray(0, LOG_MAX_BYTES - this.logged);
    try {
      fs.writeSync(this.fd, part);
      this.logged += part.length;
    } catch (err) {
      log('verify', `写验证日志失败：${String(err)}`);
      this.closeFd();
    }
  }

  private closeFd(): void {
    if (this.fd === null) return;
    try { fs.closeSync(this.fd); } catch { /* 已关闭 */ }
    this.fd = null;
  }

  /** 丢弃：关闭并删除临时文件（被新一轮验证取代时用） */
  discard(): void {
    this.closed = true;
    this.closeFd();
    if (this.partFile) try { fs.rmSync(this.partFile, { force: true }); } catch { /* 忽略 */ }
  }

  /**
   * 结束收集：判定编码、拼出展示用的头尾输出；logFile 给出时把临时文件转成 UTF-8 日志写到该路径。
   */
  finish(logFile?: string): CaptureResult {
    this.closed = true;
    this.closeFd();
    let tail: Buffer = this.tail.length > this.tailMax ? this.tail.subarray(this.tail.length - this.tailMax) : this.tail;
    const omitted = Math.max(0, this.total - this.head.length - tail.length);
    const parts = tail.length ? [this.head, tail] : [this.head];
    const encoding = detectEncoding(omitted > 0 ? parts : [Buffer.concat(parts)]);
    let output: string;
    if (omitted > 0) {
      if (encoding === 'utf-8') tail = trimLeadingContinuation(tail);
      output = decodeAs(this.head, encoding) + omittedMarker(omitted) + decodeAs(tail, encoding);
    } else {
      output = decodeAs(Buffer.concat(parts), encoding);
    }
    const res: CaptureResult = { output, omittedBytes: omitted, encoding, totalBytes: this.total };
    const written = logFile ? this.writeUtf8Log(logFile, encoding) : false;
    if (written) res.logFile = logFile;
    else if (this.partFile) try { fs.rmSync(this.partFile, { force: true }); } catch { /* 忽略 */ }
    return res;
  }

  private writeUtf8Log(logFile: string, encoding: ConsoleEncoding): boolean {
    if (!this.partFile || !fs.existsSync(this.partFile)) return false;
    try {
      const raw = fs.readFileSync(this.partFile);
      let text = decodeAs(raw, encoding);
      if (this.total > this.logged) text += `\r\n…日志超过 ${Math.round(LOG_MAX_BYTES / 1024 / 1024)} MB，其后 ${this.total - this.logged} 字节未保存…\r\n`;
      fs.writeFileSync(logFile, text, 'utf8');
      fs.rmSync(this.partFile, { force: true });
      return true;
    } catch (err) {
      log('verify', `生成验证日志失败 ${logFile}：${String(err)}`);
      return false;
    }
  }
}
