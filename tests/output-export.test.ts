import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildExportContent, defaultExportName, exportOutput, formatStamp, NO_OUTPUT, renderToText, sanitizeFileName, uniquePath,
  type ExportDeps,
} from '../src/main/output-export';

const ESC = '\x1b';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-export-'));
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('renderToText 重放', () => {
  it('清屏后只留下清屏之后的屏幕内容与之前滚出的历史', async () => {
    const text = await renderToText(`旧内容\r\n${ESC}[H${ESC}[2J新内容\r\n`, 80, 10);
    expect(text.includes('新内容')).toBe(true);
    expect(text.includes(ESC)).toBe(false);
  });

  it('光标上移重绘：同一行被覆盖时只保留最后一版', async () => {
    const raw = '标题\r\n⠋ 处理中 1\r\n'
      + `${ESC}[1A${ESC}[2K⠙ 处理中 2\r\n`
      + `${ESC}[1A${ESC}[2K✓ 完成\r\n`;
    const text = await renderToText(raw, 80, 10);
    expect(text).toBe('标题\n✓ 完成');
  });

  it('超出列宽的长行折行后拼回一行', async () => {
    const long = 'abcdefghij'.repeat(5);
    const text = await renderToText(`${long}\r\n下一行`, 20, 10);
    expect(text.split('\n')).toEqual([long, '下一行']);
  });

  it('中文宽字符折行也能拼回', async () => {
    const zh = '中文字符'.repeat(8);
    const text = await renderToText(zh, 20, 10);
    expect(text).toBe(zh);
  });

  it('末尾空行去掉', async () => {
    expect(await renderToText('一\r\n二\r\n\r\n\r\n', 40, 10)).toBe('一\n二');
  });
});

describe('导出内容', () => {
  const opts = { label: '任务', cols: 80, rows: 10, dropped: 0, now: new Date(2026, 9, 17, 9, 5) };
  const raw = `${ESC}[32m中文输出${ESC}[0m\r\n第二行\r\n`;

  it('rendered 与 plain 不含 ESC，首行注明导出方式', async () => {
    for (const f of ['rendered', 'plain'] as const) {
      const { content } = await buildExportContent(raw, f, opts);
      expect(content.includes(ESC)).toBe(false);
      expect(content.split('\n')[0]).toContain('导出方式');
      expect(content).toContain('中文输出\n第二行');
    }
  });

  it('ansi 原样保留控制序列', async () => {
    const { content } = await buildExportContent(raw, 'ansi', opts);
    expect(content).toBe(raw);
  });

  it('发生过截断时首行提示丢弃的字符数', async () => {
    for (const f of ['rendered', 'plain', 'ansi'] as const) {
      const { content } = await buildExportContent(raw, f, { ...opts, dropped: 1234 });
      expect(content.split('\n')[0]).toBe('[较早的 1234 个字符已被丢弃]');
    }
  });
});

describe('文件名', () => {
  it('默认名为 标签-yyyyMMdd-HHmm，原始格式用 .log', () => {
    const now = new Date(2026, 0, 2, 3, 4);
    expect(formatStamp(now)).toBe('20260102-0304');
    expect(defaultExportName('修复登录', 'rendered', now)).toBe('修复登录-20260102-0304.txt');
    expect(defaultExportName('修复登录', 'ansi', now)).toBe('修复登录-20260102-0304.log');
  });

  it('清洗非法字符、保留名与结尾的点', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFileName('con')).toBe('_con');
    expect(sanitizeFileName('结尾. . ')).toBe('结尾');
    expect(sanitizeFileName('   ')).toBe('session');
    expect(Array.from(sanitizeFileName('长'.repeat(200))).length).toBe(80);
  });

  it('同名文件存在时加序号', () => {
    fs.writeFileSync(path.join(tmp, 'dup.txt'), '');
    expect(uniquePath(tmp, 'dup.txt')).toBe(path.join(tmp, 'dup-1.txt'));
  });
});

describe('exportOutput', () => {
  const deps = (over: Partial<ExportDeps> = {}): ExportDeps => ({
    output: () => `${ESC}[1m粗体中文${ESC}[0m\r\n`,
    dropped: () => 0,
    termSize: () => ({ cols: 80, rows: 10 }),
    label: () => '导出用例',
    pickPath: async name => uniquePath(tmp, name),
    now: () => new Date(2026, 9, 17, 10, 0),
    ...over,
  });

  it('三种格式都写入临时目录', async () => {
    for (const f of ['rendered', 'plain', 'ansi'] as const) {
      const r = await exportOutput(deps(), 's1', f);
      expect(r.ok).toBe(true);
      expect(r.truncated).toBe(false);
      const body = fs.readFileSync(r.path!, 'utf8');
      expect(body).toContain('粗体中文');
      expect(body.includes(ESC)).toBe(f === 'ansi');
      expect(path.extname(r.path!)).toBe(f === 'ansi' ? '.log' : '.txt');
    }
  });

  it('缓冲为空时提示无可导出的输出，不弹保存对话框', async () => {
    let asked = false;
    const r = await exportOutput(deps({ output: () => '', pickPath: async () => { asked = true; return null; } }), 's1', 'plain');
    expect(r).toEqual({ ok: false, error: NO_OUTPUT });
    expect(asked).toBe(false);
  });

  it('会话不存在、取消保存分别返回对应结果', async () => {
    expect((await exportOutput(deps({ label: () => undefined }), 'x', 'plain')).error).toBe('会话不存在');
    expect(await exportOutput(deps({ pickPath: async () => null }), 's1', 'plain')).toEqual({ ok: false, canceled: true });
  });

  it('截断时结果带 truncated 与丢弃数', async () => {
    const r = await exportOutput(deps({ dropped: () => 99 }), 's1', 'plain');
    expect(r.truncated).toBe(true);
    expect(r.dropped).toBe(99);
    expect(fs.readFileSync(r.path!, 'utf8').startsWith('[较早的 99 个字符已被丢弃]')).toBe(true);
  });

  it('写入失败返回错误', async () => {
    const r = await exportOutput(deps({ pickPath: async () => path.join(tmp, 'no-such-dir', 'x.txt') }), 's1', 'plain');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^写入失败/);
  });
});
