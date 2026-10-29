import { ipcMain } from 'electron';
import type { WorktreeFinisher } from './worktree-finisher';
import type { CommandLog } from './command-log';
import type { PromptInjector } from './prompt-injector';
import type { SuggestResult } from './commit-message';
import { selfCommitPrompt } from './finish-prompts';
import type { InternalSessions } from './internal-session';
import type { Session } from '../shared/types';
import type { CommandRecord, FinishStatus, GitOpResult, OutboxReason, OutboxWhen, SendResult } from '../shared/review-types';

/**
 * 收尾 IPC：状态、提交、生成提交信息、合并、放弃合并、推送、建 PR、打开比较页、解决冲突会话、操作记录，
 * 以及收尾页里「让本会话自己提交 / 在工作区里合入基线」的提示词发送。
 * 新会话就绪超时后保留的提示词（种类 pending）可查询、手动发送或放弃。
 * 参数一律按 unknown 校验；提示词正文、冲突文件、比较页链接都由主进程生成，渲染层只能选择种类。
 */

export interface FinishIpcDeps {
  finisher: WorktreeFinisher;
  log: CommandLog;
  injector: () => PromptInjector | undefined;
  internal: Pick<InternalSessions, 'pendingOf' | 'sendPending' | 'discardPending'>;
  /** 打开外部链接（正式实例为 shell.openExternal） */
  openExternal: (url: string) => Promise<void>;
  /** 为主工作区的冲突创建解决冲突的会话 */
  conflictSession: (id: string) => Promise<Session | { error: string }>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const flag = (o: unknown, k: string): boolean => !!o && typeof o === 'object' && (o as Record<string, unknown>)[k] === true;
const field = (o: unknown, k: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined);
const bad = (message: string): GitOpResult => ({ ok: false, message, steps: [] });
const WHEN: OutboxWhen[] = ['now', 'queue', 'auto'];

export function registerFinishIpc(deps: FinishIpcDeps): void {
  const { finisher } = deps;

  ipcMain.handle('panel:finish-status', async (_e, id: unknown): Promise<FinishStatus | { error: string }> => {
    const s = str(id);
    return s ? finisher.status(s) : { error: '参数无效' };
  });
  ipcMain.handle('panel:finish-commit', async (_e, id: unknown, msg: unknown, opts: unknown): Promise<GitOpResult> => {
    const s = str(id);
    if (!s) return bad('参数无效');
    return finisher.commit(s, text(msg), { noVerify: flag(opts, 'noVerify'), force: flag(opts, 'force') });
  });
  ipcMain.handle('panel:finish-suggest', async (_e, id: unknown): Promise<SuggestResult> => {
    const s = str(id);
    return s ? finisher.suggest(s) : { ok: false, error: '参数无效' };
  });
  ipcMain.handle('panel:finish-merge', async (_e, id: unknown, opts: unknown): Promise<GitOpResult> => {
    const s = str(id);
    if (!s) return bad('参数无效');
    return finisher.merge(s, { ffOnly: flag(opts, 'ffOnly'), force: flag(opts, 'force'), message: text(field(opts, 'message')) });
  });
  ipcMain.handle('panel:finish-merge-abort', async (_e, id: unknown): Promise<GitOpResult> => {
    const s = str(id);
    return s ? finisher.abortMerge(s) : bad('参数无效');
  });
  ipcMain.handle('panel:finish-push', async (_e, id: unknown, remote: unknown): Promise<GitOpResult> => {
    const s = str(id);
    const r = str(remote);
    return s && r ? finisher.push(s, r) : bad('参数无效');
  });
  ipcMain.handle('panel:finish-pr', async (_e, id: unknown, opts: unknown): Promise<GitOpResult> => {
    const s = str(id);
    const remote = str(field(opts, 'remote'));
    if (!s || !remote) return bad('参数无效');
    return finisher.pr(s, {
      remote, title: text(field(opts, 'title')), body: text(field(opts, 'body')), pushFirst: flag(opts, 'pushFirst'),
    });
  });
  ipcMain.handle('panel:finish-open-compare', async (_e, id: unknown, remote: unknown): Promise<string> => {
    const s = str(id);
    const r = str(remote);
    if (!s || !r) return '参数无效';
    const url = await finisher.compareUrl(s, r);
    if (!url) return '该远端无法生成比较页链接';
    try {
      await deps.openExternal(url);
      return '';
    } catch (err) {
      return `打开链接失败：${err instanceof Error ? err.message : String(err)}`;
    }
  });
  ipcMain.handle('panel:finish-conflict-session', async (_e, id: unknown): Promise<Session | { error: string }> => {
    const s = str(id);
    return s ? deps.conflictSession(s) : { error: '参数无效' };
  });
  ipcMain.handle('panel:finish-log', (_e, id: unknown): CommandRecord[] => {
    const s = str(id);
    return s ? deps.log.list(s) : [];
  });
  ipcMain.handle('panel:prompt-send', async (_e, id: unknown, reason: unknown, opts: unknown): Promise<SendResult> => {
    const s = str(id);
    const w = field(opts, 'when');
    const when = WHEN.find(x => x === w) ?? 'auto';
    const fault = (message: string): SendResult => ({ ok: false, sent: false, queued: false, message });
    const injector = deps.injector();
    if (!s || !injector) return fault('参数无效');
    if (reason === 'pending') return deps.internal.sendPending(s, when);
    let body: string;
    if (reason === 'commit') body = selfCommitPrompt();
    else if (reason === 'merge-in-worktree') {
      const p = await finisher.mergeInWorktreePrompt(s);
      if (typeof p !== 'string') return fault(p.error);
      body = p;
    } else return fault('不支持的提示词种类');
    return injector.send(s, body, { when, reason });
  });
  ipcMain.handle('panel:prompt-pending', (_e, id: unknown): OutboxReason | null => {
    const s = str(id);
    return (s && deps.internal.pendingOf(s)) || null;
  });
  ipcMain.handle('panel:prompt-discard', (_e, id: unknown): boolean => {
    const s = str(id);
    return s ? deps.internal.discardPending(s) : false;
  });
}
