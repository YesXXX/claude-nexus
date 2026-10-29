/**
 * 终端原始流转纯文本：去掉 CSI、OSC、DCS / SOS / PM / APC 与单字符 ESC 序列，
 * 换行统一为 \n（\r\n 与孤立的 \r 都算换行），其余 C0 控制字符除 \t 外全部删除。
 * 末尾不完整的转义序列直接丢弃。
 */
export function stripAnsi(raw: string): string {
  let out = '';
  const n = raw.length;
  let i = 0;
  while (i < n) {
    const c = raw.charCodeAt(i);
    if (c === 0x1b) {
      i = skipEscape(raw, i + 1);
      continue;
    }
    if (c === 0x9b) {
      i = skipCsi(raw, i + 1);
      continue;
    }
    if (c === 0x0d) {
      out += '\n';
      i += raw.charCodeAt(i + 1) === 0x0a ? 2 : 1;
      continue;
    }
    if (c === 0x0a || c === 0x09) {
      out += raw[i];
      i++;
      continue;
    }
    if (c < 0x20 || c === 0x7f) {
      i++;
      continue;
    }
    out += raw[i];
    i++;
  }
  return out;
}

/** ESC 之后的位置为 i，返回整个序列结束后的位置 */
function skipEscape(raw: string, i: number): number {
  if (i >= raw.length) return i;
  const ch = raw[i];
  if (ch === '[') return skipCsi(raw, i + 1);
  // OSC 以 BEL 或 ST（ESC \）结束；DCS / SOS / PM / APC 以 ST 结束
  if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_') return skipString(raw, i + 1, ch === ']');
  // 其余为 nF / Fp / Fe / Fs 单字符序列：若干中间字节（0x20-0x2F）加一个结束字节
  let j = i;
  while (j < raw.length && raw.charCodeAt(j) >= 0x20 && raw.charCodeAt(j) <= 0x2f) j++;
  return j < raw.length ? j + 1 : j;
}

/** CSI 参数（0x30-0x3F）、中间字节（0x20-0x2F）与结束字节（0x40-0x7E） */
function skipCsi(raw: string, i: number): number {
  let j = i;
  while (j < raw.length) {
    const c = raw.charCodeAt(j);
    if (c >= 0x40 && c <= 0x7e) return j + 1;
    if (c < 0x20 || c > 0x3f) {
      // 序列中途混入控制字符或非法字节：按序列在此终止，该字符交给外层处理
      if (c === 0x1b || c < 0x20) return j;
    }
    j++;
  }
  return j;
}

function skipString(raw: string, i: number, belEnds: boolean): number {
  let j = i;
  while (j < raw.length) {
    const c = raw.charCodeAt(j);
    if (belEnds && c === 0x07) return j + 1;
    if (c === 0x9c) return j + 1;
    if (c === 0x1b && raw[j + 1] === '\\') return j + 2;
    j++;
  }
  return j;
}

/**
 * 取文本末尾：最多 maxLines 行，且 UTF-8 编码不超过 maxBytes 字节（按字符边界截断）。
 * 末尾的空白行先去掉，避免尾部全是空行。
 */
export function tailLines(text: string, maxLines: number, maxBytes: number): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  let tail = lines.slice(-Math.max(1, maxLines)).join('\n');
  if (Buffer.byteLength(tail, 'utf8') <= maxBytes) return tail;
  const chars = Array.from(tail);
  let bytes = 0;
  let start = chars.length;
  while (start > 0) {
    const b = Buffer.byteLength(chars[start - 1], 'utf8');
    if (bytes + b > maxBytes) break;
    bytes += b;
    start--;
  }
  tail = chars.slice(start).join('');
  return tail;
}
