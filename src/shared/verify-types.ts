/**
 * 每轮自动验证：配置、状态与结果的数据结构，主进程与渲染层共用。
 * 配置按仓库存放在面板目录的 verify.json，不读写用户仓库里的任何文件。
 */

/** 单个仓库的验证配置；工作区会话共用主仓库的配置 */
export interface VerifyConfig {
  command: string;
  enabled: boolean;
  /** 超时秒数，10～3600，缺省 300 */
  timeoutSec: number;
  /** 两轮之间工作区没有变化时跳过，沿用上次结果；缺省开启 */
  skipUnchanged: boolean;
  /** 准备命令（如 npm ci），每个会话第一次验证前执行一次 */
  setupCommand?: string;
  /** 准备命令的超时秒数，缺省 900 */
  setupTimeoutSec?: number;
}

/** 全局设置：并发上限 1～4，失败时是否发系统通知 */
export interface VerifyGlobal {
  maxConcurrent: number;
  notifyOnFail: boolean;
}

/**
 * queued 排队等并发名额；running 执行中（含准备命令）；passed 退出码 0；failed 非 0；
 * timeout 超时被终止；cancelled 被新一轮或会话结束打断；error 命令无法启动或准备命令失败。
 */
export type VerifyStatus = 'queued' | 'running' | 'passed' | 'failed' | 'timeout' | 'cancelled' | 'error';

/** 会话最近一次验证的摘要，合并进会话数据推给渲染层 */
export interface VerifySummary {
  status: VerifyStatus;
  command: string;
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  exitCode?: number | null;
  /** 排队时前面还有几个 */
  queuePosition?: number;
  /** 工作区未变化，沿用上次结果（status 为上次的结果） */
  reused?: boolean;
  /** 开始时同目录还有几个其他会话在运行，结果可能受影响 */
  interfered?: number;
  /** 当前或最近一次是否在执行准备命令 */
  setup?: boolean;
  /** 错误、取消或超时的说明，界面直接展示 */
  message?: string;
}

/** 验证输出详情：output 已解码、保留 ANSI，过长时只保留头尾 */
export interface VerifyDetail extends VerifySummary {
  output: string;
  /** 头尾之间省略的字节数（按原始输出计） */
  omittedBytes: number;
  /** 输出解码所用的编码 */
  encoding?: 'utf-8' | 'gbk';
  /** 完整日志文件，可用外部程序打开 */
  logFile?: string;
}

/** 配置对话框所需：仓库键（写回时原样带上）、展示用的仓库路径、当前配置与全局设置 */
export interface VerifyConfigView {
  repoKey: string;
  repoRoot: string;
  /** 是否为 git 仓库；非仓库时按会话目录单独配置 */
  isRepo: boolean;
  config: VerifyConfig | null;
  global: VerifyGlobal;
}

/** 手动运行、取消、发送等操作的结果；失败时 reason 可直接展示 */
export interface VerifyActionResult {
  ok: boolean;
  reason?: string;
}

export const VERIFY_TIMEOUT_DEFAULT = 300;
export const VERIFY_TIMEOUT_MIN = 10;
export const VERIFY_TIMEOUT_MAX = 3600;
export const VERIFY_SETUP_TIMEOUT_DEFAULT = 900;
export const VERIFY_COMMAND_MAX = 2000;
export const VERIFY_CONCURRENCY_MIN = 1;
export const VERIFY_CONCURRENCY_MAX = 4;
export const DEFAULT_VERIFY_GLOBAL: VerifyGlobal = { maxConcurrent: 2, notifyOnFail: true };

/** 验证已结束（有确定结果） */
export function isVerifyFinal(status: VerifyStatus): boolean {
  return status !== 'queued' && status !== 'running';
}

/** 未通过时的一句话说明（系统通知正文、提示用） */
export function verifyFailText(s: VerifySummary): string {
  const parts: string[] = [];
  if (s.status === 'failed') parts.push(`退出码 ${s.exitCode ?? '未知'}`);
  else if (s.message) parts.push(s.message);
  if (s.durationMs !== undefined) parts.push(`用时 ${Math.max(1, Math.round(s.durationMs / 1000))} 秒`);
  parts.push(s.command);
  return parts.join(' · ');
}

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 校验并规范化配置：命令去首尾空白后非空且不超过上限、不含换行；超时夹到合法范围；
 * 准备命令可缺省。返回规范化后的配置或第一处错误。
 */
export function sanitizeVerifyConfig(v: unknown): { ok: true; value: VerifyConfig } | { ok: false; error: string } {
  if (!v || typeof v !== 'object') return { ok: false, error: '参数无效' };
  const o = v as Record<string, unknown>;
  const command = typeof o.command === 'string' ? o.command.trim() : '';
  const setup = typeof o.setupCommand === 'string' ? o.setupCommand.trim() : '';
  if (!command) return { ok: false, error: '验证命令不能为空' };
  if (command.length > VERIFY_COMMAND_MAX || setup.length > VERIFY_COMMAND_MAX) {
    return { ok: false, error: `命令过长（上限 ${VERIFY_COMMAND_MAX} 字）` };
  }
  if (/[\r\n]/.test(command) || /[\r\n]/.test(setup)) return { ok: false, error: '命令只能写一行，多条命令请用 && 连接' };
  const value: VerifyConfig = {
    command,
    enabled: o.enabled !== false,
    timeoutSec: clampInt(o.timeoutSec, VERIFY_TIMEOUT_MIN, VERIFY_TIMEOUT_MAX, VERIFY_TIMEOUT_DEFAULT),
    skipUnchanged: o.skipUnchanged !== false,
  };
  if (setup) {
    value.setupCommand = setup;
    value.setupTimeoutSec = clampInt(o.setupTimeoutSec, VERIFY_TIMEOUT_MIN, VERIFY_TIMEOUT_MAX, VERIFY_SETUP_TIMEOUT_DEFAULT);
  }
  return { ok: true, value };
}

/** 规范化全局设置，非法值取缺省 */
export function sanitizeVerifyGlobal(v: unknown): VerifyGlobal {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    maxConcurrent: clampInt(o.maxConcurrent, VERIFY_CONCURRENCY_MIN, VERIFY_CONCURRENCY_MAX, DEFAULT_VERIFY_GLOBAL.maxConcurrent),
    notifyOnFail: typeof o.notifyOnFail === 'boolean' ? o.notifyOnFail : DEFAULT_VERIFY_GLOBAL.notifyOnFail,
  };
}
