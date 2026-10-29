/**
 * 控制台输出解码：先按 UTF-8 严格解码，失败时改用 GBK（中文 Windows 上 mvn、javac、cmd 内置命令常输出 GBK）。
 * 输出可能被截成头尾两段，段首段尾可能落在多字节字符中间，判断编码时容忍这两处的残缺。
 */

export type ConsoleEncoding = 'utf-8' | 'gbk';

/** 段首最多跳过的 UTF-8 续字节数（一个字符最多 4 字节，被截时最多残留 3 个续字节） */
const MAX_LEADING_CONTINUATION = 3;

function isContinuation(b: number): boolean {
  return (b & 0xc0) === 0x80;
}

/**
 * 一段字节是否为合法 UTF-8。trimStart 为真时段首的续字节视为被截断的残留，跳过；
 * 段尾未完整的字符总是容忍（按流式解码不冲刷）。
 */
export function isValidUtf8(bytes: Uint8Array, trimStart = false): boolean {
  let start = 0;
  if (trimStart) while (start < bytes.length && start < MAX_LEADING_CONTINUATION && isContinuation(bytes[start])) start++;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start), { stream: true });
    return true;
  } catch {
    return false;
  }
}

let gbkDecoder: TextDecoder | null | undefined;

/** 运行时不支持 GBK 解码器时返回 null（调用方退回 UTF-8 宽松解码） */
function gbk(): TextDecoder | null {
  if (gbkDecoder === undefined) {
    try { gbkDecoder = new TextDecoder('gbk'); } catch { gbkDecoder = null; }
  }
  return gbkDecoder;
}

/**
 * 判断一组输出片段的编码：全部片段都是合法 UTF-8 时为 utf-8，否则为 gbk。
 * 第一个片段视为输出开头，其余片段的开头可能被截断。
 */
export function detectEncoding(parts: Uint8Array[]): ConsoleEncoding {
  for (let i = 0; i < parts.length; i++) {
    if (!isValidUtf8(parts[i], i > 0)) return gbk() ? 'gbk' : 'utf-8';
  }
  return 'utf-8';
}

/** 按指定编码宽松解码（非法字节变替换字符）；GBK 不可用时按 UTF-8 */
export function decodeAs(bytes: Uint8Array, enc: ConsoleEncoding): string {
  const d = enc === 'gbk' ? gbk() : null;
  return (d ?? new TextDecoder('utf-8')).decode(bytes);
}

/** 解码一段完整的控制台输出：合法 UTF-8 按 UTF-8，否则按 GBK */
export function decodeConsoleOutput(bytes: Uint8Array): string {
  return decodeAs(bytes, detectEncoding([bytes]));
}
