import { BrowserWindow, dialog, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { ChangeTracker } from './change-tracker';
import type { GitRunner } from './git-runner';
import { log } from './logger';
import { isIsolatedInstance } from './panel-home';
import type { SessionManager } from './session-manager';
import { templateContext, type TemplateStore } from './template-store';
import type { PromptTemplate, TemplateContext, TemplateSaveResult } from '../shared/template';

/**
 * 模板 IPC：增删改查与使用计数、按会话或表单目录计算内置变量、为文件变量弹出文件选择框。
 * 目录来源只有两种：已存在会话的 cwd，或渲染层传入且存在的目录（新建表单里会话还没创建）。
 */

export interface TemplateIpcDeps {
  store: TemplateStore;
  git: GitRunner;
  manager: Pick<SessionManager, 'getSession'>;
  changes?: Pick<ChangeTracker, 'getChanges'>;
}

export interface PickedFile { path: string; absolute: boolean }

/** 会话 cwd 优先；没有会话时用渲染层传入的已存在目录 */
function resolveCwd(deps: TemplateIpcDeps, sessionId: unknown, cwd: unknown): { cwd: string; sessionId?: string } | null {
  if (typeof sessionId === 'string' && sessionId) {
    const s = deps.manager.getSession(sessionId);
    if (s) return { cwd: s.cwd, sessionId: s.id };
  }
  if (typeof cwd === 'string' && cwd.trim() && fs.existsSync(cwd.trim())) return { cwd: cwd.trim() };
  return null;
}

/** cwd 内的文件给相对路径（正斜杠），cwd 以外的给绝对路径 */
export function relativeToCwd(cwd: string, file: string): PickedFile {
  const rel = path.relative(cwd, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { path: file, absolute: true };
  return { path: rel.split(path.sep).join('/'), absolute: false };
}

export function registerTemplateIpc(deps: TemplateIpcDeps): void {
  const { store } = deps;
  ipcMain.handle('templates:list', (): PromptTemplate[] => store.list());
  ipcMain.handle('templates:save', (_e, input: unknown): TemplateSaveResult => store.save(input));
  ipcMain.handle('templates:remove', (_e, id: unknown): boolean => (typeof id === 'string' ? store.remove(id) : false));
  ipcMain.handle('templates:touch', (_e, id: unknown): PromptTemplate | null =>
    (typeof id === 'string' ? store.touch(id) : undefined) ?? null);

  ipcMain.handle('templates:context', async (_e, sessionId: unknown, cwd: unknown): Promise<TemplateContext | null> => {
    const r = resolveCwd(deps, sessionId, cwd);
    if (!r) return null;
    const s = r.sessionId ? deps.manager.getSession(r.sessionId) : undefined;
    let changedFiles: string[] | undefined;
    if (s && deps.changes) {
      try {
        changedFiles = (await deps.changes.getChanges(s.id)).files.map(f => f.path);
      } catch (err) {
        log('templates', `读取会话改动失败，改用 git status：${String(err)}`);
      }
    }
    return templateContext(deps.git, { cwd: r.cwd, repoRoot: s?.worktree?.repoRoot, changedFiles });
  });

  // 隔离实例设置了 CLAUDE_PANEL_TEST_PICK_FILE 时跳过文件对话框、直接返回该文件，正式实例忽略该变量
  ipcMain.handle('templates:pick-file', async (e, sessionId: unknown, cwd: unknown): Promise<PickedFile | null> => {
    const r = resolveCwd(deps, sessionId, cwd);
    const testFile = isIsolatedInstance() ? process.env.CLAUDE_PANEL_TEST_PICK_FILE : undefined;
    let file: string | undefined;
    if (testFile) {
      file = testFile;
    } else {
      const win = BrowserWindow.fromWebContents(e.sender);
      const opts = { title: '选择文件', defaultPath: r?.cwd, properties: ['openFile' as const] };
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      file = res.canceled ? undefined : res.filePaths[0];
    }
    if (!file) return null;
    return r ? relativeToCwd(r.cwd, file) : { path: file, absolute: true };
  });
}
