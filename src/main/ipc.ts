import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { RESTORE_INTERVAL_MS, SessionManager } from './session-manager';
import {
  endSession, launchSession, normalizeLaunch, PROMPT_INPUT_MAX, type EndDeps, type LaunchDeps,
} from './session-launcher';
import { isIsolatedInstance } from './panel-home';
import { launchEditorAt } from './editor-launch';
import { exportOutput, isExportFormat, uniquePath, type ExportDeps } from './output-export';
import type { SubagentTracker } from './subagent-tracker';
import type { WorktreeManager } from './worktree-manager';
import type { ChangeTracker } from './change-tracker';
import type { UsageTracker } from './usage-tracker';
import { checkResumeFull, restartWithWorktree, type WorktreeResumeDeps } from './worktree-resume';
import { takeoverOrphan, type TakeoverDeps } from './orphan-takeover';
import { isPidAlive, killTree, readCommandLine } from './proc-tree';
import { asRecordResumeOptions, deleteRecords, renameRecord, resumeRecord, type RecordActionDeps } from './record-actions';
import type { SessionRecordStore } from './session-record-store';
import { DEFAULT_RESUME_SETTINGS, type ResumeSettingsStore } from './resume-settings';
import { sanitizeQuery } from '../shared/session-records';
import type { Updater } from './updater';
import type { UpdateConfig, UpdateDirResult } from '../shared/update-status';
import type {
  ChangeList, DiffMode, ExportResult, FileDiff, GitRepoInfo, KillResult, PromptSendResult, RecordPage, RecordResumeResult,
  RestartOptions,
  RestartResult,
  RestoreBatchResult,
  RestorePrompt, ResumeCheck, ResumeSettings, SessionRecord, WorktreeInfo, WorktreeRecord, WorktreeStatus,
} from '../shared/types';

export interface IpcExtras {
  worktrees?: WorktreeManager;
  changes?: ChangeTracker;
  /** 本会话改动：结束会话时丢掉内存状态 */
  sessionChanges?: { forget(id: string): void };
  /** 外部编辑器命令（配置为空串时视为未配置）；带行号打开改动文件时使用 */
  editor?: { command(): string };
  records?: SessionRecordStore;
  /** 用量统计；关闭时缺省 */
  usage?: UsageTracker;
  /** 续接设置与启动时算出的询问档横幅内容 */
  resume?: { settings: ResumeSettingsStore; prompt: () => RestorePrompt | null };
  /** 首条提示词投递与向输入框写入提示词（发件箱可用后才有） */
  prompts?: PromptIpcDeps;
}

export interface PromptIpcDeps {
  /** 新建会话后排一条就绪后发送的首条提示词 */
  deliver(id: string, text: string): void;
  /** 写入输入框，submit 为真时回车提交 */
  insert(id: string, text: string, submit: boolean): PromptSendResult;
  /** 把未送达的首条提示词写进输入框（不提交） */
  insertPending(id: string): PromptSendResult;
}

export { PROMPT_INPUT_MAX };

interface CreateOptions { worktree?: unknown; branch?: unknown; baseRef?: unknown; initialPrompt?: unknown }
interface KillOptions { force?: boolean; keepWorktree?: boolean; }

// 用默认程序打开这些类型等于直接执行，Claude 写出的文件不可信，一律改为在资源管理器中定位
const EXECUTABLE_EXT = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp',
  '.scr', '.hta', '.cpl', '.lnk', '.url', '.reg', '.jar', '.pif', '.application', '.appref-ms', '.gadget', '.msc',
  '.py', '.pyw', '.sh', '.bash', '.ws', '.settingcontent-ms', '.library-ms', '.search-ms',
]);

/** 打开或定位一个已校验过的改动文件：可执行类型不直接打开，改为在资源管理器中定位；成功返回空串 */
export async function openChangedPath(abs: string, reveal: boolean): Promise<string> {
  const exists = fs.existsSync(abs);
  const executable = EXECUTABLE_EXT.has(path.extname(abs).toLowerCase());
  if (reveal || executable) {
    if (exists) shell.showItemInFolder(abs);
    else if (fs.existsSync(path.dirname(abs))) await shell.openPath(path.dirname(abs));
    else return '文件与所在目录都已不存在';
    return reveal ? '' : '可执行类型的文件不直接打开，已在资源管理器中定位';
  }
  if (!exists) return '文件已被删除';
  return shell.openPath(abs);
}

function asMode(v: unknown): DiffMode | undefined {
  return v === 'base' || v === 'working' ? v : undefined;
}

/** 渲染层传入的行号：只接受正整数，其余视为没有行号 */
export function asLineNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 ? Math.floor(n) : undefined;
}

/** 渲染层传入的重启选项：未知或缺省的 mode 一律按续接处理，布尔开关只认 true */
export function asRestartOptions(v: unknown): RestartOptions {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const opts: RestartOptions = { mode: o.mode === 'fresh' ? 'fresh' : 'resume' };
  if (o.force === true) opts.force = true;
  if (o.rebuildWorktree === true) opts.rebuildWorktree = true;
  return opts;
}

/** 导出依赖：隔离实例设置了 CLAUDE_PANEL_TEST_SAVE_DIR 时跳过保存对话框、直接写入该目录，正式实例忽略该变量 */
function exportDeps(manager: SessionManager, win: BrowserWindow | null): ExportDeps {
  const testDir = isIsolatedInstance() ? process.env.CLAUDE_PANEL_TEST_SAVE_DIR : undefined;
  return {
    output: id => manager.getSessionOutput(id),
    dropped: id => manager.getDroppedChars(id),
    termSize: id => manager.getTermSize(id),
    label: id => manager.getSession(id)?.label,
    pickPath: async (name, format) => {
      if (testDir) {
        fs.mkdirSync(testDir, { recursive: true });
        return uniquePath(testDir, name);
      }
      const filters = format === 'ansi'
        ? [{ name: '日志文件', extensions: ['log'] }, { name: '所有文件', extensions: ['*'] }]
        : [{ name: '文本文件', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }];
      const opts = { title: '导出终端输出', defaultPath: path.join(app.getPath('documents'), name), filters };
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
  };
}

export function registerIpc(manager: SessionManager, subagentTracker?: SubagentTracker, extras: IpcExtras = {}): void {
  const { worktrees, changes, records, resume, usage, prompts, sessionChanges, editor } = extras;
  ipcMain.handle('panel:list', () => manager.getSessions());

  const launchDeps: LaunchDeps = { manager, worktrees, changes, prompts };
  ipcMain.handle('panel:create', (_e, label: unknown, cwd: unknown, opts?: CreateOptions) =>
    launchSession(launchDeps, normalizeLaunch(label, cwd, opts)));

  // 向输入框写入提示词：submit 为真时回车提交；拒绝原因由发件箱给出（等待审批、只读、已退出、粘贴模式未开启的多行文本）
  ipcMain.handle('panel:send-prompt', (_e, id: unknown, text: unknown, submit: unknown): PromptSendResult => {
    if (typeof id !== 'string' || typeof text !== 'string') return { ok: false, reason: '参数无效' };
    if (!prompts) return { ok: false, reason: '发件箱不可用' };
    if (text.length > PROMPT_INPUT_MAX) return { ok: false, reason: `提示词过长（上限 ${PROMPT_INPUT_MAX} 字）` };
    if (!manager.getSession(id)) return { ok: false, reason: '会话不存在' };
    return prompts.insert(id, text, submit === true);
  });
  ipcMain.handle('panel:prompt-insert-pending', (_e, id: unknown): PromptSendResult => {
    if (typeof id !== 'string') return { ok: false, reason: '参数无效' };
    return prompts ? prompts.insertPending(id) : { ok: false, reason: '发件箱不可用' };
  });

  ipcMain.handle('panel:output', (_e, id: string) => manager.getSessionOutput(id));
  ipcMain.handle('panel:input', (_e, id: string, text: string) => manager.writeInput(id, text));
  ipcMain.handle('panel:resize', (_e, id: string, cols: number, rows: number) =>
    manager.resizeSession(id, cols, rows));
  ipcMain.handle('panel:approve', (_e, id: string, choice: 'yes' | 'no' | 'always') =>
    manager.approvePermission(id, choice));
  // 续接与检查经过工作区感知的包装：工作区目录缺失时查分支、按需原地重建
  const resumeDeps: WorktreeResumeDeps = {
    host: manager, worktrees, patchRecord: records ? (id, patch) => { records.patch(id, patch); } : undefined,
  };
  ipcMain.handle('panel:restart', (_e, id: string, opts?: unknown): Promise<RestartResult> =>
    restartWithWorktree(resumeDeps, id, asRestartOptions(opts)));
  ipcMain.handle('panel:resume-check', (_e, id: string): Promise<ResumeCheck> => checkResumeFull(resumeDeps, id));
  // 接管认领的孤儿：确认 pid 仍属于本会话后结束原进程，再在面板里续接
  const takeoverDeps: TakeoverDeps = { host: manager, readCommandLine, isAlive: isPidAlive, killTree };
  ipcMain.handle('panel:orphan-takeover', (_e, id: unknown): Promise<RestartResult> => {
    if (typeof id !== 'string') return Promise.resolve({ ok: false, reason: 'not_found', message: '会话不存在' });
    return takeoverOrphan(takeoverDeps, id).then(r => {
      if (r.ok) void changes?.refresh(id);
      return r;
    });
  });

  // 普通会话直接结束；工作区会话默认等进程退出后删除工作区（keepWorktree 则保留，留待命令面板清理）
  const endDeps: EndDeps = { manager, worktrees, changes, sessionChanges, usage, records };
  ipcMain.handle('panel:kill', (_e, id: string, opts?: KillOptions): Promise<KillResult> =>
    endSession(endDeps, id, { force: !!opts?.force, keepWorktree: !!opts?.keepWorktree }));

  ipcMain.handle('panel:records-list', (_e, q: unknown): RecordPage =>
    records ? records.query(sanitizeQuery(q)) : { items: [], total: 0 });
  ipcMain.handle('panel:record-get', (_e, id: unknown): SessionRecord | null =>
    (records && typeof id === 'string' ? records.get(id) : undefined) ?? null);
  // 历史动作：续接与全新开始沿用原面板 id，分叉返回新面板 id；改名同步列表里的会话；删除只删已结束记录
  const recordDeps: RecordActionDeps = { manager, records, resume: resumeDeps };
  ipcMain.handle('panel:record-resume', (_e, id: unknown, opts: unknown): Promise<RecordResumeResult> => {
    if (typeof id !== 'string') return Promise.resolve({ ok: false, reason: 'not_found', message: '会话不存在' });
    return resumeRecord(recordDeps, id, asRecordResumeOptions(opts)).then(r => {
      if (r.ok && r.sessionId) void changes?.refresh(r.sessionId);
      return r;
    });
  });
  ipcMain.handle('panel:record-rename', (_e, id: unknown, label: unknown): boolean => renameRecord(recordDeps, id, label));
  ipcMain.handle('panel:record-delete', (_e, ids: unknown): string[] => deleteRecords(recordDeps, ids));

  ipcMain.handle('panel:resume-settings-get', (): ResumeSettings => resume?.settings.get() ?? { ...DEFAULT_RESUME_SETTINGS });
  // 改了历史上限立即按新上限清理一次
  ipcMain.handle('panel:resume-settings-set', (_e, patch: unknown): ResumeSettings => {
    if (!resume) return { ...DEFAULT_RESUME_SETTINGS };
    const next = resume.settings.set(patch);
    records?.prune(next);
    return next;
  });
  // 询问档横幅：只返回仍处于待续接的会话
  ipcMain.handle('panel:restore-prompt', (): RestorePrompt | null => {
    const p = resume?.prompt();
    if (!p) return null;
    const ids = p.ids.filter(id => manager.getSession(id)?.status === 'suspended');
    return ids.length > 0 ? { ids, reason: p.reason } : null;
  });
  // 批量续接：逐个拉起，进度推给发起的窗口
  ipcMain.handle('panel:restore', (e, ids: unknown): Promise<RestoreBatchResult> => {
    const list = ids === 'all' ? 'all' : Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
    return manager.restoreSessions(list, RESTORE_INTERVAL_MS, (done, total) => {
      if (!e.sender.isDestroyed()) e.sender.send('panel:restore-progress', { done, total });
    });
  });

  ipcMain.handle('panel:git-info', async (_e, cwd: unknown): Promise<GitRepoInfo> => {
    if (!worktrees || typeof cwd !== 'string' || !cwd.trim()) return { state: 'not_repo' };
    const { toplevel: _toplevel, ...info } = await worktrees.inspect(cwd.trim());
    return info;
  });

  // 只打开会话自己的工作区目录，渲染层传不进任意路径
  ipcMain.handle('panel:open-worktree', async (_e, id: string): Promise<string> => {
    const wt = manager.getSession(id)?.worktree;
    if (!wt) return '该会话没有独立工作区';
    if (!fs.existsSync(wt.path)) return '工作区目录不存在';
    return shell.openPath(wt.path);
  });

  ipcMain.handle('panel:changes', async (_e, id: string, mode: unknown): Promise<ChangeList> => {
    if (!changes || !manager.getSession(id)) throw new Error('会话不存在');
    return changes.getChanges(id, asMode(mode));
  });

  // 路径必须在该会话的改动列表里（由 ChangeTracker 校验），渲染层读不到任意文件
  ipcMain.handle('panel:file-diff', async (_e, id: string, relPath: unknown, mode: unknown, ignoreWs: unknown): Promise<FileDiff> => {
    const p = typeof relPath === 'string' ? relPath : '';
    if (!changes) return { path: p, binary: false, truncated: false, hunks: [], error: '改动统计不可用' };
    return changes.getFileDiff(id, p, asMode(mode), { ignoreWs: ignoreWs === true });
  });

  // 打开 / 定位改动文件：同样只接受改动列表里的路径；可执行类型不直接打开，改为定位；
  // 带行号且配置了外部编辑器命令时改为在编辑器中跳到该行，成功返回空串
  ipcMain.handle('panel:open-path', async (_e, id: string, relPath: unknown, reveal: unknown, line: unknown): Promise<string> => {
    if (!changes || typeof relPath !== 'string') return '参数无效';
    const r = await changes.resolveChangedPath(id, relPath);
    if ('error' in r) return r.error;
    const ln = asLineNumber(line);
    if (ln !== undefined && reveal !== true && editor) {
      const err = await launchEditorAt(editor.command(), r.abs, ln);
      if (err !== '') return err;
    }
    return openChangedPath(r.abs, reveal === true);
  });

  ipcMain.handle('panel:worktree-status', async (_e, id: string): Promise<WorktreeStatus | null> => {
    const wt = manager.getSession(id)?.worktree;
    return wt && worktrees ? worktrees.status(wt) : null;
  });

  ipcMain.handle('panel:leftover-worktrees', (): WorktreeRecord[] => {
    if (!worktrees) return [];
    return worktrees.leftovers(new Set(manager.getSessions().map(s => s.id)));
  });

  // 只接受登记表里且没有存活会话占用的工作区，渲染层传不进任意路径
  ipcMain.handle('panel:remove-worktree', async (_e, wtPath: unknown, force: unknown): Promise<KillResult> => {
    if (!worktrees || typeof wtPath !== 'string') return { ok: false, message: '参数无效' };
    const rec = worktrees.findRecord(wtPath);
    if (!rec) return { ok: false, message: '登记表中没有这个工作区' };
    if (manager.getSession(rec.sessionId)) return { ok: false, message: '工作区仍有会话在使用' };
    const info: WorktreeInfo = {
      repoRoot: rec.repoRoot, path: rec.path, branch: rec.branch, baseRef: rec.baseRef, baseCommit: rec.baseCommit,
    };
    return worktrees.remove(info, force === true);
  });

  ipcMain.handle('panel:pickCwd', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  // 子代理视图切换时回放缓冲（invoke）：附带累计偏移，供渲染层与实时增量去重
  ipcMain.handle('panel:subagent-log', (_e, sessionId: string, agentId: string) =>
    subagentTracker?.getLogSnapshot(sessionId, agentId) ?? { text: '', end: 0 });

  // 导出终端输出：主进程弹保存对话框并写文件；定位只接受本次运行导出过的文件
  const exported = new Set<string>();
  ipcMain.handle('panel:export-output', async (e, id: unknown, format: unknown): Promise<ExportResult> => {
    if (typeof id !== 'string' || !isExportFormat(format)) return { ok: false, error: '参数无效' };
    const r = await exportOutput(exportDeps(manager, BrowserWindow.fromWebContents(e.sender)), id, format);
    if (r.ok && r.path) exported.add(path.resolve(r.path));
    return r;
  });
  ipcMain.handle('panel:export-reveal', (_e, file: unknown): string => {
    if (typeof file !== 'string' || !exported.has(path.resolve(file))) return '只能定位面板导出的文件';
    if (!fs.existsSync(file)) return '文件已不存在';
    shell.showItemInFolder(file);
    return '';
  });

  // 手动关闭已结束的子代理条目（运行中的由 tracker 拒绝）
  ipcMain.handle('panel:dismiss-subagent', (_e, sessionId: string, agentId: string) =>
    subagentTracker?.dismissSubagent(sessionId, agentId) ?? false);
}

/** 更新相关：目录配置、手动检查、开始安装（安装只认主进程上次检查到的清单，不接受渲染层传入路径） */
export function registerUpdaterIpc(updater: Updater): void {
  ipcMain.handle('updater:getConfig', (): UpdateConfig => updater.getConfig());

  const saveDir = (dir: unknown): UpdateDirResult => {
    try { return { ok: true, dir: updater.setUpdateDir(dir) }; } catch (err) {
      return { ok: false, error: (err as Error).message || '保存更新目录失败' };
    }
  };
  ipcMain.handle('updater:setDir', (_e, dir: unknown) => saveDir(dir));
  ipcMain.handle('updater:pickDir', async (): Promise<UpdateDirResult> => {
    const result = await dialog.showOpenDialog({
      title: '选择更新目录（局域网共享文件夹）',
      defaultPath: updater.getUpdateDir() ?? undefined,
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return saveDir(result.filePaths[0]);
  });

  ipcMain.handle('updater:check', () => updater.checkNow('manual'));
  ipcMain.handle('updater:install', () => updater.startInstall());
}
