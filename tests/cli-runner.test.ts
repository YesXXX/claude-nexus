import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { cliErrorText, createCliRunner } from '../src/main/cli-runner';
import { CommandLog, displayCommand, redactCredentials } from '../src/main/command-log';

function script(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-cli-'));
  const file = path.join(dir, 'fake.js');
  fs.writeFileSync(file, body);
  return file;
}

describe('cli-runner', () => {
  it('找不到程序时标记 notFound，退出码 -1', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-cli-'));
    const cli = createCliRunner({ file: path.join(dir, 'no-gh.exe') });
    const r = await cli.run(['--version']);
    expect(r.notFound).toBe(true);
    expect(r.code).toBe(-1);
    expect(cliErrorText('gh', r)).toBe('未找到 gh');
  });

  it('参数、环境变量与 stdin 原样传入，退出码透传', async () => {
    const fake = script(`
      let input = '';
      process.stdin.on('data', d => { input += d; });
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({ args: process.argv.slice(2), env: process.env.PANEL_X, input }));
        process.exit(3);
      });
    `);
    const cli = createCliRunner({ file: process.execPath, prefixArgs: [fake] });
    expect(cli.name).toBe('fake');
    const r = await cli.run(['a b', '', '中文"'], { env: { PANEL_X: 'yes' }, stdin: '多行\n输入' });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout)).toEqual({ args: ['a b', '', '中文"'], env: 'yes', input: '多行\n输入' });
    expect(cliErrorText('fake', r)).toContain('"args"');
  });

  it('不传 stdin 时立即 EOF，不会挂起', async () => {
    const fake = script(`process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'));`);
    const cli = createCliRunner({ file: process.execPath, prefixArgs: [fake] });
    const r = await cli.run([], { timeoutMs: 10000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('eof');
  });

  it('超时结束子进程并标记 timedOut', async () => {
    const fake = script(`setTimeout(() => {}, 60000);`);
    const cli = createCliRunner({ file: process.execPath, prefixArgs: [fake] });
    const r = await cli.run([], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(-2);
    expect(cliErrorText('fake', r)).toMatch(/超时/);
  }, 15000);

  it('baseEnv 替换继承环境', async () => {
    const fake = script(`process.stdout.write(String(process.env.PANEL_BASE) + '|' + String(process.env.PANEL_HIDDEN));`);
    process.env.PANEL_HIDDEN = 'leak';
    try {
      const cli = createCliRunner({
        file: process.execPath, prefixArgs: [fake],
        baseEnv: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PANEL_BASE: 'b' },
      });
      const r = await cli.run([]);
      expect(r.stdout).toBe('b|undefined');
    } finally {
      delete process.env.PANEL_HIDDEN;
    }
  });
});

describe('command-log', () => {
  const ok = { code: 0, stdout: 'out', stderr: '', ms: 12, notFound: false, timedOut: false };

  it('显示用命令行：含空格的参数加引号，URL 去凭据', () => {
    expect(displayCommand('git', ['commit', '-F', 'C:\\a b\\msg.txt'])).toBe('git commit -F "C:\\a b\\msg.txt"');
    expect(displayCommand('git', ['push', 'https://user:tok@github.com/o/r.git'])).toBe('git push https://github.com/o/r.git');
    expect(redactCredentials('fatal: https://x:y@h/o.git denied')).toBe('fatal: https://h/o.git denied');
  });

  it('按会话保留最近 50 条，输出截到 64KB', () => {
    let t = 0;
    const log = new CommandLog(() => ++t);
    for (let i = 0; i < 55; i++) log.record('s1', '/r', 'git', ['status', String(i)], ok);
    const list = log.list('s1');
    expect(list).toHaveLength(50);
    expect(list[0].display).toBe('git status 5');
    expect(list[49].at).toBe(55);
    const big = log.record('s2', '/r', 'git', ['log'], { ...ok, code: 1, stderr: 'x'.repeat(70 * 1024) });
    expect(big.ok).toBe(false);
    expect(big.stderr.length).toBeLessThan(66 * 1024);
    expect(big.stderr).toMatch(/已截断/);
    expect(log.list('none')).toEqual([]);
  });
});
