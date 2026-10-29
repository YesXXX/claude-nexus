import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { createGitRunner } from '../src/main/git-runner';
import { createCliRunner } from '../src/main/cli-runner';
import {
  CLAUDE_PRINT_ARGS, buildSuggestPrompt, cleanSuggestion, suggestCommitMessage, truncateBytes,
} from '../src/main/commit-message';

function tmpDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function repo(): string {
  const r = tmpDir('panel-cm-repo-');
  sh(r, 'init', '-q', '-b', 'main');
  sh(r, 'config', 'user.email', 't@t');
  sh(r, 'config', 'user.name', 't');
  sh(r, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(r, 'a.txt'), 'one\n');
  sh(r, 'add', '.');
  sh(r, 'commit', '-q', '-m', 'init');
  return r;
}

/** 假 claude：把参数与 stdin 写进文件，再按 mode 输出或挂起 */
function fakeClaude(dir: string, body: string): string {
  const file = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(file, [
    "const fs = require('fs');",
    "const path = require('path');",
    'const chunks = [];',
    "process.stdin.on('data', c => chunks.push(c));",
    "process.stdin.on('end', () => {",
    "  fs.writeFileSync(path.join(__dirname, 'args.json'), JSON.stringify(process.argv.slice(2)));",
    "  fs.writeFileSync(path.join(__dirname, 'stdin.txt'), Buffer.concat(chunks));",
    `  ${body}`,
    '});',
  ].join('\n'));
  return file;
}

const git = createGitRunner();

describe('提交信息生成的纯函数', () => {
  it('按字节截断不切坏中文', () => {
    const t = truncateBytes('中文中文', 7);
    expect(t.truncated).toBe(true);
    expect(t.text).toBe('中文');
    expect(truncateBytes('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });
  it('提示词包含统计、未跟踪文件与截断说明', () => {
    const p = buildSuggestPrompt(' a.txt | 1 +', 'x'.repeat(200), ['new.md'], 100);
    expect(p).toContain('a.txt | 1 +');
    expect(p).toContain('new.md');
    expect(p).toContain('已截断');
    expect(p).not.toContain('x'.repeat(101));
  });
  it('输出清理：去围栏、ANSI、首尾空行与多余空行', () => {
    expect(cleanSuggestion('\n```text\nfeat: 新增 A  \n\n\n\n正文\n```\n\n')).toBe('feat: 新增 A\n\n正文');
    expect(cleanSuggestion('\x1b[32mfix: 修复\x1b[0m\r\n')).toBe('fix: 修复');
    expect(cleanSuggestion('```\n```')).toBe('');
  });
});

describe('suggestCommitMessage', () => {
  it('参数固定、提示词经 stdin 传入且超长 diff 被截断，输出经过清理', async () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'a.txt'), `${'长内容'.repeat(5000)}\n`);
    fs.writeFileSync(path.join(r, 'new.md'), 'n\n');
    fs.mkdirSync(path.join(r, '.claude'));
    fs.writeFileSync(path.join(r, '.claude', 'settings.local.json'), '{}');
    const dir = tmpDir('panel-cm-fake-');
    const script = fakeClaude(dir, "process.stdout.write('```\\nfeat: 生成的信息\\n```\\n');");
    const claude = createCliRunner({ file: process.execPath, prefixArgs: [script] });
    const res = await suggestCommitMessage({ git, claude, maxDiffBytes: 2048 }, r);
    expect(res).toEqual({ ok: true, text: 'feat: 生成的信息' });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'))).toEqual(CLAUDE_PRINT_ARGS);
    const stdin = fs.readFileSync(path.join(dir, 'stdin.txt'), 'utf8');
    expect(stdin).toContain('new.md');
    expect(stdin).not.toContain('settings.local.json');
    expect(stdin).toContain('已截断');
    expect(Buffer.byteLength(stdin)).toBeLessThan(4096);
  });

  it('没有改动时不调用 claude', async () => {
    const r = repo();
    const claude = createCliRunner({ file: path.join(r, 'no-claude.exe') });
    expect(await suggestCommitMessage({ git, claude }, r)).toEqual({ ok: false, error: '没有未提交的改动' });
  });

  it('找不到程序给出可读原因', async () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'a.txt'), 'two\n');
    const claude = createCliRunner({ file: path.join(r, 'no-claude.exe') });
    const res = await suggestCommitMessage({ git, claude }, r);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('未找到 claude');
  });

  it('超时给出可读原因', async () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'a.txt'), 'two\n');
    const dir = tmpDir('panel-cm-fake-');
    const script = fakeClaude(dir, 'setTimeout(() => {}, 60000);');
    const claude = createCliRunner({ file: process.execPath, prefixArgs: [script] });
    const res = await suggestCommitMessage({ git, claude, timeoutMs: 800 }, r);
    expect(res).toEqual({ ok: false, error: 'claude 生成超时（1 秒）' });
  }, 15000);

  it('非 0 退出取 stderr 首行；空输出单独说明', async () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'a.txt'), 'two\n');
    const dir = tmpDir('panel-cm-fake-');
    const failing = fakeClaude(dir, "process.stderr.write('Invalid API key\\nmore'); process.exitCode = 1;");
    const res = await suggestCommitMessage({ git, claude: createCliRunner({ file: process.execPath, prefixArgs: [failing] }) }, r);
    expect(res).toEqual({ ok: false, error: 'claude 执行失败：Invalid API key' });
    const dir2 = tmpDir('panel-cm-fake-');
    const empty = fakeClaude(dir2, "process.stdout.write('\\n```\\n```\\n');");
    const res2 = await suggestCommitMessage({ git, claude: createCliRunner({ file: process.execPath, prefixArgs: [empty] }) }, r);
    expect(res2).toEqual({ ok: false, error: 'claude 没有返回内容' });
  });
});
