/**
 * 生成会话专属的 Claude Code --settings 配置（hooks 指向本面板的 hook-client）。
 * 各 hook 由 CLI 独立执行，用户自己配置的其他 hook 报错不影响这里的上报；
 * hook-client 不向 stdout 输出任何内容（SessionStart / UserPromptSubmit 的 stdout 会被当作上下文注入），且总以 0 退出。
 */
import { HOOKS_VERSION } from '../shared/status-engine';

/** 配置版本随 hook 注册项变化递增，写入会话 metadata，用来识别升级前创建、缺少新 hook 的会话 */
export { HOOKS_VERSION };

export interface HookSettings {
  hooks: Record<string, Array<{
    matcher: string;
    hooks: Array<{ type: 'command'; command: string }>;
  }>>;
}

export function buildHookSettings(hookClientPath: string): HookSettings {
  const command = `node "${hookClientPath}"`;
  const entry = [{ matcher: '', hooks: [{ type: 'command' as const, command }] }];
  return {
    hooks: {
      Notification: entry,
      PreToolUse: entry,
      PostToolUse: entry,
      Stop: entry,
      // 子代理生命周期：面板分流给 SubagentTracker（不参与会话状态机）
      SubagentStart: entry,
      SubagentStop: entry,
      // 启动、续接、/clear、压缩时触发：即时拿到 Claude 会话 id、确认续接结果，也是新会话就绪的信号之一（不改变状态）
      SessionStart: entry,
      // 用户提交提示词：状态推到运行中、忙碌标记置真，同时记轮次与活跃时间
      UserPromptSubmit: entry,
    },
  };
}
