import type { WorktreeInfo } from '../shared/types';

/**
 * 收尾相关的提示词正文：由主进程按会话与 git 状态生成，渲染层只能选择种类，不能传入正文。
 */

function list(files: string[], max = 50): string[] {
  const shown = files.slice(0, max).map(f => `- ${f}`);
  if (files.length > max) shown.push(`- ……另有 ${files.length - max} 个文件`);
  return shown;
}

/** 解决冲突会话的提示词：会话 cwd 是主工作区，冲突发生在把工作区分支合并回基线时 */
export function conflictPrompt(info: WorktreeInfo, files: string[]): string {
  return [
    `主工作区（${info.repoRoot}）正在把分支 ${info.branch} 合并进基线分支 ${info.baseRef}，出现了冲突。冲突文件：`,
    ...list(files),
    '请按以下步骤处理：',
    '1. 逐个打开冲突文件，理解两边的改动意图后解决冲突标记，不要简单地整段保留某一边；',
    '2. 运行项目已有的构建或测试命令自检；',
    `3. 用 git add 标记这些文件已解决，再用 git commit --no-edit 完成合并。`,
    '不确定如何取舍时先停下来问我，不要猜测。',
  ].join('\n');
}

/** 让工作区会话先把基线合进来并在工作区里解决冲突，主工作区保持干净 */
export function mergeInWorktreePrompt(info: WorktreeInfo, base: string, files: string[]): string {
  const lines = [
    `准备把当前分支 ${info.branch} 合并回 ${base}，预检发现可能冲突。请先在当前工作区把 ${base} 合并进来并解决冲突：`,
    `1. 执行 git merge ${base}；`,
  ];
  if (files.length > 0) lines.push('   可能冲突的文件：', ...list(files).map(l => `   ${l}`));
  lines.push(
    '2. 逐个解决冲突，运行项目已有的构建或测试命令自检；',
    '3. git add 之后用 git commit --no-edit 完成合并。',
    '不确定如何取舍时先停下来问我，不要猜测。',
  );
  return lines.join('\n');
}

/** 让本会话自己提交未提交的改动 */
export function selfCommitPrompt(): string {
  return [
    '请检查当前工作区的未提交改动，按本仓库的提交规范写提交信息并提交。',
    '只提交与本次任务相关的文件；.claude/settings.local.json 与 CLAUDE.local.md 是本地配置，不要提交。',
    '如果有不确定是否该提交的文件，先列出来问我。',
  ].join('\n');
}
