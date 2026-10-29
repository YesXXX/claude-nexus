import { describe, it, expect } from 'vitest';
import { buildHookSettings, HOOKS_VERSION } from '../src/main/hook-config';

describe('buildHookSettings', () => {
  it('为 8 类事件注册 hook 命令，命令包含 hook-client 绝对路径', () => {
    const settings = buildHookSettings('D:\\app\\scripts\\hook-client.js');
    const events = Object.keys(settings.hooks);
    expect(events.sort()).toEqual([
      'Notification', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop',
      'SubagentStart', 'SubagentStop', 'UserPromptSubmit',
    ]);
    for (const ev of events) {
      expect(settings.hooks[ev]).toHaveLength(1);
      expect(settings.hooks[ev][0].hooks[0]).toEqual({
        type: 'command',
        command: 'node "D:\\app\\scripts\\hook-client.js"',
      });
    }
  });

  it('配置版本为 2，且忙碌判断依赖的两个 hook 已注册', () => {
    expect(HOOKS_VERSION).toBe(2);
    const hooks = buildHookSettings('x.js').hooks;
    expect(hooks.UserPromptSubmit).toBeDefined();
    expect(hooks.SessionStart).toBeDefined();
  });
});
