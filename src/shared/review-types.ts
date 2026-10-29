import type { DiffMode } from './types';

/**
 * 改动批注、发件箱、工作区收尾与撤销文件的共享类型。主进程、preload 与渲染层共用，纯类型、无运行时代码。
 */

// ---------------- 批注 ----------------

/** new：锚在新文件行号；old：只选了删除行；file：整个文件 */
export type AnnotationSide = 'new' | 'old' | 'file';
export type AnnotationStatus = 'pending' | 'queued' | 'sent';
export type AnnotationValidity = 'valid' | 'moved' | 'stale' | 'unchecked';

export interface Annotation {
  id: string;
  /** 相对仓库根，正斜杠 */
  path: string;
  /** 重命名文件的旧路径 */
  oldPath?: string;
  /** 创建时的口径 */
  mode: DiffMode;
  /** 旧侧所对应的提交：仅未提交为当时 HEAD，相对基线为 baseCommit；空仓库为空串 */
  refSha: string;
  side: AnnotationSide;
  /** side=file 时为 0 */
  start: number;
  end: number;
  /** diff 原样行，含 '+' / '-' / ' ' 前缀，最多 200 行 */
  lines: string[];
  hunkHeader?: string;
  /** 1..4000 字 */
  comment: string;
  status: AnnotationStatus;
  createdAt: number;
  updatedAt: number;
  sentAt?: number;
}

export interface AnnotationCheck {
  id: string;
  validity: AnnotationValidity;
  /** validity=moved 时新的起始行 */
  movedTo?: number;
  /** stale / unchecked 的说明 */
  reason?: string;
}

export interface AnnotationList {
  items: Annotation[];
  checks: AnnotationCheck[];
  /** 本会话正在排队的消息 */
  outbox?: OutboxItem;
}

export interface AnnotationDraft {
  path: string;
  side: AnnotationSide;
  /** side 不是 file 时必填，与 fromLine/toLine 一起在主进程重新取 diff 校验 */
  hunkIndex?: number;
  /** 分块内行序号（含首尾） */
  fromLine?: number;
  toLine?: number;
  comment: string;
  mode?: DiffMode;
}

export interface AnnotationPreview {
  text: string;
  truncated: boolean;
  /** 本次会包含的条数 */
  count: number;
  /** 因长度限制未包含的条数 */
  omitted: number;
  /** 行号可能已变化的条数 */
  stale: number;
  /** 不能发送的原因（只读、已退出等）；有值时只能复制 */
  blocked?: string;
  busy: boolean;
  /** 会话是否处于等待权限 */
  waitingPermission: boolean;
  pasteMode: boolean;
  /** 已有排队消息时不能再发 */
  queued: boolean;
}

// ---------------- 发件箱 ----------------

export type OutboxReason = 'annotations' | 'conflict' | 'commit' | 'merge-in-worktree' | 'prompt';
export type OutboxWhen = 'now' | 'queue' | 'auto';

export interface OutboxItem {
  id: string;
  sessionId: string;
  reason: OutboxReason;
  /** 已清洗、已截断的最终正文 */
  text: string;
  annotationIds: string[];
  createdAt: number;
  /** ready：新建会话，等 SessionStart + 粘贴模式 + 输出静默 */
  waitFor: 'idle' | 'ready';
  /** ready 模式的超时时刻 */
  deadline?: number;
}

export interface SendResult {
  ok: boolean;
  /** true 已写入 pty；false 已排队或失败 */
  sent: boolean;
  queued: boolean;
  /** 给 toast 的可读文本 */
  message: string;
  /** 未检测到粘贴模式 */
  warnPasteMode?: boolean;
  /** auto 模式下会话正忙，需要用户选择排队或立即发送 */
  needChoice?: 'busy' | 'permission';
}

// ---------------- 命令记录与 git 写操作 ----------------

export interface CommandRecord {
  /** 显示用命令行，参数含空格时加引号，仅供阅读 */
  display: string;
  cwd: string;
  /** -1 找不到程序，-2 超时 */
  code: number;
  ms: number;
  /** 各截到 64KB */
  stdout: string;
  stderr: string;
  ok: boolean;
  at: number;
}

export interface GitOpResult {
  ok: boolean;
  /** 结论一句话 */
  message: string;
  /** stderr 首个非空行，或可复制的命令 */
  detail?: string;
  steps: CommandRecord[];
  conflicts?: string[];
  /** PR 链接或比较页 */
  url?: string;
  /** 失败后发现的残留锁文件 */
  lockFile?: string;
  /** 主进程复查后需要再确认 */
  needConfirm?: 'busy' | 'overwrite' | 'large';
}

// ---------------- 收尾 ----------------

export type GitInProgress = 'merge' | 'rebase' | 'cherry-pick';

export interface FinishRemote {
  name: string;
  /** 已去凭据 */
  url: string;
  /** 可生成比较页时的网页地址 */
  web?: string;
}

export interface FinishStatus {
  sessionId: string;
  branch: string;
  /** 工作区分支是否还存在 */
  branchExists: boolean;
  baseRef: string;
  baseIsBranch: boolean;
  /** 分支领先基线分支（或 baseCommit） */
  ahead: number;
  behind: number;
  /** 不含面板复制的本地配置 */
  dirty: number;
  dirtyFiles: string[];
  inProgress?: GitInProgress;
  upstream?: { name: string; ahead: number; behind: number };
  remotes: FinishRemote[];
  main: {
    path: string;
    /** 主工作区当前分支，分离头指针时缺省 */
    branch?: string;
    clean: boolean;
    dirtyCount: number;
    inProgress?: GitInProgress;
    /** 主工作区里正忙的其他会话标签 */
    busySessions: string[];
  };
  precheck?: { state: 'clean' | 'conflict' | 'unknown' | 'nothing'; files: string[] };
  gh: { state: 'ok' | 'missing' | 'unauthed' | 'unknown'; host?: string };
  /** 默认 PR 标题（最近一条提交主题）与说明（提交列表） */
  prTitle: string;
  prBody: string;
  readOnly: boolean;
  busy: boolean;
  checkedAt: number;
}

export interface FinishCommitOptions { noVerify?: boolean; force?: boolean }
export interface FinishMergeOptions { ffOnly?: boolean; message?: string; force?: boolean }
export interface FinishPrOptions { remote: string; title: string; body: string; pushFirst: boolean }

// ---------------- 撤销 ----------------

export interface RevertEntry {
  /** 备份目录名 */
  id: string;
  sessionId: string;
  paths: string[];
  mode: DiffMode;
  at: number;
  /** 文件过大未备份时为 false */
  restorable: boolean;
  /** session 为「本会话改动」里的撤销，paths 是完整文件地址 */
  scope?: 'session';
}

export interface RevertOptions { force?: boolean; large?: boolean }

export interface RevertPlan {
  /** 将执行的命令（显示用），未跟踪文件为删除说明 */
  command: string;
  paths: string[];
  /** 恢复到的提交短 sha；未跟踪删除时为空 */
  source: string;
  untracked: boolean;
  /** 超过备份上限的文件大小（字节），未超过为 0 */
  largeBytes: number;
  /** 不能撤销的原因 */
  blocked?: string;
  busy: boolean;
}
