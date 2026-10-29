/** raw 原始流上限（UTF-16 字符数）：超出后只保留尾部，防止长跑会话内存无限增长（getSessionOutput() 回放语义 = 最近 200 万字符） */
export const MAX_RAW_CHARS = 2_000_000;

/** 定容输出缓冲：只保留最近 capacity 条终端输出行，供迷你终端视图回放。 */
export class RingBuffer {
  private items: string[] = [];
  private raw = '';
  private droppedChars = 0;

  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error(`capacity 必须为正数，收到 ${capacity}`);
  }

  push(item: string): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  /** 写入原始字节（xterm 需要原始流才能正确渲染光标/清屏）。超限保留尾部。 */
  pushRaw(chunk: string): void {
    this.raw += chunk;
    if (this.raw.length > MAX_RAW_CHARS) {
      this.droppedChars += this.raw.length - MAX_RAW_CHARS;
      this.raw = this.raw.slice(-MAX_RAW_CHARS);
    }
  }

  /** 因超限被丢弃的较早原始字符数 */
  get dropped(): number {
    return this.droppedChars;
  }

  getAll(): string[] {
    return [...this.items];
  }

  getRaw(): string {
    return this.raw;
  }

  get size(): number {
    return this.items.length;
  }
}