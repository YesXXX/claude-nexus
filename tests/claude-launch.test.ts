import { describe, it, expect } from 'vitest';
import {
  buildClaudeArgs, sanitizeName, sanitizeLaunch, sanitizeChildEnv, isUuid, NAME_MAX,
} from '../src/main/claude-launch';
import { CONSERVATIVE_CAPS, MOCK_CAPS } from '../src/main/cli-capabilities';

const P = 'D:\\home\\sessions\\x\\settings.json';
const A = '9f1e2c4a-1111-4222-8333-444455556666';
const B = '0b0c0d0e-aaaa-4bbb-8ccc-ddddeeeeffff';
const FULL = { ...MOCK_CAPS, version: '2.1.278' };

describe('buildClaudeArgs', () => {
  it('新建：能力全开时带 --session-id 与 --name；保守能力只有 --settings', () => {
    expect(buildClaudeArgs({ settingsPath: P, caps: FULL, sessionId: A, name: '修复导入' }))
      .toEqual(['--settings', P, '--session-id', A, '--name', '修复导入']);
    expect(buildClaudeArgs({ settingsPath: P, caps: CONSERVATIVE_CAPS, sessionId: A, name: '修复导入' }))
      .toEqual(['--settings', P]);
    expect(buildClaudeArgs({ settingsPath: P, caps: CONSERVATIVE_CAPS })).toEqual(['--settings', P]);
  });

  it('续接：--resume id，不带 --session-id；续接时又指定新 id 抛错', () => {
    expect(buildClaudeArgs({ settingsPath: P, caps: CONSERVATIVE_CAPS, resumeId: A }))
      .toEqual(['--settings', P, '--resume', A]);
    expect(() => buildClaudeArgs({ settingsPath: P, caps: FULL, resumeId: A, sessionId: B })).toThrow();
  });

  it('分叉：--resume id --fork-session，可再指定新 id；CLI 不支持或缺 resumeId 时抛错', () => {
    expect(buildClaudeArgs({ settingsPath: P, caps: FULL, resumeId: A, forkSession: true }))
      .toEqual(['--settings', P, '--resume', A, '--fork-session']);
    expect(buildClaudeArgs({ settingsPath: P, caps: FULL, resumeId: A, forkSession: true, sessionId: B }))
      .toEqual(['--settings', P, '--resume', A, '--fork-session', '--session-id', B]);
    expect(() => buildClaudeArgs({ settingsPath: P, caps: CONSERVATIVE_CAPS, resumeId: A, forkSession: true })).toThrow();
    expect(() => buildClaudeArgs({ settingsPath: P, caps: FULL, forkSession: true })).toThrow();
  });

  it('CLI 不支持 --resume 时续接抛错', () => {
    expect(() => buildClaudeArgs({ settingsPath: P, caps: { ...FULL, resume: false }, resumeId: A })).toThrow();
  });

  it('非法 UUID 一律抛错（防止任意字符串进入命令行）', () => {
    for (const bad of ['', 'abc', `${A}&calc`, `"${A}"`, 'claude-1']) {
      expect(() => buildClaudeArgs({ settingsPath: P, caps: FULL, resumeId: bad })).toThrow();
      expect(() => buildClaudeArgs({ settingsPath: P, caps: FULL, sessionId: bad })).toThrow();
    }
  });

  it('模型名与权限模式走白名单，不合规直接丢弃；prompt 永不进参数', () => {
    expect(buildClaudeArgs({ settingsPath: P, caps: CONSERVATIVE_CAPS, model: 'claude-opus-4[1m]', permissionMode: 'plan', prompt: 'a\nb' }))
      .toEqual(['--settings', P, '--model', 'claude-opus-4[1m]', '--permission-mode', 'plan']);
    expect(buildClaudeArgs({ settingsPath: P, caps: CONSERVATIVE_CAPS, model: 'x&calc', permissionMode: 'a b' }))
      .toEqual(['--settings', P]);
  });

  it('恶意标签净化后不含任何 shell 元字符', () => {
    const labels = ['a&calc', '"x"', '%PATH%', '!x!', 'a|b', 'a<b>c', 'a^b', '第一行\n第二行', 'x'.repeat(200)];
    for (const label of labels) {
      const args = buildClaudeArgs({ settingsPath: P, caps: FULL, sessionId: A, name: label });
      for (const a of args.slice(2)) expect(a).not.toMatch(/[&|<>^%"!\r\n]/);
    }
  });
});

describe('sanitizeName / sanitizeLaunch / isUuid', () => {
  it('只留字母、数字、汉字、空格与 -_.()（），折叠空白并截断', () => {
    expect(sanitizeName('修复 & 导入')).toBe('修复 导入');
    expect(sanitizeName('%PATH%')).toBe('PATH');
    expect(sanitizeName('!!!')).toBe('');
    expect(sanitizeName(undefined)).toBe('');
    expect(sanitizeName('接口(联调)（二）_v1.2-x')).toBe('接口(联调)（二）_v1.2-x');
    expect([...sanitizeName('汉'.repeat(100))].length).toBe(NAME_MAX);
  });

  it('sanitizeLaunch 只保留合法字段，全不合法返回 undefined', () => {
    expect(sanitizeLaunch({ model: 'sonnet', permissionMode: 'acceptEdits' })).toEqual({ model: 'sonnet', permissionMode: 'acceptEdits' });
    expect(sanitizeLaunch({ model: 'a b' })).toBeUndefined();
    expect(sanitizeLaunch(undefined)).toBeUndefined();
  });

  it('isUuid', () => {
    expect(isUuid(A)).toBe(true);
    expect(isUuid(A.toUpperCase())).toBe(true);
    expect(isUuid('x')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe('sanitizeChildEnv', () => {
  it('剥离父子进程标记（不区分大小写），保留用户配置，注入当前面板会话 id', () => {
    const env = sanitizeChildEnv({
      CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: 'p', CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_CODE_MESSAGING_TOKEN: 't',
      CLAUDE_CODE_SESSION_ATTENDED: '1', claude_pid: '42', CLAUDE_PANEL_SESSION_ID: 'outer', CLAUDE_CODE_CHILD: '1',
      ANTHROPIC_API_KEY: 'k', CLAUDE_EFFORT: 'high', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_GIT_BASH_PATH: 'D:\\git\\bash.exe', CLAUDE_CODE_USE_BEDROCK: '1', PATH: 'C:\\bin', EMPTY: undefined,
    }, 'inner');
    expect(env).toEqual({
      ANTHROPIC_API_KEY: 'k', CLAUDE_EFFORT: 'high', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_GIT_BASH_PATH: 'D:\\git\\bash.exe', CLAUDE_CODE_USE_BEDROCK: '1', PATH: 'C:\\bin',
      CLAUDE_PANEL_SESSION_ID: 'inner',
    });
  });

  it('不传面板会话 id 时不注入', () => {
    expect(sanitizeChildEnv({ CLAUDE_PANEL_SESSION_ID: 'outer', A: '1' })).toEqual({ A: '1' });
  });
});
