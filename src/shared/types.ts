import type { SessionUsageSummary } from './usage-types';
import type { VerifySummary } from './verify-types';
import type { SessionChangeSummary } from './session-change-types';

export type SessionStatus =
  | 'running' | 'waiting_permission' | 'waiting_input'
  | 'completed' | 'error' | 'disconnected'
  | 'suspended';   // 待续接：没有进程，等用户续接

export interface PendingAction {
  toolName: string;
  commandText: string;
}

/** 纯数据、可序列化，可通过 IPC 传给渲染层 */
export interface Session {
  id: string;
  label: string;
  cwd: string;
  status: SessionStatus;
  statusSince: number;          // 进入当前状态的时间戳（ms）
  pendingAction?: PendingAction;
  createdAt: number;
  escalated: boolean;           // 超时未处理，卡片升级高亮
  readOnly?: boolean;           // 孤儿认领会话：可监控不可代输
  exitCode?: number | null;
  claudeSessionId?: string;     // Claude 自管的当前会话 id（续接与重建子代理都靠它）
  claudeSessionIds?: string[];  // 用过的全部 Claude 会话 id（/clear、全新开始会换 id），最新在末尾，最多 20 个
  claudeTranscriptPath?: string; // hook 上报的当前对话记录路径（定位记录文件的快速路径）
  launch?: LaunchOptions;       // 启动选项（续接、全新开始时沿用）
  subagents?: SubagentEntry[];  // 该会话派生的子代理（嵌套展示；无则为空）
  worktree?: WorktreeInfo;      // 独立工作区会话才有；缺省即在原目录工作的普通会话
  changes?: ChangeSummary;      // 改动摘要（git 统计），非仓库或尚未统计时缺省
  sessionChanges?: SessionChangeSummary; // 本会话改动摘要（按 Claude 动过的文件统计），尚未统计时缺省
  usage?: SessionUsageSummary;  // 用量摘要（费用、上下文占用），用量统计关闭时缺省
  resumeFailure?: ResumeFailure; // 最近一次续接在确认前异常退出的原因（再次续接或全新开始时清除）
  restoreReason?: RestoreReason; // 待续接的原因，仅 suspended 行有值
  dormant?: boolean;            // 跨重启恢复、尚未重新拉起的行：没有进程也没有终端输出
  dormantSince?: number;        // 转入待续接 / 退出的时间（卡片「保留于」）
  turns?: number;               // 已完成轮数（来自会话记录，卡片展示用）
  busy?: boolean;               // Claude 正在处理一轮任务（提交提示词到回合结束之间）；缺省视为空闲
  pasteMode?: boolean;          // 终端输出里最近一次粘贴模式序列为开启（输入框已挂载）
  hooksVersion?: number;        // 会话 hooks 配置的版本；缺省表示升级前创建，忙碌判断不可靠
  annotations?: AnnotationSummary; // 批注摘要（待发送条数、是否有排队消息），没有批注时缺省
  pendingPrompt?: PendingPromptState; // 首条提示词等待注入或未能送达时才有
  verify?: VerifySummary;       // 最近一次自动验证的摘要，未配置或从未运行时缺省
  batchId?: string;             // 属于某个批量派发批次时才有
}

/** 首条提示词的投递状态：waiting 等 Claude 就绪；failed 未在时限内就绪，提示词保留待手动处理 */
export interface PendingPromptState {
  state: 'waiting' | 'failed';
  /** 失败原因，界面直接展示 */
  reason?: string;
}

/** 向会话输入框写入提示词的结果；失败时 reason 为可直接展示的原因 */
export interface PromptSendResult {
  ok: boolean;
  reason?: string;
}

/** 会话行上的批注摘要 */
export interface AnnotationSummary {
  pending: number;
  queued: boolean;
}

/** 续接相关设置：启动时如何处理待续接会话、退出时如何处理运行中会话、历史上限 */
export interface ResumeSettings {
  onStartup: 'auto' | 'ask' | 'never';
  onQuit: 'ask' | 'keep' | 'end';
  historyMaxCount: number;
  historyMaxDays: number;
}

/** 询问档下启动时待续接的会话；多个原因时取 crash > update > quit */
export interface RestorePrompt {
  ids: string[];
  reason: RestoreReason;
}

/** 批量续接结果 */
export interface RestoreBatchResult {
  started: string[];
  failed: { id: string; reason: string }[];
}

/** 续接失败：带 --resume 拉起后、收到 SessionStart(resume) 之前进程以非 0 退出 */
export interface ResumeFailure {
  reason: 'no_transcript' | 'exited_early';
  exitCode: number | null;
  at: number;
  detail?: string;         // 终端最后约 400 字符，已去掉控制序列
}

/** 不能续接的原因 */
export type ResumeBlockReason =
  | 'no_id'            // 从未拿到 Claude 会话 id
  | 'no_transcript'    // 对话记录不存在或为空
  | 'cwd_missing'      // 普通会话目录不存在
  | 'worktree_missing' // 工作区目录不存在
  | 'in_use'           // 另一个存活会话正在使用同一 Claude 会话 id
  | 'busy'             // 本会话进程仍存活，需 force
  | 'readonly';        // 只读认领的孤儿

/** 续接前检查的结果，message 直接给界面显示 */
export interface ResumeCheck {
  resumable: boolean;
  reason?: ResumeBlockReason;
  message: string;
  transcript: TranscriptState;
  canFresh: boolean;               // 能否全新开始（目录在且非只读）
  canRebuildWorktree?: boolean;    // 工作区目录缺失但分支仍在，可原地重建
  cwdFallback?: string;            // 工作区还在但会话所在子目录已不存在：改在这个目录（工作区根目录）启动
  canFork: boolean;                // 对话记录存在且 CLI 支持 --fork-session
  claudeSessionId?: string;
  transcriptSize?: number;         // 对话记录存在时的文件大小（字节）
  inUseBy?: { id: string; label: string };   // in_use 时占用同一对话的会话
}

export type RestartMode = 'resume' | 'fresh';

export interface RestartOptions {
  mode: RestartMode;
  force?: boolean;             // 进程仍存活时先结束再拉起
  rebuildWorktree?: boolean;   // 工作区目录缺失且分支在时先重建
}

export interface RestartResult {
  ok: boolean;
  mode?: RestartMode;
  /** unverified：接管孤儿时无法确认 pid 属于本会话，未结束任何进程 */
  reason?: ResumeBlockReason | 'spawn_failed' | 'not_found' | 'unverified';
  message?: string;
}

/** 从历史拉起：续接与全新开始沿用原面板会话 id，分叉生成新的面板会话 */
export type RecordResumeMode = RestartMode | 'fork';

export interface RecordResumeOptions {
  mode: RecordResumeMode;
  rebuildWorktree?: boolean;
}

/** sessionId 为拉起后的面板会话 id：分叉时是新会话的 id */
export interface RecordResumeResult extends Omit<RestartResult, 'mode'> {
  mode?: RecordResumeMode;
  sessionId?: string;
}

// ---- 会话记录（<panelHome>/records/<id>.json）----

/** live 正在托管或认领；exited 进程已退出但仍在列表；suspended 待续接；ended 已结束，只在历史里 */
export type RecordState = 'live' | 'exited' | 'suspended' | 'ended';
/** 转为 ended 的原因：用户结束、退出时选择结束、启动时不恢复、从旧版元数据迁移 */
export type EndReason = 'killed' | 'quit_end' | 'not_restored' | 'migrated';
/** 转为 suspended 的原因：退出时保留、面板崩溃、安装更新 */
export type RestoreReason = 'quit' | 'crash' | 'update';

/** 会话记录：只存元数据，不存对话内容。新增字段一律可选，store 写入时保留不认识的字段 */
export interface SessionRecord {
  version: 1;
  id: string;                  // 面板会话 id，与文件名一致
  label: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;           // 任何字段变化都更新
  lastActiveAt: number;        // 最近一次 hook 事件时间，用于「最近」排序
  endedAt?: number;
  state: RecordState;
  endReason?: EndReason;
  restoreReason?: RestoreReason;
  lastStatus: SessionStatus;   // 退出前最后状态
  exitCode?: number | null;
  claudeSessionId?: string;    // 当前（最新）Claude 会话 id，续接用它
  claudeSessionIds: string[];  // 历史 id，最新在末尾，最多 20 个，含当前 id
  transcriptPath?: string;     // hook 上报的最近一次对话记录路径
  launch?: LaunchOptions;
  worktree?: WorktreeInfo;
  worktreeRemoved?: boolean;   // 结束会话时工作区目录已删除
  forkedFrom?: { recordId: string; claudeSessionId: string };
  batchId?: string;            // 所属批量派发批次
  turns: number;               // 收到 Stop 的次数
  resumeCount: number;         // 成功续接次数
  lastResumeFailure?: ResumeFailure;
  firstPrompt?: string;        // 第一条提交的提示词（已截断到 2000 字符）
  lastPrompt?: string;         // 最近一条提交的提示词
  pinned?: boolean;            // 固定：不参与按条数与天数的自动清理，清空历史时可选择保留
}

/** 历史列表的结束状态分类：主动结束、异常退出、随面板退出结束、旧版迁移 */
export type EndKind = 'killed' | 'error' | 'quit' | 'migrated';

/** 历史查询条件；所有排序均为倒序 */
export interface RecordQuery {
  states?: RecordState[];        // 缺省 ['ended']
  text?: string;                 // 按空白拆词，每个词都要命中标签、提示词、目录、Claude 会话 id、工作区分支之一，不区分大小写
  endKinds?: EndKind[];          // 只要这些结束状态
  pinnedFirst?: boolean;         // 固定的记录排在前面
  cwd?: string;                  // 精确匹配（大小写不敏感、统一斜杠）
  repoRoot?: string;             // 匹配工作区 repoRoot 或 cwd 位于其下
  since?: number;                // lastActiveAt >= since
  until?: number;                // lastActiveAt <= until
  sort?: 'lastActive' | 'created' | 'ended';
  limit?: number;                // 缺省 50，上限 200
  offset?: number;
}

export interface RecordPage { items: SessionRecord[]; total: number }

/** 历史面板的概况：记录模块是否可用、启动时跳过的损坏文件数、已结束与固定条数、出现过的目录（最近在前） */
export interface HistoryMeta {
  ok: boolean;
  reason?: string;
  skipped: number;
  total: number;
  pinned: number;
  cwds: string[];
}

/** 透传给 claude 的启动选项（构建参数时按白名单校验） */
export interface LaunchOptions {
  model?: string;           // --model，只允许字母数字与 . - _ [ ]
  permissionMode?: string;  // --permission-mode，只允许字母
}

/** 对话记录文件状态：found 存在且非空；missing 不存在或为空；unknown 根目录读不了 */
export type TranscriptState = 'found' | 'missing' | 'unknown';

/** SessionStart hook 的 source：启动、续接、/clear、压缩；不认识的值归为 unknown */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact' | 'unknown';

// ---- 独立工作区与改动统计 ----

/** 面板创建的独立 git 工作区 */
export interface WorktreeInfo {
  repoRoot: string;      // 主工作区根目录
  path: string;          // 本工作区根目录（会话 cwd 可能是它下面的子目录）
  branch: string;
  baseRef: string;       // 创建时选择的基线，展示用（分支名或短 sha）
  baseCommit: string;    // 基线解析出的完整 sha，「相对基线」diff 的固定起点
}

/** working：工作区 vs HEAD（仅未提交）；base：工作区 vs 创建时的基线提交（含已提交） */
export type DiffMode = 'working' | 'base';

export type ChangeKind =
  | 'added' | 'modified' | 'deleted' | 'renamed'
  | 'untracked' | 'conflicted' | 'typechange';

export interface ChangeSummary {
  mode: DiffMode;
  files: number;
  additions: number;
  deletions: number;
  updatedAt: number;
  error?: string;        // 非仓库 / 超时等，界面直接展示
}

export interface ChangedFile {
  path: string;          // 相对工作区根，正斜杠
  oldPath?: string;      // 重命名前路径
  kind: ChangeKind;
  additions: number | null;   // 二进制或无法统计时为 null
  deletions: number | null;
  binary: boolean;
}

export interface ChangeList {
  summary: ChangeSummary;
  files: ChangedFile[];
  truncated: boolean;    // 文件数超过上限时截断
  sharedWith: number;    // 同一目录下其他存活会话数（普通会话用来提示改动来源可能混杂）
  root?: string;         // 解析出的仓库根（工作区会话为工作区根），统计失败时缺省
}

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del' | 'meta';   // meta 如「\ No newline at end of file」
  oldNo?: number;
  newNo?: number;
  text: string;
}

export interface DiffHunk { header: string; lines: DiffLine[]; }

export interface FileDiff {
  path: string;
  binary: boolean;
  truncated: boolean;    // 超过行数或字节上限时截断
  hunks: DiffHunk[];
  notUtf8?: boolean;     // 解码出现替换字符，文件可能不是 UTF-8
  error?: string;
  notice?: string;       // 显示在 diff 上方的说明（如没有改前内容、按 HEAD 对比）
  emptyText?: string;    // 没有分块时替换默认占位文案
}

export interface GitRepoInfo {
  state: 'repo' | 'not_repo' | 'no_git' | 'bare' | 'no_commit';
  repoRoot?: string;     // 主工作区根
  head?: string;         // 当前分支名，游离 HEAD 时为短 sha
  dirtyCount?: number;   // 所选目录未提交改动数（提示不会带入新工作区）
  hasSubmodules?: boolean;
  error?: string;
}

export interface WorktreeStatus { dirtyFiles: number; unmergedCommits: number; }

// ---- 终端输出导出 ----

/** rendered：按屏幕重放后的文本；plain：直接去除控制符；ansi：原始流原样写出 */
export type ExportFormat = 'rendered' | 'plain' | 'ansi';

/** canceled 为用户在保存对话框里取消；truncated 表示较早的输出已超出缓冲上限被丢弃；fallback 表示重放失败已改用 plain */
export interface ExportResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  truncated?: boolean;
  dropped?: number;
  fallback?: boolean;
  error?: string;
}

/** 结束会话的结果：删除工作区失败时说明保留原因 */
export interface KillResult {
  ok: boolean;
  kept?: 'busy' | 'unmerged' | 'error';
  message?: string;
}

/** 登记表里的工作区记录（独立于会话目录，会话被清理后仍可找回并清理） */
export interface WorktreeRecord extends WorktreeInfo {
  sessionId: string;
  label: string;
  createdAt: number;
}

// ---- 子代理（Task/Agent 工具派生的一次性代理）----

export type SubagentStatus = 'running' | 'completed' | 'aborted';

export interface SubagentEntry {
  agentId: string;         // 16 hex（hook/文件名来源；acompact 型为 acompact-<hex>）
  agentType: string;       // 'Explore' | 'general-purpose' | 'fork' | 自定义
  description?: string;    // 任务短标题：优先 meta.json，降级 jsonl 首行 prompt 截断
  transcriptPath: string;  // jsonl 绝对路径
  status: SubagentStatus;
  statusSince: number;
  lastMessage?: string;    // 末条助手文本（完成后的最终报告）
  startedAt: number;
}

/** hooks 原始 payload 的最小结构（字段全部可选，容错解析） */
export interface RawHookPayload {
  session_id?: string;
  hook_event_name?: string;
  message?: string;
  tool_name?: string;
  tool_input?: { command?: string; [k: string]: unknown };
  transcript_path?: string;    // 父会话 transcript（SubagentStart 无子 transcript 路径，需由它推导）
  cwd?: string;                // 触发 hook 时 Claude 的工作目录（工具参数里的相对路径以它为准）
  // SubagentStart/Stop 专属（容错：旧版 claude 缺这些字段不影响其余 4 类事件）
  agent_id?: string;           // 实测可能带 agent- 前缀，消费方需归一化
  agent_type?: string;
  agent_transcript_path?: string;   // 仅 SubagentStop 携带
  last_assistant_message?: string;  // 仅 SubagentStop 携带
  source?: string;                  // 仅 SessionStart 携带：startup / resume / clear / compact
  prompt?: string;                  // 仅 UserPromptSubmit 携带：用户提交的提示词
}

/** Hook Receiver 分发出来的消息 */
export interface HookMessage {
  sessionId: string;
  event: PanelEvent;
  claudeSessionId?: string;   // payload 里的 Claude 自管 sessionId（重启重建子代理用）；取不到则缺省
  transcriptPath?: string;    // payload 里的对话记录路径；取不到则缺省
}

/** 归一化后的面板事件 */
export type PanelEvent =
  | { type: 'permission_request'; toolName: string; commandText: string }
  | { type: 'tool_started'; toolName?: string; commandText?: string }   // PreToolUse（携带工具名与参数摘要，供随后的权限请求补全命令文本）
  | { type: 'tool_finished' }       // PostToolUse
  | { type: 'idle_prompt'; message?: string }  // Notification（非权限类，如空闲提醒）；message 为压平并截断后的提示文本
  | { type: 'turn_completed' }      // Stop
  | { type: 'process_exit'; code: number | null }  // PTY 退出（本地事件，非 hook）
  | { type: 'subagent_start'; raw: RawHookPayload } // SubagentStart（不归一化，直接透传给 tracker）
  | { type: 'subagent_stop'; raw: RawHookPayload } // SubagentStop（同上）
  | { type: 'session_started'; source: SessionStartSource } // SessionStart（不进状态机：拿 id、确认续接）
  | { type: 'prompt_submitted'; prompt?: string };   // UserPromptSubmit（状态推到运行中，忙碌标记置真）；prompt 已截断到 2000 字符

/** PTY 进程抽象（node-pty 的可 mock 化接口） */
export interface PtyProcess {
  write(data: string): void;
  /** immediate 为 true 时同步结束（面板退出时用，进程马上要退出，来不及等异步） */
  kill(immediate?: boolean): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  resize?(cols: number, rows: number): void;   // 让 TUI 同步终端尺寸变化
  readonly pid: number | undefined;
}

export interface PtyFactory {
  spawn(file: string, args: string[], options: { cwd: string; env: Record<string, string> }): PtyProcess;
}

// ---- 面板内 toast 通知 ----
export type NotifyLevel = 'info' | 'success' | 'warning' | 'error';

export interface NotificationPayload {
  id: string;             // 主进程生成，便于去重
  sessionId?: string;     // 关联的会话，点击 toast 跳转到对应卡片；全局通知为空，点击只唤起面板
  title: string;
  body: string;
  level: NotifyLevel;
  createdAt: number;
  /** 通知种类，供远程推送按类勾选；旧调用方（批注提示等）不填 */
  kind?: NotifyKind;
  /** 结构化信息，远程推送据此拼消息；summary 为原文，外发前由格式化模块打码截断 */
  meta?: NotifyMeta;
}

/** 等待批准、等待输入、本轮结束、正常退出、异常退出、失联、等待超时、上下文告警（budget 为沿用的旧名） */
export type NotifyKind = 'permission' | 'input' | 'turn' | 'ended' | 'error' | 'lost' | 'overdue' | 'budget';

export interface NotifyMeta {
  label?: string;
  /** 工作目录末段，不含完整路径 */
  cwdTail?: string;
  /** 状态描述，如「等待批准（Bash）」 */
  status?: string;
  toolName?: string;
  summary?: string;
}
