/**
 * 粘贴模式（bracketed paste，DEC 私有模式 2004）检测：TUI 开启时向终端输出 ESC[?2004h，关闭时输出 ESC[?2004l。
 * pty 输出是分块到达的，序列可能被切在两块之间，所以每次扫描保留本块末尾若干字符，与下一块拼接后再找。
 */

const ON = '\x1b[?2004h';
const OFF = '\x1b[?2004l';
/** 序列长 8 个字符，保留末尾 7 个即可覆盖任何切分位置 */
const TAIL = ON.length - 1;

export interface PasteScan {
  /** 本块（含上一块尾巴）里最后出现的模式；没有出现任何序列时缺省 */
  mode?: boolean;
  /** 交给下一次扫描的尾巴 */
  tail: string;
}

export function scanPasteMode(prevTail: string, chunk: string): PasteScan {
  const text = prevTail + chunk;
  const on = text.lastIndexOf(ON);
  const off = text.lastIndexOf(OFF);
  const tail = text.length > TAIL ? text.slice(-TAIL) : text;
  if (on < 0 && off < 0) return { tail };
  return { mode: on > off, tail };
}

/** 粘贴开始与结束标记 */
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/**
 * 粘贴正文清洗：去掉 \t、\n 以外的所有 C0 控制字符与 DEL（正文里的 ESC[201~ 因此无法提前结束粘贴，
 * 也杜绝控制序列注入），\r\n 与单独的 \r 先统一成 \n，最后行尾统一成 \r（与 xterm 粘贴时的处理一致）。
 */
export function sanitizeForPaste(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\n/g, '\r');
}

/** 一次粘贴写入的完整数据块：开始标记 + 清洗后的正文 + 结束标记；提交用的回车由调用方单独写 */
export function pasteBlock(text: string): string {
  return PASTE_START + sanitizeForPaste(text) + PASTE_END;
}
