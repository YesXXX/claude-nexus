import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  claudeConfigDir, claudeProjectsRoot, isUnderTranscriptRoot, locateTranscript, mockProjectsRoot, projectDirName,
} from '../src/main/claude-paths';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-cpaths-'));
const ID = '9f1e2c4a-1111-4222-8333-444455556666';

describe('claudeConfigDir / claudeProjectsRoot', () => {
  it('尊重 CLAUDE_CONFIG_DIR', () => {
    const dir = path.join(TMP, 'cfg');
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: dir })).toBe(dir);
    expect(claudeProjectsRoot({ CLAUDE_CONFIG_DIR: dir })).toBe(path.join(dir, 'projects'));
  });

  it('未设置时落在用户目录下的 .claude', () => {
    const home = path.join(TMP, 'home');
    expect(claudeConfigDir({ USERPROFILE: home })).toBe(
      process.platform === 'win32' ? path.join(home, '.claude') : path.join(os.homedir(), '.claude'));
  });

  it('显式覆盖优先，其次 mock 模式的模拟根', () => {
    const root = path.join(TMP, 'tr');
    expect(claudeProjectsRoot({ CLAUDE_PANEL_TRANSCRIPT_ROOT: root, CLAUDE_PANEL_MOCK_CLAUDE: '1' })).toBe(root);
    const home = path.join(TMP, 'panel');
    expect(claudeProjectsRoot({ CLAUDE_PANEL_MOCK_CLAUDE: '1', CLAUDE_PANEL_HOME: home }))
      .toBe(path.join(home, 'mock-claude', 'projects'));
    expect(mockProjectsRoot({ CLAUDE_PANEL_HOME: home })).toBe(path.join(home, 'mock-claude', 'projects'));
  });

  it('项目目录名：非字母数字替换为 -', () => {
    expect(projectDirName('D:\\WorkSpace\\foo')).toBe('D--WorkSpace-foo');
    expect(projectDirName('/home/u/my app')).toBe('-home-u-my-app');
  });
});

describe('locateTranscript', () => {
  const root = path.join(TMP, 'projects');
  fs.mkdirSync(path.join(root, 'D--a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'D--b'), { recursive: true });

  it('扫一级子目录找到非空文件', () => {
    const file = path.join(root, 'D--b', `${ID}.jsonl`);
    fs.writeFileSync(file, '{"type":"user"}\n');
    expect(locateTranscript(root, ID)).toEqual({ state: 'found', path: file, size: 16 });
  });

  it('hint 文件名对得上且非空时直接命中（即使不在根目录下）', () => {
    const hintDir = path.join(TMP, 'elsewhere');
    fs.mkdirSync(hintDir, { recursive: true });
    const hint = path.join(hintDir, `${ID}.jsonl`);
    fs.writeFileSync(hint, 'xx');
    expect(locateTranscript(root, ID, hint)).toMatchObject({ state: 'found', path: hint });
    // hint 文件名不符：忽略 hint，回到扫描
    expect(locateTranscript(root, ID, path.join(hintDir, 'other.jsonl')).path).toBe(path.join(root, 'D--b', `${ID}.jsonl`));
  });

  it('空文件与不存在都判 missing', () => {
    const other = '0b0c0d0e-aaaa-4bbb-8ccc-ddddeeeeffff';
    fs.writeFileSync(path.join(root, 'D--a', `${other}.jsonl`), '');
    expect(locateTranscript(root, other)).toEqual({ state: 'missing' });
    expect(locateTranscript(root, 'aaaaaaaa-0000-4000-8000-000000000000')).toEqual({ state: 'missing' });
  });

  it('根目录读不了判 unknown；不安全的 id 判 missing', () => {
    expect(locateTranscript(path.join(TMP, 'no-such-root'), ID)).toEqual({ state: 'unknown' });
    expect(locateTranscript(root, '..\\..\\x')).toEqual({ state: 'missing' });
  });
});

describe('claudeProjectsRoot 三级优先', () => {
  it('TRANSCRIPT_ROOT → CLAUDE_CONFIG_DIR/projects → 用户目录下 .claude/projects', () => {
    const tr = path.join(TMP, 'tr2');
    const cfg = path.join(TMP, 'cfg2');
    expect(claudeProjectsRoot({ CLAUDE_PANEL_TRANSCRIPT_ROOT: tr, CLAUDE_CONFIG_DIR: cfg })).toBe(tr);
    expect(claudeProjectsRoot({ CLAUDE_CONFIG_DIR: cfg })).toBe(path.join(cfg, 'projects'));
    const home = path.join(TMP, 'home2');
    expect(claudeProjectsRoot({ USERPROFILE: home })).toBe(path.join(claudeConfigDir({ USERPROFILE: home }), 'projects'));
  });
});

describe('isUnderTranscriptRoot', () => {
  const root = path.join(TMP, 'troot');
  const proj = path.join(root, 'D--repo');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'ok.jsonl'), '');

  it('根目录内的 .jsonl 通过，文件尚未创建也通过', () => {
    expect(isUnderTranscriptRoot(path.join(proj, 'ok.jsonl'), root)).toBe(true);
    expect(isUnderTranscriptRoot(path.join(proj, 'later.jsonl'), root)).toBe(true);
    expect(isUnderTranscriptRoot(path.join(proj, 'ok', 'subagents', 'agent-a1.jsonl'), root)).toBe(true);
  });

  it('.. 穿越被拒绝', () => {
    expect(isUnderTranscriptRoot(path.join(proj, '..', '..', 'evil.jsonl'), root)).toBe(false);
    expect(isUnderTranscriptRoot(`${proj}${path.sep}..${path.sep}..${path.sep}x${path.sep}a.jsonl`, root)).toBe(false);
  });

  it('其他目录与其他盘符被拒绝', () => {
    expect(isUnderTranscriptRoot(path.join(TMP, 'elsewhere', 'a.jsonl'), root)).toBe(false);
    if (process.platform === 'win32') {
      const drive = root.slice(0, 1).toUpperCase() === 'Z' ? 'Y' : 'Z';
      expect(isUnderTranscriptRoot(`${drive}:\projects\a.jsonl`, root)).toBe(false);
    }
  });

  it('非 .jsonl、相对路径、根目录本身被拒绝', () => {
    expect(isUnderTranscriptRoot(path.join(proj, 'ok.json'), root)).toBe(false);
    expect(isUnderTranscriptRoot(path.join(proj, 'ok.jsonl.txt'), root)).toBe(false);
    expect(isUnderTranscriptRoot('D--repo\ok.jsonl', root)).toBe(false);
    expect(isUnderTranscriptRoot('', root)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('Windows 下大小写不敏感', () => {
    expect(isUnderTranscriptRoot(path.join(proj.toUpperCase(), 'OK.JSONL'), root.toLowerCase())).toBe(true);
  });

  it('符号链接指向根目录之外时被拒绝', () => {
    const outside = path.join(TMP, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const link = path.join(root, 'link');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch {
      return; // 无权限创建链接的环境跳过
    }
    expect(isUnderTranscriptRoot(path.join(link, 'a.jsonl'), root)).toBe(false);
  });
});
