import { promises as fsp } from 'fs';

/**
 * transcript 的分块增量读取：从 offset 起按块读，只消费到最后一个换行为止，
 * 未完成的半行留到下次读。每块之间用 setImmediate 让出事件循环，避免大文件卡住主进程。
 * 超长行（默认 16MB）直接跳过到下一个换行，不缓存整行。
 */

export const DEFAULT_CHUNK = 1024 * 1024;
export const DEFAULT_MAX_LINE = 16 * 1024 * 1024;

export interface ReadOptions {
  chunkSize?: number;
  maxLine?: number;
  /** 每个完整行（不含换行符）回调一次；end 为该行换行符之后的字节位置 */
  onLine: (line: string, end: number) => void;
  /** 跳过超长行时回调：at 为该行起始字节位置，end 为其换行符之后的位置 */
  onOversize?: (at: number, end: number) => void;
  /** 每块处理耗时（毫秒），用于测试与排障 */
  onChunkTiming?: (ms: number) => void;
}

export type ReadResult =
  | { state: 'ok'; offset: number; size: number }
  | { state: 'missing' }
  | { state: 'truncated'; size: number };

const yieldLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/**
 * 从 offset 起读到文件末尾。文件比 offset 小返回 truncated（调用方撤销后从 0 重读）；
 * 文件不存在返回 missing。返回的 offset 总落在换行之后。
 */
export async function readIncrement(file: string, offset: number, opts: ReadOptions): Promise<ReadResult> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  const maxLine = opts.maxLine ?? DEFAULT_MAX_LINE;
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(file, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    throw err;
  }
  try {
    const size = (await fh.stat()).size;
    if (size < offset) return { state: 'truncated', size };
    let pos = offset;
    /** 已消费（确认处理过的）位置 */
    let consumed = offset;
    /** 上一块剩下的半行 */
    let pending: Buffer[] = [];
    let pendingLen = 0;
    /** 当前行超长，正在跳到下一个换行 */
    let skipping = false;
    let skipFrom = 0;
    const buf = Buffer.allocUnsafe(chunkSize);

    while (pos < size) {
      const want = Math.min(chunkSize, size - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      const t0 = Date.now();
      const chunk = buf.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start);
        if (nl < 0) break;
        const end = pos + nl + 1;
        if (skipping) {
          skipping = false;
          opts.onOversize?.(skipFrom, end);
        } else if (pendingLen + nl - start > maxLine) {
          opts.onOversize?.(consumed, end);
        } else {
          const piece = chunk.subarray(start, nl);
          const whole = pendingLen > 0 ? Buffer.concat([...pending, piece]) : piece;
          let line = whole.toString('utf8');
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line) opts.onLine(line, end);
        }
        pending = [];
        pendingLen = 0;
        start = nl + 1;
        consumed = end;
      }
      if (start < bytesRead && !skipping) {
        const rest = chunk.subarray(start);
        if (pendingLen + rest.length > maxLine) {
          skipping = true;
          skipFrom = consumed;
          pending = [];
          pendingLen = 0;
        } else {
          // 复制一份：buf 会被下一块覆盖
          pending.push(Buffer.from(rest));
          pendingLen += rest.length;
        }
      }
      pos += bytesRead;
      opts.onChunkTiming?.(Date.now() - t0);
      if (pos < size) await yieldLoop();
    }
    // 正在跳过的超长行没有换行收尾：offset 停在该行起点，下次重新判断
    return { state: 'ok', offset: consumed, size };
  } finally {
    await fh.close().catch(() => undefined);
  }
}
