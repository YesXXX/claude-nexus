import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { panelHome, isIsolatedInstance, windowInactive, notifyLogOnly, NOTIFY_LOG_PREFIX } from '../src/main/panel-home';

const saved = process.env.CLAUDE_PANEL_HOME;

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_PANEL_HOME;
  else process.env.CLAUDE_PANEL_HOME = saved;
});

describe('panelHome / isIsolatedInstance', () => {
  it('未指定 CLAUDE_PANEL_HOME：默认目录且不是隔离实例', () => {
    delete process.env.CLAUDE_PANEL_HOME;
    expect(panelHome()).toBe(path.join(os.homedir(), '.claude-session-panel'));
    expect(isIsolatedInstance()).toBe(false);
  });

  it('指定 CLAUDE_PANEL_HOME：使用该目录并视为隔离实例', () => {
    process.env.CLAUDE_PANEL_HOME = path.join(os.tmpdir(), 'panel-isolated');
    expect(panelHome()).toBe(path.join(os.tmpdir(), 'panel-isolated'));
    expect(isIsolatedInstance()).toBe(true);
  });
});

describe('windowInactive / notifyLogOnly', () => {
  const home = path.join(os.tmpdir(), 'panel-isolated');

  it('隔离实例中按开关取值，大小写与首尾空白不敏感', () => {
    expect(windowInactive({ CLAUDE_PANEL_HOME: home, CLAUDE_PANEL_WINDOW: 'inactive' })).toBe(true);
    expect(windowInactive({ CLAUDE_PANEL_HOME: home, CLAUDE_PANEL_WINDOW: ' Inactive ' })).toBe(true);
    expect(notifyLogOnly({ CLAUDE_PANEL_HOME: home, CLAUDE_PANEL_NOTIFY: 'log' })).toBe(true);
    expect(notifyLogOnly({ CLAUDE_PANEL_HOME: home, CLAUDE_PANEL_NOTIFY: 'LOG' })).toBe(true);
  });

  it('非隔离实例一律忽略开关', () => {
    expect(windowInactive({ CLAUDE_PANEL_WINDOW: 'inactive' })).toBe(false);
    expect(notifyLogOnly({ CLAUDE_PANEL_NOTIFY: 'log' })).toBe(false);
    expect(windowInactive({ CLAUDE_PANEL_HOME: '', CLAUDE_PANEL_WINDOW: 'inactive' })).toBe(false);
    expect(notifyLogOnly({ CLAUDE_PANEL_HOME: '', CLAUDE_PANEL_NOTIFY: 'log' })).toBe(false);
  });

  it('未设置或取值不认识时保持默认行为', () => {
    expect(windowInactive({ CLAUDE_PANEL_HOME: home })).toBe(false);
    expect(windowInactive({ CLAUDE_PANEL_HOME: home, CLAUDE_PANEL_WINDOW: 'hidden' })).toBe(false);
    expect(notifyLogOnly({ CLAUDE_PANEL_HOME: home })).toBe(false);
    expect(notifyLogOnly({ CLAUDE_PANEL_HOME: home, CLAUDE_PANEL_NOTIFY: '1' })).toBe(false);
  });

  it('默认读取 process.env', () => {
    process.env.CLAUDE_PANEL_HOME = home;
    const savedWin = process.env.CLAUDE_PANEL_WINDOW;
    process.env.CLAUDE_PANEL_WINDOW = 'inactive';
    try {
      expect(windowInactive()).toBe(true);
    } finally {
      if (savedWin === undefined) delete process.env.CLAUDE_PANEL_WINDOW;
      else process.env.CLAUDE_PANEL_WINDOW = savedWin;
    }
  });

  it('通知日志前缀非空且不含换行', () => {
    expect(NOTIFY_LOG_PREFIX.length).toBeGreaterThan(0);
    expect(NOTIFY_LOG_PREFIX).not.toMatch(/[\r\n]/);
  });
});
