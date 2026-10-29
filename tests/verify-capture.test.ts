import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OutputCapture, omittedMarker } from '../src/main/verify-capture';

function tmpDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-cap-')));
}

describe('OutputCapture', () => {
  it('输出不长时原样保留，并转成 UTF-8 日志', () => {
    const dir = tmpDir();
    const part = path.join(dir, 'a.part');
    const cap = new OutputCapture(part);
    cap.write('hello ');
    cap.write(Buffer.from('世界', 'utf8'));
    const res = cap.finish(path.join(dir, 'a.log'));
    expect(res.output).toBe('hello 世界');
    expect(res.omittedBytes).toBe(0);
    expect(res.encoding).toBe('utf-8');
    expect(res.logFile).toBe(path.join(dir, 'a.log'));
    expect(fs.readFileSync(res.logFile!, 'utf8')).toBe('hello 世界');
    expect(fs.existsSync(part)).toBe(false);
  });

  it('超长时只保留头尾，中间注明省略的字节数', () => {
    const cap = new OutputCapture(undefined, 10, 10);
    cap.write('0123456789');
    cap.write('x'.repeat(100));
    cap.write('abcdefghij');
    const res = cap.finish();
    expect(res.omittedBytes).toBe(100);
    expect(res.totalBytes).toBe(120);
    expect(res.output).toBe(`0123456789${omittedMarker(100)}abcdefghij`);
    expect(res.logFile).toBeUndefined();
  });

  it('尾段开头落在多字节字符中间时跳过残缺字节', () => {
    const cap = new OutputCapture(undefined, 4, 5);
    cap.write('head');
    cap.write(Buffer.from('xx测试', 'utf8'));
    const res = cap.finish();
    expect(res.encoding).toBe('utf-8');
    expect(res.output.endsWith('试')).toBe(true);
    expect(res.output).not.toContain('�');
  });

  it('GBK 输出整段按 GBK 解码，日志转为 UTF-8', () => {
    const dir = tmpDir();
    const cap = new OutputCapture(path.join(dir, 'g.part'));
    cap.write(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    const res = cap.finish(path.join(dir, 'g.log'));
    expect(res.encoding).toBe('gbk');
    expect(res.output).toBe('中文');
    expect(fs.readFileSync(path.join(dir, 'g.log'), 'utf8')).toBe('中文');
  });

  it('discard 删除临时文件，之后的写入被忽略', () => {
    const dir = tmpDir();
    const part = path.join(dir, 'd.part');
    const cap = new OutputCapture(part);
    cap.write('abc');
    cap.discard();
    cap.write('def');
    expect(fs.existsSync(part)).toBe(false);
    expect(cap.totalBytes).toBe(3);
  });
});
