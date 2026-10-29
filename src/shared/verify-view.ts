import type { VerifySummary } from './verify-types';

/**
 * 验证摘要的展示规则：会话行徽标与属性面板共用，纯函数、不依赖 DOM。
 */

export interface VerifyBadgeView {
  /** 徽标字符 */
  icon: string;
  /** 附加在 verify-badge 上的状态类 */
  cls: string;
  /** 悬停提示 */
  title: string;
  /** 简短状态文字（属性面板用） */
  text: string;
}

function secs(ms: number): number {
  return Math.max(0, Math.round(ms / 1000));
}

/** 用时文字：不足 1 分钟按秒，否则「m 分 s 秒」 */
export function fmtVerifyDuration(ms: number): string {
  const s = secs(ms);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** 徽标外观；now 用于计算运行中的已用时间 */
export function verifyBadge(v: VerifySummary, now: number = Date.now()): VerifyBadgeView {
  const dur = v.durationMs !== undefined ? fmtVerifyDuration(v.durationMs) : '';
  const interfered = v.interfered ? `\n验证期间另有 ${v.interfered} 个会话在此目录工作，结果可能受影响` : '';
  const reused = v.reused ? '（未变化，沿用上次结果）' : '';
  switch (v.status) {
    case 'queued': {
      const ahead = v.queuePosition ?? 0;
      return {
        icon: '⧗', cls: 'queued', text: '排队中',
        title: `排队中（前面还有 ${ahead} 个）\n${v.command}`,
      };
    }
    case 'running': {
      const ran = v.startedAt !== undefined ? ` · 已运行 ${fmtVerifyDuration(now - v.startedAt)}` : '';
      return {
        icon: '◌', cls: 'running', text: v.setup ? '准备中' : '验证中',
        title: `${v.setup ? '执行准备命令' : '验证中'}${ran}\n${v.command}${interfered}`,
      };
    }
    case 'passed':
      return {
        icon: '✓', cls: `passed${v.reused ? ' reused' : ''}`, text: `通过${reused}`,
        title: `通过${reused}${dur ? ` · 用时 ${dur}` : ''}\n${v.command}${interfered}`,
      };
    case 'failed':
      return {
        icon: '✕', cls: `failed${v.reused ? ' reused' : ''}`, text: `失败（退出码 ${v.exitCode ?? '未知'}）${reused}`,
        title: `失败（退出码 ${v.exitCode ?? '未知'}）${reused}${dur ? ` · 用时 ${dur}` : ''} · 点击查看输出\n${v.command}${interfered}`,
      };
    case 'timeout':
      return {
        icon: '⏱', cls: `timeout${v.reused ? ' reused' : ''}`, text: `超时${reused}`,
        title: `${v.message ?? '超时'}${reused} · 点击查看输出\n${v.command}`,
      };
    case 'cancelled':
      return {
        icon: '–', cls: 'cancelled', text: '已取消',
        title: `已取消${v.message ? `（${v.message}）` : ''}\n${v.command}`,
      };
    case 'error':
    default:
      return {
        icon: '!', cls: 'error', text: '出错',
        title: `${v.message ?? '验证出错'}\n${v.command}`,
      };
  }
}

/** 结果是否可以发给 Claude 修复：失败或超时 */
export function verifyFixable(v: VerifySummary | undefined): boolean {
  return !!v && (v.status === 'failed' || v.status === 'timeout');
}
