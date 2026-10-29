import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../src/shared/ring-buffer';

describe('RingBuffer', () => {
  it('容量内全部保留且有序', () => {
    const buf = new RingBuffer(3);
    buf.push('a'); buf.push('b');
    expect(buf.getAll()).toEqual(['a', 'b']);
  });

  it('超出容量只保留最后 N 条', () => {
    const buf = new RingBuffer(2);
    buf.push('a'); buf.push('b'); buf.push('c'); buf.push('d');
    expect(buf.getAll()).toEqual(['c', 'd']);
  });

  it('getAll 返回副本，外部修改不影响内部', () => {
    const buf = new RingBuffer(2);
    buf.push('a');
    const copy = buf.getAll();
    copy.push('hacked');
    expect(buf.getAll()).toEqual(['a']);
  });

  it('容量为 0 或负数时构造抛错', () => {
    expect(() => new RingBuffer(0)).toThrow();
  });
});

describe('raw 上限（MAX_RAW_CHARS）', () => {
  it('pushRaw 累计超过 2MB 只保留尾部', () => {
    const buf = new RingBuffer(10);
    buf.pushRaw('a'.repeat(1_500_000));
    buf.pushRaw('b'.repeat(1_500_000));
    const raw = buf.getRaw();
    expect(raw.length).toBe(2_000_000);
    expect(raw.startsWith('a')).toBe(true);   // 头部是前一段的尾 50 万个 a
    expect(raw.endsWith('b')).toBe(true);
    expect(raw[499_999]).toBe('a');   // 50 万个 a 之后立即切换到 b —— 锁定"保尾"
    expect(raw[500_000]).toBe('b');
  });
  it('上限内不截断', () => {
    const buf = new RingBuffer(10);
    buf.pushRaw('abc');
    expect(buf.getRaw()).toBe('abc');
  });
  it('单个 chunk 超过上限同样收敛到 2M 且保尾', () => {
    const buf = new RingBuffer(10);
    buf.pushRaw('a'.repeat(2_500_000) + 'b');
    const raw = buf.getRaw();
    expect(raw.length).toBe(2_000_000);
    expect(raw[1_999_999]).toBe('b');   // 最后那个 b 必须在
  });
  it('dropped 累计被丢弃的字符数，未超限时为 0', () => {
    const buf = new RingBuffer(10);
    buf.pushRaw('x'.repeat(1_000));
    expect(buf.dropped).toBe(0);
    buf.pushRaw('a'.repeat(2_000_000));
    expect(buf.dropped).toBe(1_000);
    buf.pushRaw('b'.repeat(500));
    expect(buf.dropped).toBe(1_500);
    expect(buf.getRaw().length).toBe(2_000_000);
  });
});
