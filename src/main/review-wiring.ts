import * as fs from 'fs';
import * as path from 'path';
import { WriteGuard } from './write-guard';
import { CommandLog } from './command-log';
import { FileRevert } from './file-revert';
import { WorktreeFinisher } from './worktree-finisher';
import { registerRevertIpc } from './ipc-revert';
import { SessionRevert } from './session-revert';
import { registerSessionChangesIpc } from './ipc-session-changes';
import { registerFinishIpc } from './ipc-finish';
import { createCliRunner, type CliRunner } from './cli-runner';
import { sanitizeChildEnv } from './claude-launch';
import { log } from './logger';
import { isIsolatedInstance } from './panel-home';
import { InternalSessions } from './internal-session';
import type { OutboxSubscriber } from './annotation-wiring';
import type { GitRunner } from './git-runner';
import type { ChangeTracker } from './change-tracker';
import type { SessionChanges } from './session-changes';
import type { SessionManager } from './session-manager';
import type { PromptInjector } from './prompt-injector';
import type { Session } from '../shared/types';
import type { ActivityReporter } from '../shared/activity';

/**
 * 写操作类功能（撤销文件、工作区收尾）的接线：共用一个仓库写锁与一份命令记录，
 * 在 SessionManager 创建之后挂接并注册各自的 IPC。
 */

export interface ReviewWiringDeps {
  home: string;
  git: GitRunner;
  changes: ChangeTracker;
  /** 本会话改动（按 Claude 动过的文件统计） */
  sessionChanges?: SessionChanges;
  /** 外部编辑器命令（空串为未配置）；带行号打开改动文件时使用 */
  editor?: { command(): string };
  /** mock 模式下 claude -p 由 mock-claude.js 回答 */
  mock?: { node: string; script: string };
  /** 发件箱注入器（批注接线创建），收尾页的提示词发送复用它 */
  injector: () => PromptInjector | undefined;
  /** 订阅注入器的发出与丢弃回调 */
  subscribe: (s: OutboxSubscriber) => () => void;
  /** 推给渲染层的 toast */
  notice: (sessionId: string, message: string, level: 'info' | 'warning') => void;
  openExternal: (url: string) => Promise<void>;
  /** 活动日志：收尾的提交与合并结果上报到这里 */
  activity?: ActivityReporter;
}

/** claude -p 的运行器：环境去掉上层 Claude Code 会话的标记变量 */
export function claudeRunner(mock?: { node: string; script: string }): CliRunner {
  const baseEnv = sanitizeChildEnv(process.env);
  if (mock) return createCliRunner({ file: mock.node, prefixArgs: [mock.script], baseEnv });
  if (process.platform === 'win32') return createCliRunner({ file: 'cmd.exe', prefixArgs: ['/c', 'claude.cmd'], baseEnv });
  return createCliRunner({ file: 'claude', baseEnv });
}

/**
 * 打开外部链接：只允许 http/https。隔离实例设置了 CLAUDE_PANEL_OPEN_EXTERNAL_LOG 时只把链接追加到该文件、不真正打开，
 * 供自测断言；正式实例下这个变量被忽略。
 */
export function externalOpener(open: (url: string) => Promise<void>): (url: string) => Promise<void> {
  const file = process.env.CLAUDE_PANEL_OPEN_EXTERNAL_LOG;
  const record = !!file && isIsolatedInstance();
  return async url => {
    if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http/https 链接');
    if (record && file) {
      fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), url })}\n`);
      return;
    }
    await open(url);
  };
}

export class ReviewWiring {
  readonly guard: WriteGuard;
  readonly log = new CommandLog();
  revert!: FileRevert;
  /** 本会话改动的撤销；没有接入本会话改动时缺省 */
  sessionRevert?: SessionRevert;
  finisher!: WorktreeFinisher;
  /** 带初始提示词的内部会话（解决冲突的会话） */
  internal!: InternalSessions;

  constructor(private readonly deps: ReviewWiringDeps) {
    this.guard = new WriteGuard(deps.git);
  }

  attach(manager: SessionManager): void {
    const { home, git, changes } = this.deps;
    this.revert = new FileRevert({
      home, git, guard: this.guard, log: this.log, tracker: changes,
      getSession: id => manager.getSession(id),
      isBusy: id => manager.isBusy(id),
    });
    registerRevertIpc(this.revert);

    const sessionChanges = this.deps.sessionChanges;
    if (sessionChanges) {
      this.sessionRevert = new SessionRevert({
        home, guard: this.guard, changes: sessionChanges,
        getSession: id => manager.getSession(id),
        isBusy: id => manager.isBusy(id),
      });
      registerSessionChangesIpc({
        changes: sessionChanges, revert: this.sessionRevert, editor: this.deps.editor,
        exists: id => !!manager.getSession(id),
      });
    }

    this.finisher = new WorktreeFinisher({
      git,
      gh: createCliRunner({ file: 'gh', baseEnv: sanitizeChildEnv(process.env) }),
      claude: claudeRunner(this.deps.mock),
      log: this.log,
      guard: this.guard,
      sessions: {
        get: id => manager.getSession(id),
        list: () => manager.getSessions(),
        isBusy: id => manager.isBusy(id),
      },
      tracker: changes,
      tmpDir: path.join(home, 'tmp'),
      activity: this.deps.activity,
    });
    this.internal = new InternalSessions({
      manager, injector: this.deps.injector, notice: this.deps.notice,
      changed: () => manager.notifyChanged(),
    });
    this.deps.subscribe({
      onSent: item => this.internal.onSent(item),
      onDropped: (item, reason) => this.internal.onDropped(item, reason),
    });
    registerFinishIpc({
      finisher: this.finisher,
      log: this.log,
      injector: this.deps.injector,
      internal: this.internal,
      openExternal: this.deps.openExternal,
      conflictSession: id => this.conflictSession(id),
    });
  }

  /** 为主工作区的冲突开一个会话：cwd 为主工作区根，冲突提示词等 Claude 就绪后自动粘贴 */
  async conflictSession(id: string): Promise<Session | { error: string }> {
    const p = await this.finisher.conflictPrompt(id);
    if ('error' in p) return p;
    const r = this.internal.start(`解决冲突：${p.label}`, p.info.repoRoot, p.text, { reason: 'conflict' });
    if (!('error' in r)) log('finish', `为 ${p.files.length} 个冲突文件创建解决冲突的会话 ${r.id.slice(0, 8)}`);
    return r;
  }

  /** 启动时清理过期的撤销备份 */
  pruneOnStartup(): void {
    const n = (this.revert?.prune() ?? 0) + (this.sessionRevert?.prune() ?? 0);
    if (n > 0) log('revert', `清理撤销备份 ${n} 份`);
  }
}
