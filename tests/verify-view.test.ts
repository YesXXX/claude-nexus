import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined }, shell: {} }));

import { buildVerifyFixPrompt, FIX_PROMPT_MAX_BYTES } from '../src/main/verify-prompt';
import { fixBlockReason } from '../src/main/ipc-verify';
import { fmtVerifyDuration, verifyBadge, verifyFixable } from '../src/shared/verify-view';
import type { Session } from '../src/shared/types';
import type { VerifyDetail, VerifySummary } from '../src/shared/verify-types';

function session(p: Partial<Session> = {}): Session {
  return {
    id: 's1', label: 'L', cwd: 'D:/x', status: 'completed', statusSince: 0, createdAt: 0, escalated: false,
    busy: false, hooksVersion: 2, pasteMode: true, ...p,
  } as Session;
}

function detail(p: Partial<VerifyDetail> = {}): VerifyDetail {
  return { status: 'failed', command: 'npm test', exitCode: 1, output: '', omittedBytes: 0, ...p };
}

describe('fmtVerifyDuration', () => {
  it('不足一分钟按秒，否则分秒', () => {
    expect(fmtVerifyDuration(0)).toBe('0 秒');
    expect(fmtVerifyDuration(1400)).toBe('1 秒');
    expect(fmtVerifyDuration(59_000)).toBe('59 秒');
    expect(fmtVerifyDuration(125_000)).toBe('2 分 5 秒');
  });
});

describe('verifyBadge', () => {
  const base: VerifySummary = { status: 'passed', command: 'npm test' };

  it('各状态的图标与类名', () => {
    const cases: Array<[VerifySummary['status'], string, string]> = [
      ['queued', '⧗', 'queued'], ['running', '◌', 'running'], ['passed', '✓', 'passed'], ['failed', '✕', 'failed'],
      ['timeout', '⏱', 'timeout'], ['cancelled', '–', 'cancelled'], ['error', '!', 'error'],
    ];
    for (const [status, icon, cls] of cases) {
      const v = verifyBadge({ ...base, status });
      expect(v.icon).toBe(icon);
      expect(v.cls).toBe(cls);
      expect(v.title).toContain('npm test');
    }
  });

  it('排队显示前面的个数', () => {
    expect(verifyBadge({ ...base, status: 'queued', queuePosition: 2 }).title).toContain('前面还有 2 个');
  });

  it('运行中区分准备命令并显示已运行时间', () => {
    const v = verifyBadge({ ...base, status: 'running', startedAt: 1000, setup: true }, 6000);
    expect(v.text).toBe('准备中');
    expect(v.title).toContain('已运行 5 秒');
    expect(verifyBadge({ ...base, status: 'running' }).text).toBe('验证中');
  });

  it('失败带退出码与用时，沿用上次结果有标注', () => {
    const v = verifyBadge({ ...base, status: 'failed', exitCode: 2, durationMs: 3000, reused: true });
    expect(v.text).toBe('失败（退出码 2）（未变化，沿用上次结果）');
    expect(v.cls).toBe('failed reused');
    expect(v.title).toContain('用时 3 秒');
    expect(verifyBadge({ ...base, reused: true }).text).toBe('通过（未变化，沿用上次结果）');
  });

  it('同目录干扰提示与取消原因', () => {
    expect(verifyBadge({ ...base, interfered: 1 }).title).toContain('另有 1 个会话在此目录工作');
    expect(verifyBadge({ ...base, status: 'cancelled', message: 'Claude 开始了新一轮' }).title)
      .toContain('已取消（Claude 开始了新一轮）');
    expect(verifyBadge({ ...base, status: 'error', message: '准备命令失败' }).title).toContain('准备命令失败');
  });

  it('只有失败与超时可以修复', () => {
    expect(verifyFixable(undefined)).toBe(false);
    expect(verifyFixable({ ...base, status: 'failed' })).toBe(true);
    expect(verifyFixable({ ...base, status: 'timeout' })).toBe(true);
    for (const s of ['passed', 'queued', 'running', 'cancelled', 'error'] as const) {
      expect(verifyFixable({ ...base, status: s })).toBe(false);
    }
  });
});

describe('buildVerifyFixPrompt', () => {
  it('包含命令、退出码，去掉控制符并替换代码围栏', () => {
    const p = buildVerifyFixPrompt(detail({ output: '\x1b[31mFAIL\x1b[0m a.test.ts\n```x```\n' }));
    expect(p).toContain('验证命令：npm test');
    expect(p).toContain('结果：退出码 1');
    expect(p).toContain('FAIL a.test.ts');
    expect(p).not.toContain('\x1b');
    expect(p.split('```').length - 1).toBe(2);
    expect(p).toContain("'''x'''");
  });

  it('超时用说明文字，空输出给出占位', () => {
    const p = buildVerifyFixPrompt(detail({ status: 'timeout', exitCode: null, message: '超过 300 秒被终止' }));
    expect(p).toContain('结果：超过 300 秒被终止');
    expect(p).toContain('（没有输出）');
  });

  it('长输出截到 8KB 以内并保留末尾', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `第 ${i} 行 错误详情 error detail`);
    const p = buildVerifyFixPrompt(detail({ output: lines.join('\n') }));
    expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(FIX_PROMPT_MAX_BYTES);
    expect(p).toContain('第 4999 行');
    expect(p).not.toContain('第 0 行 ');
    expect(p.endsWith('面板会在这一轮结束后自动重新验证。')).toBe(true);
  });

  it('预算极小时仍不超限', () => {
    const p = buildVerifyFixPrompt(detail({ output: 'x'.repeat(1000) }), 400);
    expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(400);
  });
});

describe('fixBlockReason', () => {
  it('依次检查会话、结果、只读与忙碌', () => {
    expect(fixBlockReason(undefined, detail())).toBe('会话不存在');
    expect(fixBlockReason(session(), undefined)).toContain('没有失败');
    expect(fixBlockReason(session(), detail({ status: 'passed' }))).toContain('没有失败');
    expect(fixBlockReason(session({ readOnly: true }), detail())).toBe('只读会话不能代输');
    expect(fixBlockReason(session({ busy: true }), detail())).toContain('Claude 正忙');
    expect(fixBlockReason(session({ status: 'running' }), detail())).toContain('Claude 正忙');
    expect(fixBlockReason(session(), detail())).toBeUndefined();
    expect(fixBlockReason(session({ status: 'waiting_input' }), detail({ status: 'timeout' }))).toBeUndefined();
  });
});
