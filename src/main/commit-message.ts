import { gitOk, type GitRunner } from './git-runner';
import { cliErrorText, type CliRunner } from './cli-runner';
import { isLocalConfigPath } from './worktree-manager';

/**
 * 「请 Claude 生成」提交信息：一次性、无工具的 claude -p 调用，提示词经 stdin 传入。
 * 不加 --bare：OAuth 登录需要读取钥匙串，也需要它读取用户的 CLAUDE.md 提交规范。
 * 结果只回填到输入框，由用户检查修改后再提交。
 */

export const SUGGEST_TIMEOUT_MS = 90000;
export const MAX_DIFF_BYTES = 60 * 1024;
export const CLAUDE_PRINT_ARGS = ['-p', '--tools', '', '--no-session-persistence', '--output-format', 'text'];

export interface SuggestDeps {
  git: GitRunner;
  claude: CliRunner;
  timeoutMs?: number;
  maxDiffBytes?: number;
}

export interface SuggestResult { ok: boolean; text?: string; error?: string }

/** 按 UTF-8 字节截断，不切坏多字节字符 */
export function truncateBytes(text: string, max: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return { text, truncated: false };
  let end = max;
  // 回退到字符边界：UTF-8 续字节形如 10xxxxxx
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

export function buildSuggestPrompt(stat: string, diff: string, untracked: string[], maxBytes = MAX_DIFF_BYTES): string {
  const d = truncateBytes(diff, maxBytes);
  const parts = [
    '请根据下面的 git 改动写一条提交信息。',
    '要求：只输出提交信息本身，不要任何解释、前言或代码块；遵守本仓库的提交规范（例如 CLAUDE.md 中的约定）；',
    '没有明确规范时，主题行写成「type: 中文描述」，不超过 72 个字符，必要时空一行后写简短正文。',
    '',
    '## 改动统计（git diff HEAD --stat）',
    stat.trim() || '（无已跟踪文件的改动）',
    '',
    '## 未跟踪的新文件',
    untracked.length > 0 ? untracked.join('\n') : '（无）',
    '',
    '## 改动内容（git diff HEAD）',
    d.text.trim() || '（无）',
  ];
  if (d.truncated) parts.push('', `（diff 超过 ${Math.round(maxBytes / 1024)}KB，已截断）`);
  return parts.join('\n');
}

/** 清理 claude 输出：去掉 ANSI 序列、代码块围栏、首尾空行与行尾空白，连续空行合并为一行 */
export function cleanSuggestion(out: string): string {
  const lines = out
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(l => !/^\s*```/.test(l))
    .map(l => l.replace(/\s+$/, ''));
  const merged: string[] = [];
  for (const l of lines) {
    if (!l && (merged.length === 0 || merged[merged.length - 1] === '')) continue;
    merged.push(l);
  }
  while (merged.length > 0 && merged[merged.length - 1] === '') merged.pop();
  return merged.join('\n');
}

function notInstalled(stderr: string): boolean {
  return /not recognized as an internal or external command|不是内部或外部命令/i.test(stderr);
}

/** 在工作区根目录收集改动并调用 claude -p 生成提交信息 */
export async function suggestCommitMessage(deps: SuggestDeps, root: string): Promise<SuggestResult> {
  const { git, claude } = deps;
  const stat = await git.run(root, ['diff', 'HEAD', '--stat']);
  const diff = await git.run(root, ['diff', 'HEAD']);
  const others = await git.run(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!gitOk(stat) || !gitOk(diff)) return { ok: false, error: '读取改动失败' };
  const untracked = gitOk(others) ? others.stdout.split('\0').filter(p => p && !isLocalConfigPath(p)) : [];
  if (!stat.stdout.trim() && untracked.length === 0) return { ok: false, error: '没有未提交的改动' };

  const prompt = buildSuggestPrompt(stat.stdout, diff.stdout, untracked, deps.maxDiffBytes ?? MAX_DIFF_BYTES);
  const timeoutMs = deps.timeoutMs ?? SUGGEST_TIMEOUT_MS;
  const r = await claude.run(CLAUDE_PRINT_ARGS, { cwd: root, stdin: prompt, timeoutMs });
  if (r.notFound || (r.code !== 0 && notInstalled(r.stderr))) {
    return { ok: false, error: '未找到 claude，请确认已安装 Claude Code 并且在 PATH 中' };
  }
  if (r.timedOut) return { ok: false, error: `claude 生成超时（${Math.round(timeoutMs / 1000)} 秒）` };
  if (r.code !== 0) return { ok: false, error: `claude 执行失败：${cliErrorText('claude', r)}` };
  const text = cleanSuggestion(r.stdout);
  if (!text) return { ok: false, error: 'claude 没有返回内容' };
  return { ok: true, text };
}
