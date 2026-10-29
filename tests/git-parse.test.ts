import { describe, it, expect } from 'vitest';
import {
  addedFileDiff, countDirty, countLines, looksBinary, parseNameStatusZ, parseNumstatZ,
  parsePorcelainV2, parseUnifiedDiff, parseWorktreeList,
} from '../src/shared/git-parse';

const H = 'de980441c3ab03a8c07dda1ad27b8a11f39deb1e';
const Z = '0000000000000000000000000000000000000000';

describe('parsePorcelainV2', () => {
  it('解析普通修改、新增、重命名、冲突、未跟踪与忽略条目，路径含空格与中文', () => {
    const out = [
      `1 .M N... 100644 100644 100644 ${H} ${H} a.txt`,
      `1 A. N... 000000 100644 100644 ${Z} ${H} bin.dat`,
      `2 R. N... 100644 100644 100644 ${H} ${H} R100 new.ts`, 'old.ts',
      `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict.ts`,
      '? 中文 名.txt',
      '! dist/out.js',
      '',
    ].join('\0');
    const entries = parsePorcelainV2(out);
    expect(entries).toEqual([
      { type: 'changed', xy: '.M', path: 'a.txt' },
      { type: 'changed', xy: 'A.', path: 'bin.dat' },
      { type: 'renamed', xy: 'R.', path: 'new.ts', oldPath: 'old.ts' },
      { type: 'unmerged', xy: 'UU', path: 'conflict.ts' },
      { type: 'untracked', xy: '??', path: '中文 名.txt' },
      { type: 'ignored', xy: '!!', path: 'dist/out.js' },
    ]);
    expect(countDirty(entries)).toBe(5);
  });

  it('路径本身含空格时完整保留', () => {
    const out = `1 .M N... 100644 100644 100644 ${H} ${H} src/my file name.ts\0`;
    expect(parsePorcelainV2(out)[0].path).toBe('src/my file name.ts');
  });

  it('空输出返回空数组', () => {
    expect(parsePorcelainV2('')).toEqual([]);
  });
});

describe('parseNameStatusZ', () => {
  it('解析 M / A / D / T / U / R / C', () => {
    const out = ['M', 'a.txt', 'A', 'bin.dat', 'R100', 'old.ts', 'new.ts', 'D', 'gone.ts',
      'T', 'link', 'U', 'c.ts', 'C75', 'src.ts', 'copy.ts', 'M', '中文 名.txt', ''].join('\0');
    expect(parseNameStatusZ(out)).toEqual([
      { kind: 'modified', path: 'a.txt' },
      { kind: 'added', path: 'bin.dat' },
      { kind: 'renamed', path: 'new.ts', oldPath: 'old.ts' },
      { kind: 'deleted', path: 'gone.ts' },
      { kind: 'typechange', path: 'link' },
      { kind: 'conflicted', path: 'c.ts' },
      { kind: 'added', path: 'copy.ts' },
      { kind: 'modified', path: '中文 名.txt' },
    ]);
  });
});

describe('parseNumstatZ', () => {
  it('解析普通、二进制与重命名条目', () => {
    const out = '2\t1\ta.txt\0-\t-\tbin.dat\0' + '0\t0\t\0old.ts\0new.ts\0' + '1\t0\t中文 名.txt\0';
    expect(parseNumstatZ(out)).toEqual([
      { path: 'a.txt', additions: 2, deletions: 1 },
      { path: 'bin.dat', additions: null, deletions: null },
      { path: 'new.ts', oldPath: 'old.ts', additions: 0, deletions: 0 },
      { path: '中文 名.txt', additions: 1, deletions: 0 },
    ]);
  });
});

describe('parseWorktreeList', () => {
  it('第一块是主工作区，识别分支、游离 HEAD 与裸仓库', () => {
    const out = [
      'worktree D:/proj/app', 'HEAD 8f0d2087', 'branch refs/heads/main', '',
      'worktree D:/proj/app/.claude/worktrees/nexus-3f2a91c0', 'HEAD 1234abcd', 'branch refs/heads/nexus/3f2a91c0', '',
      'worktree D:/proj/app/.claude/worktrees/x', 'HEAD 99', 'detached', '',
    ].join('\n');
    expect(parseWorktreeList(out)).toEqual([
      { path: 'D:/proj/app', head: '8f0d2087', branch: 'main', bare: false, detached: false },
      { path: 'D:/proj/app/.claude/worktrees/nexus-3f2a91c0', head: '1234abcd', branch: 'nexus/3f2a91c0', bare: false, detached: false },
      { path: 'D:/proj/app/.claude/worktrees/x', head: '99', bare: false, detached: true },
    ]);
    expect(parseWorktreeList('worktree D:/bare.git\nbare\n')[0].bare).toBe(true);
  });
});

describe('parseUnifiedDiff', () => {
  const sample = [
    'diff --git a/a.txt b/a.txt',
    'index de98044..f8f7a32 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,4 @@',
    ' a',
    '-b',
    '+B',
    ' c',
    '+d',
    '\\ No newline at end of file',
    '',
  ].join('\n');

  it('按行编号并区分上下文 / 增 / 删 / 元信息', () => {
    const d = parseUnifiedDiff(sample);
    expect(d.binary).toBe(false);
    expect(d.truncated).toBe(false);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0].header).toBe('@@ -1,3 +1,4 @@');
    expect(d.hunks[0].lines).toEqual([
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'a' },
      { kind: 'del', oldNo: 2, text: 'b' },
      { kind: 'add', newNo: 2, text: 'B' },
      { kind: 'ctx', oldNo: 3, newNo: 3, text: 'c' },
      { kind: 'add', newNo: 4, text: 'd' },
      { kind: 'meta', text: 'No newline at end of file' },
    ]);
  });

  it('多个分块各自从头部的起始行号计数，CRLF 行尾被去掉', () => {
    const out = '@@ -10,2 +10,2 @@ fn\r\n x\r\n-y\r\n+z\r\n@@ -40 +40,2 @@\r\n k\r\n+m\r\n';
    const d = parseUnifiedDiff(out);
    expect(d.hunks.map(h => h.lines[0])).toEqual([
      { kind: 'ctx', oldNo: 10, newNo: 10, text: 'x' },
      { kind: 'ctx', oldNo: 40, newNo: 40, text: 'k' },
    ]);
    expect(d.hunks[1].lines[1]).toEqual({ kind: 'add', newNo: 41, text: 'm' });
  });

  it('二进制文件识别', () => {
    const out = 'diff --git a/bin.dat b/bin.dat\nnew file mode 100644\nBinary files /dev/null and b/bin.dat differ\n';
    expect(parseUnifiedDiff(out)).toEqual({ binary: true, truncated: false, hunks: [] });
  });

  it('超过行数上限截断', () => {
    const body = Array.from({ length: 20 }, (_, i) => `+line${i}`).join('\n');
    const d = parseUnifiedDiff(`@@ -0,0 +1,20 @@\n${body}\n`, 5);
    expect(d.truncated).toBe(true);
    expect(d.hunks[0].lines).toHaveLength(5);
  });

  it('空 diff 无分块', () => {
    expect(parseUnifiedDiff('')).toEqual({ binary: false, truncated: false, hunks: [] });
  });
});

describe('addedFileDiff / countLines / looksBinary', () => {
  it('未跟踪文件整份作为新增分块', () => {
    const d = addedFileDiff('x\ny\n');
    expect(d.hunks[0].header).toBe('@@ -0,0 +1,2 @@');
    expect(d.hunks[0].lines).toEqual([
      { kind: 'add', newNo: 1, text: 'x' },
      { kind: 'add', newNo: 2, text: 'y' },
    ]);
  });

  it('末尾无换行时追加元信息行；空文件无分块', () => {
    expect(addedFileDiff('x').hunks[0].lines[1]).toEqual({ kind: 'meta', text: 'No newline at end of file' });
    expect(addedFileDiff('').hunks).toEqual([]);
  });

  it('行数口径与 numstat 一致', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
  });

  it('含 NUL 判为二进制', () => {
    expect(looksBinary(new Uint8Array([0x61, 0, 0x62]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode('普通文本'))).toBe(false);
  });
});
