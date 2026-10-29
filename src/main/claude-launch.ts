import type { LaunchOptions } from '../shared/types';
import type { CliCapabilities } from './cli-capabilities';

/**
 * claude 启动参数与子进程环境的纯函数构建。
 * Windows 上参数要经过 `cmd.exe /c claude.cmd`，所以这里只产出白名单字符：
 * id 走 UUID 校验，标签走字符白名单，模型名与权限模式走正则，
 * 任何 shell 元字符（& | < > ^ % " ! 换行）都不会到达命令行。
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export const NAME_MAX = 60;
const MODEL_RE = /^[\w.\-[\]]+$/;
const PERMISSION_MODE_RE = /^[A-Za-z]+$/;

/** 标签 → --name 值：只留字母、数字、汉字、空格与 -_.()（），其余替换为空格，折叠空白后截断；结果可能为空串 */
export function sanitizeName(label: string | undefined): string {
  if (!label) return '';
  const cleaned = label
    .replace(/[^\p{L}\p{N} \-_.()（）]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...cleaned].slice(0, NAME_MAX).join('').trim();
}

/** 启动选项校验：不合规的字段直接丢弃，返回值只含合法字段；全部丢弃时返回 undefined */
export function sanitizeLaunch(opts: LaunchOptions | undefined): LaunchOptions | undefined {
  if (!opts) return undefined;
  const out: LaunchOptions = {};
  if (typeof opts.model === 'string' && MODEL_RE.test(opts.model)) out.model = opts.model;
  if (typeof opts.permissionMode === 'string' && PERMISSION_MODE_RE.test(opts.permissionMode)) {
    out.permissionMode = opts.permissionMode;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface ClaudeLaunchInput {
  /** 会话专属 hooks 配置文件路径（面板生成，--settings 传入） */
  settingsPath: string;
  caps: CliCapabilities;
  /** 新建会话时预分配的 Claude 会话 id；分叉时可作为新对话的 id */
  sessionId?: string;
  /** 要续接的 Claude 会话 id */
  resumeId?: string;
  /** 与 resumeId 合用：读取原对话后以新 id 继续，原对话不受影响 */
  forkSession?: boolean;
  /** 面板标签，内部做 sanitizeName，CLI 的 /resume 选择器里显示 */
  name?: string;
  model?: string;
  permissionMode?: string;
  /**
   * 首条提示词。永远不进命令行参数：多行与特殊字符无法安全经过 cmd.exe，
   * 由调用方在 CLI 就绪后以 bracketed paste 注入终端。这里只占位，buildClaudeArgs 会忽略它。
   */
  prompt?: string;
}

/**
 * 构建 claude 参数（不含 `cmd.exe /c claude.cmd` 前缀）。
 * - 新建：`--settings p [--session-id id]`（CLI 支持时才预分配）
 * - 续接：`--settings p --resume id`
 * - 分叉：`--settings p --resume id --fork-session [--session-id 新id]`
 * 之后按能力追加 `--name`，再追加合法的 `--model` / `--permission-mode`。
 * 非法 id、CLI 不支持的续接或分叉、续接时又指定新 id 都直接抛错：这些是调用方的逻辑错误。
 */
export function buildClaudeArgs(i: ClaudeLaunchInput): string[] {
  const args = ['--settings', i.settingsPath];
  const caps = i.caps;
  if (i.resumeId !== undefined) {
    if (!isUuid(i.resumeId)) throw new Error(`续接 id 不是合法 UUID：${String(i.resumeId)}`);
    if (!caps.resume) throw new Error('当前 claude 版本不支持 --resume');
    args.push('--resume', i.resumeId);
    if (i.forkSession) {
      if (!caps.forkSession) throw new Error('当前 claude 版本不支持 --fork-session');
      args.push('--fork-session');
    } else if (i.sessionId !== undefined) {
      throw new Error('续接原对话时不能指定新的会话 id');
    }
  } else if (i.forkSession) {
    throw new Error('分叉必须指定要续接的会话 id');
  }
  if (i.sessionId !== undefined) {
    if (!isUuid(i.sessionId)) throw new Error(`会话 id 不是合法 UUID：${String(i.sessionId)}`);
    if (caps.sessionId) args.push('--session-id', i.sessionId);
  }
  if (caps.name) {
    const name = sanitizeName(i.name);
    if (name) args.push('--name', name);
  }
  const launch = sanitizeLaunch({ model: i.model, permissionMode: i.permissionMode });
  if (launch?.model) args.push('--model', launch.model);
  if (launch?.permissionMode) args.push('--permission-mode', launch.permissionMode);
  return args;
}

/**
 * 从父进程继承、必须剥离的 Claude Code 父子进程标记变量。
 * 面板若是从 Claude Code 内启动的，这些变量会让托管的 claude 以为自己是子会话（不保存对话记录等）。
 * CLAUDE_PANEL_SESSION_ID 来自上层面板，由本面板按当前会话重新注入。
 * 用户配置类变量（ANTHROPIC_*、CLAUDE_EFFORT、CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC、CLAUDE_CODE_GIT_BASH_PATH 等）不在此列。
 */
export const INHERITED_CLAUDE_ENV: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
  'CLAUDE_PANEL_SESSION_ID',
];

const STRIP_SET = new Set(INHERITED_CLAUDE_ENV.map(k => k.toUpperCase()));

/**
 * 生成托管 claude 的环境变量：复制 base，去掉值为 undefined 的项与父子进程标记
 * （Windows 环境变量名不区分大小写，按大写比较），再注入当前面板会话 id。
 */
export function sanitizeChildEnv(
  base: Record<string, string | undefined>,
  panelSessionId?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (STRIP_SET.has(k.toUpperCase())) continue;
    out[k] = v;
  }
  if (panelSessionId) out.CLAUDE_PANEL_SESSION_ID = panelSessionId;
  return out;
}
