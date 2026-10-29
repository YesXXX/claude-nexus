import type { ChangeKind, DiffMode, FileDiff } from '../../../shared/types';
import type { ChangesScope } from '../../core/changes-ext.js';

/** 改动视图的文案与格式化：变更类型徽标、口径说明、时间与路径拆分、错误文案映射 */

export const KIND_BADGE: Record<ChangeKind, { letter: string; title: string }> = {
  modified: { letter: 'M', title: '已修改' },
  added: { letter: 'A', title: '新增' },
  deleted: { letter: 'D', title: '已删除' },
  renamed: { letter: 'R', title: '重命名' },
  untracked: { letter: '?', title: '未跟踪' },
  conflicted: { letter: 'U', title: '冲突' },
  typechange: { letter: 'T', title: '类型变化（如文件与符号链接互换）' },
};

export const MODE_TIPS: Record<DiffMode, string> = {
  base: '相对基线：本工作区从基线提交创建以来的全部改动，包含已提交的内容',
  working: '仅未提交：工作区与 HEAD 的差异，不含已提交的内容',
};

export const SCOPE_TIPS: Record<ChangesScope, string> = {
  session: '本会话改动：Claude 在这个会话里动过的所有文件，跨仓库、非 git 目录也会列出',
  repo: '仓库视角：工作目录所在 git 仓库的全部改动，可能包含会话之外的修改',
};

/** 仓库根目录与相对路径拼成完整地址，分隔符跟随根目录的写法 */
export function joinAddress(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  const head = root.endsWith(sep) ? root.slice(0, -1) : root;
  return `${head}${sep}${rel.split('/').join(sep)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function clock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function splitPath(p: string): { name: string; dir: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { name: p, dir: '' } : { name: p.slice(i + 1), dir: p.slice(0, i) };
}

/** diff 里第一个有新侧行号的行号：配置了外部编辑器时「打开」按钮用它直接落到改动开头 */
export function firstHunkLine(d: FileDiff | undefined): number | undefined {
  for (const h of d?.hunks ?? []) {
    for (const l of h.lines) {
      if (l.newNo !== undefined) return l.newNo;
    }
  }
  return undefined;
}

/** 把 git 侧的错误文本转换成界面提示；超时单独标记，界面给出重试按钮 */
export function describeError(raw: string): { text: string; retry: 'timeout' | 'plain' | 'none' } {
  if (raw.includes('不是 git 仓库')) return { text: '该目录不是 git 仓库，无法统计改动', retry: 'none' };
  if (raw.includes('未检测到 git') || /\bgit\b.*(not found|ENOENT|找不到|未找到)/i.test(raw)) {
    return { text: '未检测到 git', retry: 'none' };
  }
  if (raw.includes('超时')) return { text: '统计超时，点击重试', retry: 'timeout' };
  return { text: raw, retry: 'plain' };
}
