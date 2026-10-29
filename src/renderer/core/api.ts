import type {
  ChangeList, DiffMode, ExportFormat, ExportResult, FileDiff, GitRepoInfo, HistoryMeta, KillResult, NotificationPayload,
  PromptSendResult, RecordPage,
  RecordQuery,
  RecordResumeOptions, RecordResumeResult,
  RestartOptions, RestartResult, RestoreBatchResult, RestorePrompt, ResumeCheck, ResumeSettings, Session, SessionRecord,
  WorktreeRecord, WorktreeStatus,
} from '../../shared/types';
import type {
  UpdateAvailablePayload, UpdateCheckResult, UpdateConfig, UpdateDirResult, UpdateInstallStart, UpdateProgress,
} from '../../shared/update-status';
import type { SetUsageSettingsResult, UsageSettings } from '../../shared/usage-types';
import type { SessionChangeList } from '../../shared/session-change-types';
import type { PromptTemplate, TemplateContext, TemplateInput, TemplateSaveResult } from '../../shared/template';
import type { PresetInput, PresetSaveResult, SessionPreset } from '../../shared/preset';
import type {
  VerifyActionResult, VerifyConfig, VerifyConfigView, VerifyDetail, VerifyGlobal,
} from '../../shared/verify-types';
import type {
  BatchCreateInput, BatchCreateResult, BatchDiscardPreview, BatchDiscardResult, BatchProgress, BatchRecord, BatchView,
} from '../../shared/batch-types';
import type {
  Annotation, AnnotationDraft, AnnotationList, AnnotationPreview, CommandRecord, FinishCommitOptions, FinishMergeOptions,
  FinishPrOptions, FinishStatus, GitOpResult, OutboxReason, OutboxWhen, RevertEntry, RevertOptions, RevertPlan, SendResult,
} from '../../shared/review-types';
import type { ActivityPush, ActivityQuery, ActivityQueryResult, ActivitySessionInfo } from '../../shared/activity';
import type {
  WebhookConfigDraft, WebhookConfigView, WebhookSaveResult, WebhookTestInput, WebhookTestResult,
} from '../../shared/webhook-types';
import type { SkinId } from '../../shared/skins';

/**
 * preload 通过 contextBridge 暴露的 window.panelApi。
 * 这里的接口必须与 src/preload/index.ts 逐项对齐：新增 IPC 时两边同时修改，
 * 渲染层其余模块只经由 api() 取用，不直接引用全局变量。
 */

/** 新建会话的附加参数：勾选独立工作区时由新建表单填入；initialPrompt 在 Claude 就绪后以粘贴方式一次发出 */
export interface CreateSessionOptions {
  worktree?: boolean;
  branch?: string;
  baseRef?: string;
  initialPrompt?: string;
}

/** 上下文设置 IPC：统计关闭时读到默认值；各会话的上下文摘要随会话列表推送，不走这里 */
export interface UsageBridge {
  getSettings(): Promise<UsageSettings>;
  setSettings(s: UsageSettings): Promise<SetUsageSettingsResult>;
}

/** 提示词模板 IPC：context 与 pickFile 按会话 cwd 计算，会话不存在时用传入的目录（新建表单） */
export interface TemplatesBridge {
  list(): Promise<PromptTemplate[]>;
  save(t: TemplateInput): Promise<TemplateSaveResult>;
  remove(id: string): Promise<boolean>;
  touch(id: string): Promise<PromptTemplate | null>;
  context(sessionId: string | null, cwd?: string): Promise<TemplateContext | null>;
  /** 返回相对 cwd 的路径（cwd 以外为绝对路径）；取消时为 null */
  pickFile(sessionId: string | null, cwd?: string): Promise<{ path: string; absolute: boolean } | null>;
}

/** 自动验证 IPC：配置按仓库键读写；run 手动运行（忽略启用开关与跳过未变化）；摘要随会话列表推送 */
export interface VerifyBridge {
  getConfig(id: string): Promise<VerifyConfigView | null>;
  setConfig(repoKey: string, config: VerifyConfig | null):
  Promise<{ ok: true; config: VerifyConfig | null } | { ok: false; error: string }>;
  getGlobal(): Promise<VerifyGlobal>;
  setGlobal(g: Partial<VerifyGlobal>): Promise<VerifyGlobal>;
  run(id: string): Promise<VerifyActionResult>;
  cancel(id: string): Promise<boolean>;
  detail(id: string): Promise<VerifyDetail | null>;
  openLog(id: string): Promise<VerifyActionResult>;
  /** 把最近一次失败的输出整理成修复提示词发给 Claude；只在会话空闲时可用 */
  sendToClaude(id: string): Promise<VerifyActionResult>;
}

/** 批量派发：创建进度与批次变化由主进程推送 */
export interface BatchBridge {
  create(input: BatchCreateInput): Promise<BatchCreateResult>;
  list(): Promise<BatchRecord[]>;
  view(id: string): Promise<BatchView | null>;
  /** 将被丢弃方案的工作区状态；keepSessionId 缺省时列出全部方案 */
  preview(id: string, keepSessionId?: string): Promise<BatchDiscardPreview[]>;
  keep(id: string, sessionId: string): Promise<BatchDiscardResult[]>;
  discardAll(id: string): Promise<BatchDiscardResult[]>;
  /** 只删除记录，限已结束或已保留的批次 */
  forget(id: string): Promise<boolean>;
  onChanged(cb: (id: string) => void): void;
  onProgress(cb: (p: BatchProgress) => void): void;
}

/** 更新相关 IPC：目录配置、手动检查、开始安装，以及主进程推送的发现新版本、进度与失败 */
export interface UpdaterBridge {
  getConfig(): Promise<UpdateConfig>;
  setDir(dir: string): Promise<UpdateDirResult>;
  pickDir(): Promise<UpdateDirResult>;
  check(): Promise<UpdateCheckResult>;
  install(): Promise<UpdateInstallStart>;
  onAvailable(cb: (info: UpdateAvailablePayload) => void): void;
  onProgress(cb: (p: UpdateProgress) => void): void;
  onError(cb: (message: string) => void): void;
}

/** 批注 IPC：列表含校验结果与排队消息；发送前先取预览，发送结果里 needChoice 表示需要用户选择排队或立即 */
export interface AnnotationsBridge {
  list(id: string): Promise<AnnotationList>;
  add(id: string, draft: AnnotationDraft): Promise<Annotation | { error: string }>;
  update(id: string, annId: string, comment: string): Promise<boolean>;
  /** annId 为 'all-sent' 时清除全部已发送 */
  remove(id: string, annId: string): Promise<boolean>;
  preview(id: string): Promise<AnnotationPreview>;
  send(id: string, when: OutboxWhen): Promise<SendResult>;
  /** 取消排队，批注退回待发送 */
  cancelQueued(id: string): Promise<boolean>;
  /** 某会话的批注或排队状态变化 */
  onChanged(cb: (id: string) => void): void;
  /** 排队丢弃、回车被跳过等需要提示的情况 */
  onNotice(cb: (id: string, message: string, level: 'info' | 'warning') => void): void;
}

/** 撤销单个文件：force 表示已确认忙碌警告，large 表示已确认超大文件不备份，overwrite 表示已确认覆盖之后的修改 */
export interface RevertBridge {
  plan(id: string, path: string, mode?: DiffMode): Promise<RevertPlan>;
  revertFile(id: string, path: string, mode: DiffMode | undefined, opts?: RevertOptions): Promise<GitOpResult & { entry?: RevertEntry }>;
  /** 最近一次撤销；已恢复过时为 null */
  last(id: string): Promise<RevertEntry | null>;
  restore(id: string, entryId: string, opts?: { overwrite?: boolean; force?: boolean }): Promise<GitOpResult>;
}

/** 本会话改动：path 为完整文件地址（正斜杠），必须在该会话的改动集里 */
export interface SessionChangesBridge {
  list(id: string): Promise<SessionChangeList>;
  fileDiff(id: string, path: string, ignoreWs?: boolean): Promise<FileDiff>;
  openPath(id: string, path: string, reveal: boolean, line?: number): Promise<string>;
  revertPlan(id: string, path: string): Promise<RevertPlan>;
  revertFile(id: string, path: string, opts?: RevertOptions): Promise<GitOpResult & { entry?: RevertEntry }>;
  last(id: string): Promise<RevertEntry | null>;
  restore(id: string, entryId: string, opts?: { overwrite?: boolean; force?: boolean }): Promise<GitOpResult>;
  /** 清空全部改动记录（删除条目与改前快照），返回实际删除的条目数 */
  clear(id: string): Promise<{ removed: number }>;
  /** 删除指定文件的改动记录 */
  dismiss(id: string, paths: string[]): Promise<{ removed: number }>;
  /** 删除某个分组（根目录加是否工作目录外）下的全部改动记录 */
  dismissRoot(id: string, root: string, outside: boolean): Promise<{ removed: number }>;
}

/** 会话预设 IPC：新建会话表单组合的增删改查与使用计数 */
export interface PresetsBridge {
  list(): Promise<SessionPreset[]>;
  save(input: PresetInput): Promise<PresetSaveResult>;
  remove(id: string): Promise<boolean>;
  /** 用预设创建会话前记一次使用 */
  touch(id: string): Promise<SessionPreset | null>;
}

/** 外部编辑器命令 IPC：空串表示未配置（保持默认程序打开，不带行号） */
export interface EditorBridge {
  getConfig(): Promise<{ command: string }>;
  /** 校验并保存（空串清除）；失败时返回原因 */
  setConfig(command: string): Promise<{ ok: true; command: string } | { ok: false; error: string }>;
}

/** 外观偏好 IPC：切换成功后主进程同步改窗口底色与系统按钮颜色；id 不认识时 ok 为假、皮肤不变 */
export interface AppearanceBridge {
  get(): Promise<{ skin: SkinId }>;
  set(skin: SkinId): Promise<{ ok: boolean; skin: SkinId }>;
}

/**
 * 工作区收尾：force 表示已确认忙碌警告；主进程照样复查只读、主工作区干净等硬条件。
 * pr 在 gh 不可用时返回 ok=false，url 为比较页、detail 为可复制命令；openCompare 返回错误文本，成功为空串。
 */
export interface FinishBridge {
  status(id: string): Promise<FinishStatus | { error: string }>;
  commit(id: string, msg: string, opts?: FinishCommitOptions): Promise<GitOpResult>;
  suggest(id: string): Promise<{ ok: boolean; text?: string; error?: string }>;
  merge(id: string, opts?: FinishMergeOptions): Promise<GitOpResult>;
  abortMerge(id: string): Promise<GitOpResult>;
  push(id: string, remote: string): Promise<GitOpResult>;
  pr(id: string, opts: FinishPrOptions): Promise<GitOpResult>;
  openCompare(id: string, remote: string): Promise<string>;
  conflictSession(id: string): Promise<Session | { error: string }>;
  log(id: string): Promise<CommandRecord[]>;
  /** pending：新会话就绪超时后保留的提示词 */
  sendPrompt(id: string, reason: 'commit' | 'merge-in-worktree' | 'pending', when: OutboxWhen): Promise<SendResult>;
  /** 新会话就绪超时后保留的提示词种类，没有为 null */
  pendingPrompt(id: string): Promise<OutboxReason | null>;
  discardPrompt(id: string): Promise<boolean>;
}

/** 活动时间线：分页查询、出现过的会话、清空；增量由主进程按 250ms 合并推送 */
export interface ActivityBridge {
  query(q?: ActivityQuery): Promise<ActivityQueryResult>;
  sessions(): Promise<ActivitySessionInfo[]>;
  clear(): Promise<boolean>;
  onEvents(cb: (p: ActivityPush) => void): void;
  /** 自动化测试上报事件；仅隔离测试实例可用 */
  testReport(input: unknown): Promise<unknown>;
}

export interface WebhookBridge {
  getConfig(): Promise<WebhookConfigView>;
  /** 校验并保存；失败时 errors 的键为字段路径，如 targets.0.url */
  setConfig(draft: WebhookConfigDraft): Promise<WebhookSaveResult>;
  /** 用表单当前值发送测试消息，onlyTargetId 为空时发给全部启用的目标 */
  test(input: WebhookTestInput): Promise<WebhookTestResult>;
}

export interface PanelApi {
  list(): Promise<Session[]>;
  create(label: string, cwd: string, opts?: CreateSessionOptions): Promise<Session>;
  /** 向输入框写入提示词，submit 为真时回车提交；拒绝时 reason 为原因 */
  sendPrompt(id: string, text: string, submit: boolean): Promise<PromptSendResult>;
  /** 把未送达的首条提示词写进输入框（不提交） */
  insertPendingPrompt(id: string): Promise<PromptSendResult>;
  output(id: string): Promise<string>;
  input(id: string, text: string): Promise<boolean>;
  resize(id: string, cols: number, rows: number): Promise<boolean>;
  approve(id: string, choice: 'yes' | 'no' | 'always'): Promise<boolean>;
  restart(id: string, opts?: RestartOptions): Promise<RestartResult>;
  resumeCheck(id: string): Promise<ResumeCheck>;
  /** 接管认领的孤儿：确认 pid 属于本会话后结束原进程并续接；确认不了时不结束任何进程 */
  orphanTakeover(id: string): Promise<RestartResult>;
  recordsList(q?: RecordQuery): Promise<RecordPage>;
  recordGet(id: string): Promise<SessionRecord | null>;
  recordResume(id: string, opts: RecordResumeOptions): Promise<RecordResumeResult>;
  recordRename(id: string, label: string): Promise<boolean>;
  recordDelete(ids: string[]): Promise<string[]>;
  historyMeta(): Promise<HistoryMeta>;
  recordPin(id: string, pinned: boolean): Promise<boolean>;
  recordsClear(keepPinned: boolean): Promise<string[]>;
  onRecordsChanged(cb: (ids: string[]) => void): void;
  resumeSettingsGet(): Promise<ResumeSettings>;
  resumeSettingsSet(patch: Partial<ResumeSettings>): Promise<ResumeSettings>;
  restorePrompt(): Promise<RestorePrompt | null>;
  restore(ids: string[] | 'all'): Promise<RestoreBatchResult>;
  onRestoreProgress(cb: (done: number, total: number) => void): void;
  onRestoreResult(cb: (r: RestoreBatchResult & { auto?: boolean }) => void): void;
  kill(id: string, opts?: { force?: boolean; keepWorktree?: boolean }): Promise<KillResult>;
  pickCwd(): Promise<string | null>;
  gitInfo(cwd: string): Promise<GitRepoInfo>;
  worktreeStatus(id: string): Promise<WorktreeStatus | null>;
  leftoverWorktrees(): Promise<WorktreeRecord[]>;
  removeWorktree(path: string, force: boolean): Promise<KillResult>;
  openWorktree(id: string): Promise<string>;
  changes(id: string, mode?: DiffMode): Promise<ChangeList>;
  fileDiff(id: string, path: string, mode?: DiffMode, ignoreWs?: boolean): Promise<FileDiff>;
  /** line 有值且配置了外部编辑器命令时改为在编辑器中跳到该行；成功返回空串 */
  openPath(id: string, path: string, reveal: boolean, line?: number): Promise<string>;
  subagentLog(sessionId: string, agentId: string): Promise<{ text: string; end: number }>;
  exportOutput(id: string, format: ExportFormat): Promise<ExportResult>;
  /** 在资源管理器中定位导出的文件，只接受面板导出过的路径；成功返回空串 */
  revealExport(path: string): Promise<string>;
  dismissSubagent(sessionId: string, agentId: string): Promise<boolean>;
  onSessions(cb: (sessions: Session[]) => void): void;
  onOutput(cb: (id: string, chunk: string) => void): void;
  onSubagentOutput(cb: (sessionId: string, agentId: string, chunk: string, end: number) => void): void;
  onFocusUrgent(cb: () => void): void;
  onSelectSession(cb: (id: string) => void): void;
  onNotify(cb: (n: NotificationPayload) => void): void;
  usage: UsageBridge;
  templates: TemplatesBridge;
  presets: PresetsBridge;
  verify: VerifyBridge;
  batch: BatchBridge;
  annotations: AnnotationsBridge;
  revert: RevertBridge;
  sessionChanges: SessionChangesBridge;
  editor: EditorBridge;
  appearance: AppearanceBridge;
  finish: FinishBridge;
  updater: UpdaterBridge;
  activity: ActivityBridge;
  webhook: WebhookBridge;
}

declare const panelApi: PanelApi | undefined;

/** preload 桥是否生效；入口据此决定启动还是显示致命错误 */
export function hasPanelApi(): boolean {
  return typeof panelApi !== 'undefined';
}

/** 取 preload 桥；入口已确认存在后才会调用 */
export function api(): PanelApi {
  return panelApi!;
}
