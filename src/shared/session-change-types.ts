import type { ChangedFile } from './types';

/**
 * 本会话改动：按 Claude 实际动过的文件统计，与仓库、分支无关。
 * 改前内容来自工具执行前的快照，或 Bash 执行前后 git 状态的对比；非 git 目录里 Bash 造成的改动只有路径。
 */

/** tool：Edit / Write 等文件工具；bash：Bash 执行期间推断出的改动 */
export type ChangeSource = 'tool' | 'bash';

/**
 * 对比基准：exact 为改前快照（可撤销）；head 为改前已有未提交改动，按 HEAD 版本对比（不可撤销）；
 * none 为没有改前内容，只能看当前内容（不可撤销）
 */
export type BaselineKind = 'exact' | 'head' | 'none';

export interface SessionChangedFile extends ChangedFile {
  /** 列表内唯一键：绝对路径，正斜杠 */
  path: string;
  /** 完整文件地址（系统分隔符），界面展示与复制用 */
  abs: string;
  /** 分组根目录（git 仓库根，或工作目录 / 所在目录），系统分隔符 */
  root: string;
  /** 相对分组根目录的路径，正斜杠 */
  rel: string;
  /** 分组根目录是 git 仓库 */
  repo: boolean;
  /** 不在会话工作目录（工作区会话为工作区根目录）之下 */
  outside: boolean;
  source: ChangeSource;
  baseline: BaselineKind;
  /** 改过它的工具名，按首次出现排序 */
  tools: string[];
  /** Claude 最近一次编辑之后，文件又被改过 */
  external?: boolean;
  /** 改前内容超过备份上限未保存：不能对比与撤销 */
  tooLarge?: boolean;
}

export interface SessionChangeRoot {
  root: string;
  repo: boolean;
  outside: boolean;
  files: number;
}

export interface SessionChangeSummary {
  files: number;
  additions: number;
  deletions: number;
  /** 涉及的分组根目录数 */
  roots: number;
  updatedAt: number;
  error?: string;
}

export interface SessionChangeList {
  summary: SessionChangeSummary;
  files: SessionChangedFile[];
  roots: SessionChangeRoot[];
  truncated: boolean;
  /** 会话工作目录（工作区会话为工作区根目录） */
  cwd: string;
}
