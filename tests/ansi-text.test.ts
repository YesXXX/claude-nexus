import { describe, expect, it } from 'vitest';
import { stripAnsi, tailLines } from '../src/shared/ansi-text';

const ESC = '\x1b';

describe('stripAnsi', () => {
  it('去掉 CSI 颜色与光标序列', () => {
    expect(stripAnsi(`${ESC}[31m红${ESC}[0m字${ESC}[2K${ESC}[1A${ESC}[?25l`)).toBe('红字');
  });

  it('去掉以 BEL 或 ST 结束的 OSC', () => {
    expect(stripAnsi(`${ESC}]0;标题\x07正文${ESC}]8;;http://x${ESC}\\链接${ESC}]8;;${ESC}\\`)).toBe('正文链接');
  });

  it('去掉 DCS 与单字符 ESC 序列', () => {
    expect(stripAnsi(`a${ESC}Pq#0;1${ESC}\\b${ESC}7c${ESC}8${ESC}(Bd${ESC}=`)).toBe('abcd');
  });

  it('\\r\\n 归一为 \\n，孤立 \\r 转为换行', () => {
    expect(stripAnsi('一\r\n二\r三\n四')).toBe('一\n二\n三\n四');
  });

  it('删除其他 C0 控制字符，保留制表符', () => {
    expect(stripAnsi('a\x07b\x08c\td\x00e\x7f')).toBe('abc\tde');
  });

  it('末尾不完整的序列直接丢弃', () => {
    expect(stripAnsi(`完整${ESC}[3`)).toBe('完整');
    expect(stripAnsi(`完整${ESC}]0;未结束`)).toBe('完整');
    expect(stripAnsi(`完整${ESC}`)).toBe('完整');
  });

  it('结果不含任何 ESC，中文与 emoji 保持原样', () => {
    const out = stripAnsi(`${ESC}[1;32m✓ 测试通过 🎉${ESC}[0m\r\n`);
    expect(out).toBe('✓ 测试通过 🎉\n');
    expect(out.includes(ESC)).toBe(false);
  });

  it('8 位 CSI（0x9B）同样去掉', () => {
    expect(stripAnsi('a\x9b31mb')).toBe('ab');
  });
});

describe('tailLines', () => {
  it('只取最后 maxLines 行并去掉末尾空白行', () => {
    expect(tailLines('1\n2\n3\n4\n\n\n', 2, 1000)).toBe('3\n4');
  });

  it('超出字节上限时按字符边界从尾部截断', () => {
    const out = tailLines('前面的内容\n中文结尾', 10, 6);
    expect(out).toBe('结尾');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(6);
  });

  it('不会切断代理对', () => {
    const out = tailLines('ab🎉', 10, 5);
    expect(out).toBe('b🎉');
  });
});
