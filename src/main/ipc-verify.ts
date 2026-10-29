import { ipcMain, shell } from 'electron';
import type { GitRunner } from './git-runner';
import { log } from './logger';
import type { SessionManager } from './session-manager';
import { resolveRepoKey, type RepoKeyInfo, type VerifyConfigStore } from './verify-config';
import { buildVerifyFixPrompt } from './verify-prompt';
import type { ResolvedVerifyConfig, VerifyRunner } from './verify-runner';
import type { PromptSendResult, Session } from '../shared/types';
import type {
  VerifyActionResult, VerifyConfig, VerifyConfigView, VerifyDetail, VerifyGlobal,
} from '../shared/verify-types';

/**
 * 自动验证的 IPC 与配置解析。写配置时的仓库键必须是之前由 get-config 返回过的，
 * 防止渲染层往 verify.json 写入任意键。
 */

export interface VerifyIpcDeps {
  runner: VerifyRunner;
  store: VerifyConfigStore;
  git: GitRunner;
  manager: Pick<SessionManager, 'getSession'>;
  /** 写入会话输入框并提交（提示词注入器） */
  insert: (id: string, text: string, submit: boolean) => PromptSendResult;
}

/** 「发给 Claude 修复」前的检查：结果须为失败或超时，会话须空闲；可发时返回 undefined */
export function fixBlockReason(s: Session | undefined, d: VerifyDetail | undefined): string | undefined {
  if (!s) return '会话不存在';
  if (!d || (d.status !== 'failed' && d.status !== 'timeout')) return '最近一次验证没有失败，无需修复';
  if (s.readOnly) return '只读会话不能代输';
  if (s.busy || (s.status !== 'completed' && s.status !== 'waiting_input')) return 'Claude 正忙，等这一轮结束再发送';
  return undefined;
}

/** 会话目录到仓库键的缓存（同一目录的仓库归属不会变） */
export class RepoKeyResolver {
  private readonly cache = new Map<string, Promise<RepoKeyInfo>>();

  constructor(private readonly git: GitRunner) {}

  resolve(cwd: string, repoRoot?: string): Promise<RepoKeyInfo> {
    const k = `${repoRoot ?? ''}|${cwd}`;
    let p = this.cache.get(k);
    if (!p) {
      p = resolveRepoKey(this.git, cwd, repoRoot);
      this.cache.set(k, p);
      // 失败（目录暂不存在等）不缓存，下次重试
      p.then(info => { if (!info.isRepo) this.cache.delete(k); }, () => this.cache.delete(k));
    }
    return p;
  }
}

/** 运行器用的配置解析：会话 → 仓库键 → 配置 */
export function configResolver(
  manager: Pick<SessionManager, 'getSession'>, store: VerifyConfigStore, keys: RepoKeyResolver,
): (id: string) => Promise<ResolvedVerifyConfig | null> {
  return async id => {
    const s = manager.getSession(id);
    if (!s) return null;
    const info = await keys.resolve(s.cwd, s.worktree?.repoRoot);
    return { key: info.key, config: store.get(info.key) };
  };
}

export function registerVerifyIpc(deps: VerifyIpcDeps, keys: RepoKeyResolver): void {
  const { runner, store, manager } = deps;
  const knownKeys = new Set<string>();
  const sid = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

  ipcMain.handle('verify:get-config', async (_e, id: unknown): Promise<VerifyConfigView | null> => {
    const s = sid(id) ? manager.getSession(sid(id)!) : undefined;
    if (!s) return null;
    const info = await keys.resolve(s.cwd, s.worktree?.repoRoot);
    knownKeys.add(info.key);
    return { repoKey: info.key, repoRoot: info.root, isRepo: info.isRepo, config: store.get(info.key), global: store.global() };
  });

  ipcMain.handle('verify:set-config', (_e, key: unknown, config: unknown):
  { ok: true; config: VerifyConfig | null } | { ok: false; error: string } => {
    if (typeof key !== 'string' || !knownKeys.has(key)) return { ok: false, error: '仓库无效，请重新打开配置' };
    const r = store.set(key, config ?? null);
    if (r.ok) log('verify', `验证配置已${r.config ? '保存' : '删除'}：${key}`);
    return r;
  });

  ipcMain.handle('verify:get-global', (): VerifyGlobal => store.global());

  ipcMain.handle('verify:set-global', (_e, g: unknown): VerifyGlobal => {
    const next = store.setGlobal(g);
    runner.kick();
    return next;
  });

  ipcMain.handle('verify:run', (_e, id: unknown): Promise<VerifyActionResult> =>
    (sid(id) ? runner.run(sid(id)!) : Promise.resolve({ ok: false, reason: '会话不存在' })));

  ipcMain.handle('verify:cancel', (_e, id: unknown): boolean => (sid(id) ? runner.cancelManual(sid(id)!) : false));

  ipcMain.handle('verify:detail', (_e, id: unknown): VerifyDetail | null =>
    (sid(id) ? runner.getDetail(sid(id)!) ?? null : null));

  // 修复提示词由主进程按最近一次结果生成，渲染层只传会话 id
  ipcMain.handle('verify:send-to-claude', (_e, id: unknown): VerifyActionResult => {
    const key = sid(id);
    if (!key) return { ok: false, reason: '会话不存在' };
    const detail = runner.getDetail(key);
    const blocked = fixBlockReason(manager.getSession(key), detail);
    if (blocked) return { ok: false, reason: blocked };
    const r = deps.insert(key, buildVerifyFixPrompt(detail!), true);
    if (r.ok) log('verify', `会话 ${key.slice(0, 8)} 已把验证失败输出发给 Claude`);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  });

  // 只能打开该会话自己的日志文件（路径由运行器给出，不接受渲染层传入路径）
  ipcMain.handle('verify:open-log', async (_e, id: unknown): Promise<VerifyActionResult> => {
    const file = sid(id) ? runner.logFile(sid(id)!) : undefined;
    if (!file) return { ok: false, reason: '没有可打开的日志' };
    const err = await shell.openPath(file);
    return err ? { ok: false, reason: err } : { ok: true };
  });
}
