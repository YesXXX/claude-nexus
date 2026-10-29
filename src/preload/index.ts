import { contextBridge, ipcRenderer } from 'electron';
import {
  ChangeList, DiffMode, ExportFormat, ExportResult, FileDiff, GitRepoInfo, HistoryMeta, KillResult, NotificationPayload,
  PromptSendResult, RecordPage,
  RecordQuery,
  RecordResumeOptions, RecordResumeResult,
  RestartOptions, RestartResult, RestoreBatchResult, RestorePrompt, ResumeCheck, ResumeSettings, Session, SessionRecord,
  WorktreeRecord, WorktreeStatus,
} from '../shared/types';
import type {
  UpdateAvailablePayload, UpdateCheckResult, UpdateConfig, UpdateDirResult, UpdateInstallStart, UpdateProgress,
} from '../shared/update-status';
import type { SetUsageSettingsResult, UsageSettings } from '../shared/usage-types';
import type { SessionChangeList } from '../shared/session-change-types';
import type { PromptTemplate, TemplateContext, TemplateInput, TemplateSaveResult } from '../shared/template';
import type { PresetInput, PresetSaveResult, SessionPreset } from '../shared/preset';
import type {
  VerifyActionResult, VerifyConfig, VerifyConfigView, VerifyDetail, VerifyGlobal,
} from '../shared/verify-types';
import type {
  BatchCreateInput, BatchCreateResult, BatchDiscardPreview, BatchDiscardResult, BatchProgress, BatchRecord, BatchView,
} from '../shared/batch-types';
import type {
  Annotation, AnnotationDraft, AnnotationList, AnnotationPreview, CommandRecord, FinishCommitOptions, FinishMergeOptions,
  FinishPrOptions, FinishStatus, GitOpResult, OutboxReason, OutboxWhen, RevertEntry, RevertOptions, RevertPlan, SendResult,
} from '../shared/review-types';
import type { ActivityPush, ActivityQuery, ActivityQueryResult, ActivitySessionInfo } from '../shared/activity';
import type {
  WebhookConfigDraft, WebhookConfigView, WebhookSaveResult, WebhookTestInput, WebhookTestResult,
} from '../shared/webhook-types';
import type { SkinId } from '../shared/skins';

/**
 * 首帧皮肤：主进程把所选皮肤放在启动参数 --nexus-skin=<id> 里，这里在页面脚本运行前设到 html 的 data-skin，
 * 样式表加载时就按所选皮肤取值，不会先闪一帧默认皮肤。preload 处于沙箱、只能导入类型，
 * id 已由主进程校验过，这里只防格式异常。documentElement 尚未创建时等它出现再设。
 */
function applyInitialSkin(): void {
  const arg = process.argv.find(a => a.startsWith('--nexus-skin='));
  const skin = arg?.slice('--nexus-skin='.length) ?? '';
  if (!/^[a-z]+$/.test(skin)) return;
  if (document.documentElement) { document.documentElement.dataset.skin = skin; return; }
  const mo = new MutationObserver(() => {
    if (!document.documentElement) return;
    document.documentElement.dataset.skin = skin;
    mo.disconnect();
  });
  mo.observe(document, { childList: true });
}
applyInitialSkin();

contextBridge.exposeInMainWorld('panelApi', {
  list: (): Promise<Session[]> => ipcRenderer.invoke('panel:list'),
  // 新建会话；initialPrompt 在 Claude 就绪后以粘贴方式一次发出
  create: (
    label: string, cwd: string, opts?: { worktree?: boolean; branch?: string; baseRef?: string; initialPrompt?: string },
  ): Promise<Session> => ipcRenderer.invoke('panel:create', label, cwd, opts),
  // 向输入框写入提示词，submit 为真时回车提交；等待审批、只读、已退出、粘贴模式未开启的多行文本会被拒绝
  sendPrompt: (id: string, text: string, submit: boolean): Promise<PromptSendResult> =>
    ipcRenderer.invoke('panel:send-prompt', id, text, submit),
  // 把未送达的首条提示词写进输入框（不提交）
  insertPendingPrompt: (id: string): Promise<PromptSendResult> => ipcRenderer.invoke('panel:prompt-insert-pending', id),
  output: (id: string): Promise<string> => ipcRenderer.invoke('panel:output', id),
  input: (id: string, text: string): Promise<boolean> => ipcRenderer.invoke('panel:input', id, text),
  resize: (id: string, cols: number, rows: number): Promise<boolean> =>
    ipcRenderer.invoke('panel:resize', id, cols, rows),
  approve: (id: string, choice: 'yes' | 'no' | 'always'): Promise<boolean> =>
    ipcRenderer.invoke('panel:approve', id, choice),
  // 重启：缺省续接原对话；mode=fresh 全新开始；force 先结束仍在运行的进程
  restart: (id: string, opts?: RestartOptions): Promise<RestartResult> => ipcRenderer.invoke('panel:restart', id, opts),
  // 续接前检查：每次调用都查一次对话记录文件
  resumeCheck: (id: string): Promise<ResumeCheck> => ipcRenderer.invoke('panel:resume-check', id),
  // 接管认领的孤儿：结束仍在原终端运行的进程后续接同一段对话
  orphanTakeover: (id: string): Promise<RestartResult> => ipcRenderer.invoke('panel:orphan-takeover', id),
  // 会话记录：历史查询与单条读取；记录增删改后主进程防抖推送变化的 id
  recordsList: (q?: RecordQuery): Promise<RecordPage> => ipcRenderer.invoke('panel:records-list', q ?? {}),
  recordGet: (id: string): Promise<SessionRecord | null> => ipcRenderer.invoke('panel:record-get', id),
  // 从历史拉起：续接 / 全新开始沿用原面板 id，分叉返回新面板 id；改名；删除只删已结束记录
  recordResume: (id: string, opts: RecordResumeOptions): Promise<RecordResumeResult> =>
    ipcRenderer.invoke('panel:record-resume', id, opts),
  recordRename: (id: string, label: string): Promise<boolean> => ipcRenderer.invoke('panel:record-rename', id, label),
  recordDelete: (ids: string[]): Promise<string[]> => ipcRenderer.invoke('panel:record-delete', ids),
  // 历史面板：概况（可用性与目录列表）、固定、清空（只删已结束记录，不碰工作区）
  historyMeta: (): Promise<HistoryMeta> => ipcRenderer.invoke('panel:history-meta'),
  recordPin: (id: string, pinned: boolean): Promise<boolean> => ipcRenderer.invoke('panel:record-pin', id, pinned),
  recordsClear: (keepPinned: boolean): Promise<string[]> => ipcRenderer.invoke('panel:records-clear', keepPinned),
  onRecordsChanged: (cb: (ids: string[]) => void): void => {
    ipcRenderer.on('panel:records-changed', (_e, msg: { ids: string[] }) => cb(msg.ids));
  },
  // 续接设置、询问档横幅、批量续接；批量续接的进度与启动时自动续接的结果由主进程推送
  resumeSettingsGet: (): Promise<ResumeSettings> => ipcRenderer.invoke('panel:resume-settings-get'),
  resumeSettingsSet: (patch: Partial<ResumeSettings>): Promise<ResumeSettings> =>
    ipcRenderer.invoke('panel:resume-settings-set', patch),
  restorePrompt: (): Promise<RestorePrompt | null> => ipcRenderer.invoke('panel:restore-prompt'),
  restore: (ids: string[] | 'all'): Promise<RestoreBatchResult> => ipcRenderer.invoke('panel:restore', ids),
  onRestoreProgress: (cb: (done: number, total: number) => void): void => {
    ipcRenderer.on('panel:restore-progress', (_e, p: { done: number; total: number }) => cb(p.done, p.total));
  },
  onRestoreResult: (cb: (r: RestoreBatchResult & { auto?: boolean }) => void): void => {
    ipcRenderer.on('panel:restore-result', (_e, r) => cb(r));
  },
  kill: (id: string, opts?: { force?: boolean; keepWorktree?: boolean }): Promise<KillResult> =>
    ipcRenderer.invoke('panel:kill', id, opts),
  pickCwd: (): Promise<string | null> => ipcRenderer.invoke('panel:pickCwd'),
  // 独立工作区：新建前探测仓库、结束前查未提交 / 未合并、命令面板清理遗留
  gitInfo: (cwd: string): Promise<GitRepoInfo> => ipcRenderer.invoke('panel:git-info', cwd),
  worktreeStatus: (id: string): Promise<WorktreeStatus | null> => ipcRenderer.invoke('panel:worktree-status', id),
  leftoverWorktrees: (): Promise<WorktreeRecord[]> => ipcRenderer.invoke('panel:leftover-worktrees'),
  removeWorktree: (path: string, force: boolean): Promise<KillResult> =>
    ipcRenderer.invoke('panel:remove-worktree', path, force),
  // 在资源管理器中打开会话的工作区目录，失败返回错误文本，成功返回空串
  openWorktree: (id: string): Promise<string> => ipcRenderer.invoke('panel:open-worktree', id),
  // 改动审阅：文件列表、单文件 diff（ignoreWs 相当于 git diff -w）、打开 / 定位改动文件
  // （路径须在改动列表内；line 有值且配置了外部编辑器时改为跳到该行）
  changes: (id: string, mode?: DiffMode): Promise<ChangeList> => ipcRenderer.invoke('panel:changes', id, mode),
  fileDiff: (id: string, path: string, mode?: DiffMode, ignoreWs?: boolean): Promise<FileDiff> =>
    ipcRenderer.invoke('panel:file-diff', id, path, mode, ignoreWs === true),
  openPath: (id: string, path: string, reveal: boolean, line?: number): Promise<string> =>
    ipcRenderer.invoke('panel:open-path', id, path, reveal, line),
  // 子代理：切换视图时回放缓冲（invoke，含累计偏移）；实时增量由 onSubagentOutput（send）接管
  subagentLog: (sessionId: string, agentId: string): Promise<{ text: string; end: number }> =>
    ipcRenderer.invoke('panel:subagent-log', sessionId, agentId),
  // 导出终端输出（主进程弹保存对话框）；在资源管理器中定位导出的文件，失败返回错误文本
  exportOutput: (id: string, format: ExportFormat): Promise<ExportResult> =>
    ipcRenderer.invoke('panel:export-output', id, format),
  revealExport: (path: string): Promise<string> => ipcRenderer.invoke('panel:export-reveal', path),
  // 手动关闭已结束的子代理条目；运行中的会被主进程拒绝，返回 false
  dismissSubagent: (sessionId: string, agentId: string): Promise<boolean> =>
    ipcRenderer.invoke('panel:dismiss-subagent', sessionId, agentId),
  onSessions: (cb: (sessions: Session[]) => void): void => {
    ipcRenderer.on('panel:sessions', (_e, sessions) => cb(sessions));
  },
  onOutput: (cb: (id: string, chunk: string) => void): void => {
    ipcRenderer.on('panel:output', (_e, msg) => cb(msg.id, msg.line));
  },
  onSubagentOutput: (cb: (sessionId: string, agentId: string, chunk: string, end: number) => void): void => {
    ipcRenderer.on('panel:subagent-output', (_e, msg) => cb(msg.sessionId, msg.agentId, msg.chunk, msg.end));
  },
  onFocusUrgent: (cb: () => void): void => {
    ipcRenderer.on('panel:focus-urgent', () => cb());
  },
  onSelectSession: (cb: (id: string) => void): void => {
    ipcRenderer.on('panel:select-session', (_e, id: string) => cb(id));
  },
  onNotify: (cb: (n: NotificationPayload) => void): void => {
    ipcRenderer.on('panel:notify', (_e, n) => cb(n));
  },
  // 上下文设置：告警阈值与窗口覆盖；各会话的上下文摘要随会话列表推送
  usage: {
    getSettings: (): Promise<UsageSettings> => ipcRenderer.invoke('usage:get-settings'),
    setSettings: (s: UsageSettings): Promise<SetUsageSettingsResult> => ipcRenderer.invoke('usage:set-settings', s),
  },
  // 提示词模板：增删改查与使用计数、内置变量上下文、文件变量的文件选择
  templates: {
    list: (): Promise<PromptTemplate[]> => ipcRenderer.invoke('templates:list'),
    save: (t: TemplateInput): Promise<TemplateSaveResult> => ipcRenderer.invoke('templates:save', t),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('templates:remove', id),
    touch: (id: string): Promise<PromptTemplate | null> => ipcRenderer.invoke('templates:touch', id),
    context: (sessionId: string | null, cwd?: string): Promise<TemplateContext | null> =>
      ipcRenderer.invoke('templates:context', sessionId, cwd),
    pickFile: (sessionId: string | null, cwd?: string): Promise<{ path: string; absolute: boolean } | null> =>
      ipcRenderer.invoke('templates:pick-file', sessionId, cwd),
  },
  // 自动验证：按仓库配置、手动运行与取消、输出详情、打开完整日志；摘要随会话列表推送
  verify: {
    getConfig: (id: string): Promise<VerifyConfigView | null> => ipcRenderer.invoke('verify:get-config', id),
    setConfig: (repoKey: string, config: VerifyConfig | null):
    Promise<{ ok: true; config: VerifyConfig | null } | { ok: false; error: string }> =>
      ipcRenderer.invoke('verify:set-config', repoKey, config),
    getGlobal: (): Promise<VerifyGlobal> => ipcRenderer.invoke('verify:get-global'),
    setGlobal: (g: Partial<VerifyGlobal>): Promise<VerifyGlobal> => ipcRenderer.invoke('verify:set-global', g),
    run: (id: string): Promise<VerifyActionResult> => ipcRenderer.invoke('verify:run', id),
    cancel: (id: string): Promise<boolean> => ipcRenderer.invoke('verify:cancel', id),
    detail: (id: string): Promise<VerifyDetail | null> => ipcRenderer.invoke('verify:detail', id),
    openLog: (id: string): Promise<VerifyActionResult> => ipcRenderer.invoke('verify:open-log', id),
    sendToClaude: (id: string): Promise<VerifyActionResult> => ipcRenderer.invoke('verify:send-to-claude', id),
  },
  // 批量派发：创建（进度推送）、列表与对比数据、保留其一 / 全部放弃前的确认信息与执行、删除已结束批次的记录
  batch: {
    create: (input: BatchCreateInput): Promise<BatchCreateResult> => ipcRenderer.invoke('batch:create', input),
    list: (): Promise<BatchRecord[]> => ipcRenderer.invoke('batch:list'),
    view: (id: string): Promise<BatchView | null> => ipcRenderer.invoke('batch:view', id),
    preview: (id: string, keepSessionId?: string): Promise<BatchDiscardPreview[]> =>
      ipcRenderer.invoke('batch:preview', id, keepSessionId),
    keep: (id: string, sessionId: string): Promise<BatchDiscardResult[]> => ipcRenderer.invoke('batch:keep', id, sessionId),
    discardAll: (id: string): Promise<BatchDiscardResult[]> => ipcRenderer.invoke('batch:discard-all', id),
    forget: (id: string): Promise<boolean> => ipcRenderer.invoke('batch:forget', id),
    onChanged: (cb: (id: string) => void): void => {
      ipcRenderer.on('batch:changed', (_e, msg: { id: string }) => cb(msg.id));
    },
    onProgress: (cb: (p: BatchProgress) => void): void => {
      ipcRenderer.on('batch:progress', (_e, p: BatchProgress) => cb(p));
    },
  },
  // 批注：增删改、发送预览、发送给 Claude（空闲即发 / 排队 / 立即）与取消排队；变化与提示由主进程推送
  annotations: {
    list: (id: string): Promise<AnnotationList> => ipcRenderer.invoke('panel:annotations', id),
    add: (id: string, draft: AnnotationDraft): Promise<Annotation | { error: string }> =>
      ipcRenderer.invoke('panel:annotation-add', id, draft),
    update: (id: string, annId: string, comment: string): Promise<boolean> =>
      ipcRenderer.invoke('panel:annotation-update', id, annId, comment),
    remove: (id: string, annId: string): Promise<boolean> => ipcRenderer.invoke('panel:annotation-remove', id, annId),
    preview: (id: string): Promise<AnnotationPreview> => ipcRenderer.invoke('panel:annotation-preview', id),
    send: (id: string, when: OutboxWhen): Promise<SendResult> => ipcRenderer.invoke('panel:annotation-send', id, { when }),
    cancelQueued: (id: string): Promise<boolean> => ipcRenderer.invoke('panel:outbox-cancel', id),
    onChanged: (cb: (id: string) => void): void => {
      ipcRenderer.on('panel:annotations-changed', (_e, msg: { id: string }) => cb(msg.id));
    },
    onNotice: (cb: (id: string, message: string, level: 'info' | 'warning') => void): void => {
      ipcRenderer.on('panel:outbox-notice', (_e, msg) => cb(msg.id, msg.message, msg.level));
    },
  },
  // 撤销单个文件：确认信息、撤销、最近一次撤销、恢复；路径与备份 id 由主进程校验
  revert: {
    plan: (id: string, path: string, mode?: DiffMode): Promise<RevertPlan> => ipcRenderer.invoke('panel:revert-plan', id, path, mode),
    revertFile: (id: string, path: string, mode: DiffMode | undefined, opts?: RevertOptions): Promise<GitOpResult & { entry?: RevertEntry }> =>
      ipcRenderer.invoke('panel:revert-file', id, path, mode, opts),
    last: (id: string): Promise<RevertEntry | null> => ipcRenderer.invoke('panel:revert-last', id),
    restore: (id: string, entryId: string, opts?: { overwrite?: boolean; force?: boolean }): Promise<GitOpResult> =>
      ipcRenderer.invoke('panel:revert-restore', id, entryId, opts),
  },
  // 本会话改动：按 Claude 动过的文件统计（跨仓库、非 git 目录也有），path 为完整文件地址（正斜杠）
  sessionChanges: {
    list: (id: string): Promise<SessionChangeList> => ipcRenderer.invoke('panel:session-changes', id),
    fileDiff: (id: string, path: string, ignoreWs?: boolean): Promise<FileDiff> =>
      ipcRenderer.invoke('panel:session-file-diff', id, path, ignoreWs === true),
    openPath: (id: string, path: string, reveal: boolean, line?: number): Promise<string> =>
      ipcRenderer.invoke('panel:session-open-path', id, path, reveal, line),
    revertPlan: (id: string, path: string): Promise<RevertPlan> => ipcRenderer.invoke('panel:session-revert-plan', id, path),
    revertFile: (id: string, path: string, opts?: RevertOptions): Promise<GitOpResult & { entry?: RevertEntry }> =>
      ipcRenderer.invoke('panel:session-revert-file', id, path, opts),
    last: (id: string): Promise<RevertEntry | null> => ipcRenderer.invoke('panel:session-revert-last', id),
    restore: (id: string, entryId: string, opts?: { overwrite?: boolean; force?: boolean }): Promise<GitOpResult> =>
      ipcRenderer.invoke('panel:session-revert-restore', id, entryId, opts),
    // 清除改动记录（删除条目与改前快照，之后的新改动会重新记录）；返回实际删除的条目数
    clear: (id: string): Promise<{ removed: number }> => ipcRenderer.invoke('panel:session-changes-clear', id),
    dismiss: (id: string, paths: string[]): Promise<{ removed: number }> =>
      ipcRenderer.invoke('panel:session-changes-dismiss', id, paths),
    dismissRoot: (id: string, root: string, outside: boolean): Promise<{ removed: number }> =>
      ipcRenderer.invoke('panel:session-changes-dismiss-root', id, root, outside),
  },
  // 外部编辑器命令：配置读写；带行号打开改动文件时由主进程按它启动编辑器
  editor: {
    getConfig: (): Promise<{ command: string }> => ipcRenderer.invoke('editor:get-config'),
    setConfig: (command: string): Promise<{ ok: true; command: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('editor:set-config', command),
  },
  // 外观：当前皮肤与切换；切换成功后主进程同步改窗口底色与系统按钮颜色，返回生效后的皮肤
  appearance: {
    get: (): Promise<{ skin: SkinId }> => ipcRenderer.invoke('appearance:get'),
    set: (skin: SkinId): Promise<{ ok: boolean; skin: SkinId }> => ipcRenderer.invoke('appearance:set', skin),
  },
  // 会话预设：新建会话表单的组合（工作目录、独立工作区、首条提示词）的增删改查与使用计数
  presets: {
    list: (): Promise<SessionPreset[]> => ipcRenderer.invoke('presets:list'),
    save: (input: PresetInput): Promise<PresetSaveResult> => ipcRenderer.invoke('presets:save', input),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('presets:remove', id),
    touch: (id: string): Promise<SessionPreset | null> => ipcRenderer.invoke('presets:touch', id),
  },
  // 工作区收尾：状态、提交、生成提交信息、合并 / 放弃合并、推送、建 PR、比较页、冲突会话、操作记录、发提示词
  finish: {
    status: (id: string): Promise<FinishStatus | { error: string }> => ipcRenderer.invoke('panel:finish-status', id),
    commit: (id: string, msg: string, opts?: FinishCommitOptions): Promise<GitOpResult> =>
      ipcRenderer.invoke('panel:finish-commit', id, msg, opts),
    suggest: (id: string): Promise<{ ok: boolean; text?: string; error?: string }> => ipcRenderer.invoke('panel:finish-suggest', id),
    merge: (id: string, opts?: FinishMergeOptions): Promise<GitOpResult> => ipcRenderer.invoke('panel:finish-merge', id, opts),
    abortMerge: (id: string): Promise<GitOpResult> => ipcRenderer.invoke('panel:finish-merge-abort', id),
    push: (id: string, remote: string): Promise<GitOpResult> => ipcRenderer.invoke('panel:finish-push', id, remote),
    pr: (id: string, opts: FinishPrOptions): Promise<GitOpResult> => ipcRenderer.invoke('panel:finish-pr', id, opts),
    openCompare: (id: string, remote: string): Promise<string> => ipcRenderer.invoke('panel:finish-open-compare', id, remote),
    conflictSession: (id: string): Promise<Session | { error: string }> => ipcRenderer.invoke('panel:finish-conflict-session', id),
    log: (id: string): Promise<CommandRecord[]> => ipcRenderer.invoke('panel:finish-log', id),
    sendPrompt: (id: string, reason: 'commit' | 'merge-in-worktree' | 'pending', when: OutboxWhen): Promise<SendResult> =>
      ipcRenderer.invoke('panel:prompt-send', id, reason, { when }),
    pendingPrompt: (id: string): Promise<OutboxReason | null> => ipcRenderer.invoke('panel:prompt-pending', id),
    discardPrompt: (id: string): Promise<boolean> => ipcRenderer.invoke('panel:prompt-discard', id),
  },
  // 活动时间线：分页查询、出现过的会话、清空；增量推送 250ms 一批
  activity: {
    query: (q?: ActivityQuery): Promise<ActivityQueryResult> => ipcRenderer.invoke('activity:query', q ?? {}),
    sessions: (): Promise<ActivitySessionInfo[]> => ipcRenderer.invoke('activity:sessions'),
    clear: (): Promise<boolean> => ipcRenderer.invoke('activity:clear'),
    onEvents: (cb: (p: ActivityPush) => void): void => {
      ipcRenderer.on('activity:events', (_e, p: ActivityPush) => cb(p));
    },
    // 只有隔离实例且 CLAUDE_PANEL_TEST_HOOKS=1 时主进程才注册处理器，其余情况调用会被拒绝
    testReport: (input: unknown): Promise<unknown> => ipcRenderer.invoke('activity:test-report', input),
  },
  // 远程通知：读取脱敏配置、校验保存、用表单当前值发送测试消息
  webhook: {
    getConfig: (): Promise<WebhookConfigView> => ipcRenderer.invoke('webhook:get-config'),
    setConfig: (draft: WebhookConfigDraft): Promise<WebhookSaveResult> => ipcRenderer.invoke('webhook:set-config', draft),
    test: (input: WebhookTestInput): Promise<WebhookTestResult> => ipcRenderer.invoke('webhook:test', input),
  },
  // 更新：目录配置 / 手动检查 / 开始安装；发现新版本、下载进度与失败由主进程推送
  updater: {
    getConfig: (): Promise<UpdateConfig> => ipcRenderer.invoke('updater:getConfig'),
    setDir: (dir: string): Promise<UpdateDirResult> => ipcRenderer.invoke('updater:setDir', dir),
    pickDir: (): Promise<UpdateDirResult> => ipcRenderer.invoke('updater:pickDir'),
    check: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updater:check'),
    install: (): Promise<UpdateInstallStart> => ipcRenderer.invoke('updater:install'),
    onAvailable: (cb: (info: UpdateAvailablePayload) => void): void => {
      ipcRenderer.on('update:available', (_e, info) => cb(info));
    },
    onProgress: (cb: (p: UpdateProgress) => void): void => {
      ipcRenderer.on('update:progress', (_e, p) => cb(p));
    },
    onError: (cb: (message: string) => void): void => {
      ipcRenderer.on('update:error', (_e, err) => cb(err?.message ?? '更新失败'));
    },
  },
});