import { describe, it, expect } from 'vitest';
import { decodeAs, decodeConsoleOutput, detectEncoding, isValidUtf8 } from '../src/shared/text-decode';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
/** 「中文」的 GBK 编码 */
const GBK_ZHONGWEN = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);

describe('text-decode', () => {
  it('合法 UTF-8 按 UTF-8 解码', () => {
    expect(detectEncoding([utf8('构建成功 ok')])).toBe('utf-8');
    expect(decodeConsoleOutput(utf8('构建成功 ok'))).toBe('构建成功 ok');
  });

  it('GBK 字节识别为 gbk 并正确解码', () => {
    expect(isValidUtf8(GBK_ZHONGWEN)).toBe(false);
    expect(detectEncoding([GBK_ZHONGWEN])).toBe('gbk');
    expect(decodeConsoleOutput(GBK_ZHONGWEN)).toBe('中文');
  });

  it('ASCII 与 GBK 混合时整段按 GBK', () => {
    const bytes = new Uint8Array([...utf8('error: '), ...GBK_ZHONGWEN, ...utf8(' 1')]);
    expect(decodeConsoleOutput(bytes)).toBe('error: 中文 1');
  });

  it('段尾被截断的多字节字符视为合法 UTF-8', () => {
    const full = utf8('测试');
    expect(isValidUtf8(full.subarray(0, full.length - 1))).toBe(true);
  });

  it('后续片段开头的残缺续字节被容忍，首段不容忍', () => {
    const full = utf8('测试');
    const cut = full.subarray(1);
    expect(isValidUtf8(cut, true)).toBe(true);
    expect(isValidUtf8(cut, false)).toBe(false);
    expect(detectEncoding([utf8('head'), cut])).toBe('utf-8');
    expect(detectEncoding([cut])).toBe('gbk');
  });

  it('非法字节宽松解码为替换字符，不抛出', () => {
    const s = decodeAs(new Uint8Array([0x61, 0xff, 0x62]), 'utf-8');
    expect(s).toBe('a�b');
  });

  it('空输入为 utf-8 空串', () => {
    expect(detectEncoding([new Uint8Array(0)])).toBe('utf-8');
    expect(decodeConsoleOutput(new Uint8Array(0))).toBe('');
  });
});
