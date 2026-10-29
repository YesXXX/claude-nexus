import { stripAnsi, tailLines } from '../shared/ansi-text';
import type { VerifyDetail } from '../shared/verify-types';

/**
 * 「发给 Claude 修复」的提示词：固定话术 + 命令 + 退出码或超时说明 + 去掉控制符的输出末尾。
 * 整段提示词按 UTF-8 不超过 maxBytes（缺省 8KB），输出末尾按剩余字节截取。
 */

export const FIX_PROMPT_MAX_BYTES = 8 * 1024;
const FIX_TAIL_MAX_LINES = 200;

function resultLine(d: VerifyDetail): string {
  if (d.status === 'timeout') return d.message ?? '超时';
  return `退出码 ${d.exitCode ?? '未知'}`;
}

export function buildVerifyFixPrompt(d: VerifyDetail, maxBytes = FIX_PROMPT_MAX_BYTES): string {
  const head = [
    '自动验证没有通过，请根据下面的输出找出原因并修复。',
    `验证命令：${d.command}`,
    `结果：${resultLine(d)}`,
    '输出末尾（已去掉颜色控制符）：',
    '```',
  ].join('\n');
  const foot = '```\n修复后说明改了什么；面板会在这一轮结束后自动重新验证。';
  const budget = maxBytes - Buffer.byteLength(`${head}\n\n${foot}`, 'utf8');
  const plain = stripAnsi(d.output).replace(/```/g, "'''");
  const tail = budget > 0 ? tailLines(plain, FIX_TAIL_MAX_LINES, budget) : '';
  return `${head}\n${tail || '（没有输出）'}\n${foot}`;
}
