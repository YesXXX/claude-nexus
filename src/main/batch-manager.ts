import { randomUUID } from 'crypto';
import { log } from './logger';
import { readJson, writeJsonAtomic } from './json-store';
import type { LaunchInput } from './session-launcher';
import {
  BATCH_MAX, BATCH_MIN, batchItemLabel, normalizeBatch, topChangedFiles,
  type BatchCreateInput, type BatchCreateResult, type BatchDiscardPreview, type BatchDiscardResult,
  type BatchItemView, type BatchProgress, type BatchRecord, type BatchView,
} from '../shared/batch-types';
import type {
  ChangeList, KillResult, PanelEvent, Session, WorktreeInfo, WorktreeStatus,
} from '../shared/types';

/** resolved / ended 的批次记录保留这么久 */
export const BATCH_RETAIN_MS = 30 * 24 * 3600_000;
/** 首条提示词上限与单个新建一致 */
const PROMPT_MAX = 100_000;

export interface BatchManagerDeps {
  /** batches.json 路径 */
  file: string;
  launch(input: LaunchInput): Promise<Session>;
  end(id: string, opts: { force: boolean }): Promise<KillResult>;
  getSession(id: string): Session | undefined;
  /** 探测目录所属仓库：只接受有提交的普通仓库 */
  inspect(cwd: string): Promise<{ state: string; repoRoot?: string; head?: string }>;
  /** 把基线解析成完整提交号，不存在返回 undefined */
  resolveCommit(cwd: string, ref: string): Promise<string | undefined>;
  /** 相对基线口径的改动列表，不改写会话在改动面板里选的口径 */
  getChanges(id: string): Promise<ChangeList>;
  worktreeStatus(info: WorktreeInfo): Promise<WorktreeStatus>;
  /** 批次记录或统计变化（渲染层据此刷新对比视图） */
  onChange?(batchId: string): void;
  now?: () => number;
  uuid?: () => string;
}

/** 会话是否仍有进程：跨重启恢复的待续接行、已退出的会话都算不在运行 */
export function sessionAlive(s: Session | undefined): boolean {
  return !!s && !s.dormant && s.status !== 'suspended' && s.exitCode === undefined;
}

/**
 * 批量派发：同一条首条提示词派发给 N 个独立工作区会话，记录批次归属与每个方案的轮数，
 * 生成对比数据，以及「保留其一、丢弃其余」与「全部放弃」。
 * 工作区按顺序创建（git worktree add 会锁 refs，并发容易撞锁），单个失败不影响其余；
 * 全部失败时不写记录，工作区与分支由会话启动逻辑各自回滚。
 */
export class BatchManager {
  private batches = new Map<string, BatchRecord>();
  private readonly now: () => number;

  constructor(private readonly deps: BatchManagerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** 读入批次文件并清理过期的已结束批次；文件损坏时以空列表启动 */
  load(): void {
    const raw = readJson<unknown>(this.deps.file, { tag: 'batch' });
    const list = Array.isArray(raw) ? raw.map(normalizeBatch).filter((b): b is BatchRecord => !!b) : [];
    const cutoff = this.now() - BATCH_RETAIN_MS;
    const kept = list.filter(b => b.status === 'active' || (b.endedAt ?? b.createdAt) >= cutoff);
    this.batches = new Map(kept.map(b => [b.id, b]));
    if (kept.length !== list.length) {
      log('batch', `清理过期批次记录 ${list.length - kept.length} 条`);
      this.save();
    }
  }

  get(id: string): BatchRecord | undefined {
    const b = this.batches.get(id);
    if (b) this.settle(b);
    return b;
  }

  /** 全部批次，最新在前；会话已全部不在列表里的进行中批次在这里转为已结束 */
  list(): BatchRecord[] {
    const out = [...this.batches.values()];
    for (const b of out) this.settle(b);
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 会话所属的批次 id（按批次记录反查，不依赖会话对象上的字段） */
  batchOf(sessionId: string): string | undefined {
    for (const b of this.batches.values()) if (b.sessionIds.includes(sessionId)) return b.id;
    return undefined;
  }

  async create(input: BatchCreateInput, onProgress?: (p: BatchProgress) => void): Promise<BatchCreateResult> {
    const label = input.label.trim();
    const prompt = input.prompt.trim();
    const count = Math.floor(input.count);
    if (!label) throw new Error('任务标签不能为空');
    if (!prompt) throw new Error('批量派发需要填写首条提示词');
    if (prompt.length > PROMPT_MAX) throw new Error(`首条提示词过长（上限 ${PROMPT_MAX} 字）`);
    if (!(count >= BATCH_MIN && count <= BATCH_MAX)) throw new Error(`方案数需在 ${BATCH_MIN}～${BATCH_MAX} 之间`);
    const repo = await this.deps.inspect(input.cwd);
    if (repo.state !== 'repo' || !repo.repoRoot || !repo.head) {
      throw new Error(repo.state === 'no_commit' ? '仓库还没有提交，无法创建独立工作区' : '批量派发需要在 git 仓库中进行');
    }
    const baseRef = input.baseRef?.trim() || repo.head;
    const baseCommit = await this.deps.resolveCommit(input.cwd, baseRef);
    if (!baseCommit) throw new Error(`基线不存在：${baseRef}`);

    const batch: BatchRecord = {
      id: (this.deps.uuid ?? randomUUID)(), label, prompt, cwd: input.cwd, repoRoot: repo.repoRoot,
      baseRef, baseCommit, sessionIds: [], indexes: {}, stats: {}, createdAt: this.now(), status: 'active',
    };
    const result: BatchCreateResult = { sessions: [], errors: [] };
    log('batch', `批量派发「${label}」×${count}，基线 ${baseRef}@${baseCommit.slice(0, 8)}`);
    for (let i = 1; i <= count; i++) {
      const itemLabel = batchItemLabel(label, i);
      onProgress?.({ done: i - 1, total: count, label: itemLabel });
      try {
        const s = await this.deps.launch({
          label: itemLabel, cwd: input.cwd, worktree: true, baseRef, initialPrompt: prompt, batchId: batch.id,
        });
        batch.sessionIds.push(s.id);
        batch.indexes[s.id] = i;
        batch.stats[s.id] = { turns: 0 };
        result.sessions.push(s);
        // 第一个方案起来后才登记批次：全部失败时不留记录
        this.batches.set(batch.id, batch);
        this.save();
        this.deps.onChange?.(batch.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('batch', `方案 #${i} 创建失败：${message}`);
        result.errors.push({ index: i, message });
      }
    }
    onProgress?.({ done: count, total: count, label });
    if (batch.sessionIds.length > 0) result.batch = batch;
    return result;
  }

  /** 对比数据：每个方案的状态、用时、相对基线的改动与验证结果 */
  async view(id: string): Promise<BatchView | null> {
    const b = this.get(id);
    if (!b) return null;
    const items = await Promise.all(b.sessionIds.map(sid => this.item(b, sid)));
    return { batch: b, items };
  }

  /** 保留或全部放弃前的确认信息：将被丢弃方案的未提交文件数与未合并提交数 */
  async preview(id: string, keepSessionId?: string): Promise<BatchDiscardPreview[]> {
    const b = this.get(id);
    if (!b) return [];
    const out: BatchDiscardPreview[] = [];
    for (const sid of b.sessionIds) {
      if (sid === keepSessionId) continue;
      const s = this.deps.getSession(sid);
      const p: BatchDiscardPreview = {
        sessionId: sid, index: b.indexes[sid] ?? 0, label: s?.label ?? batchItemLabel(b.label, b.indexes[sid] ?? 0),
        alive: sessionAlive(s),
      };
      if (s?.worktree) {
        p.worktree = s.worktree;
        try {
          p.status = await this.deps.worktreeStatus(s.worktree);
        } catch (err) {
          log('batch', `读取工作区状态失败 ${s.worktree.path}：${String(err)}`);
        }
      }
      out.push(p);
    }
    return out;
  }

  /** 保留一个方案：其余会话结束并删除工作区与分支，保留的会话不动；批次转为 resolved */
  async keep(id: string, keepSessionId: string): Promise<BatchDiscardResult[]> {
    const b = this.get(id);
    if (!b) throw new Error('批次不存在');
    if (!b.sessionIds.includes(keepSessionId)) throw new Error('该会话不属于此批次');
    if (b.status === 'resolved') throw new Error('该批次已保留过方案');
    const results = await this.discard(b, keepSessionId);
    b.status = 'resolved';
    b.keptSessionId = keepSessionId;
    b.endedAt = this.now();
    this.save();
    this.deps.onChange?.(b.id);
    log('batch', `批次「${b.label}」保留 #${b.indexes[keepSessionId]}，清理 ${results.length} 个方案`);
    return results;
  }

  /** 全部放弃：所有方案结束并删除工作区；批次转为 ended */
  async discardAll(id: string): Promise<BatchDiscardResult[]> {
    const b = this.get(id);
    if (!b) throw new Error('批次不存在');
    const results = await this.discard(b);
    if (b.status === 'active') b.status = 'ended';
    b.endedAt = b.endedAt ?? this.now();
    this.save();
    this.deps.onChange?.(b.id);
    log('batch', `批次「${b.label}」全部放弃，清理 ${results.length} 个方案`);
    return results;
  }

  /** 只删除记录，限已结束或已保留的批次 */
  forget(id: string): boolean {
    const b = this.get(id);
    if (!b || b.status === 'active') return false;
    this.batches.delete(id);
    this.save();
    this.deps.onChange?.(id);
    return true;
  }

  /** 会话事件：一轮结束时累计轮数并通知刷新 */
  onEvent(sessionId: string, event: PanelEvent): void {
    if (event.type !== 'turn_completed') return;
    const bid = this.batchOf(sessionId);
    const b = bid ? this.batches.get(bid) : undefined;
    if (!b) return;
    const st = b.stats[sessionId] ?? { turns: 0 };
    st.turns += 1;
    st.lastTurnAt = this.now();
    b.stats[sessionId] = st;
    this.save();
    this.deps.onChange?.(b.id);
  }

  /** 会话被移出列表：批次可能因此全部结束 */
  onDetach(sessionId: string): void {
    const bid = this.batchOf(sessionId);
    const b = bid ? this.batches.get(bid) : undefined;
    if (b && this.settle(b)) this.deps.onChange?.(b.id);
  }

  private async discard(b: BatchRecord, keepSessionId?: string): Promise<BatchDiscardResult[]> {
    const results: BatchDiscardResult[] = [];
    for (const sid of b.sessionIds) {
      if (sid === keepSessionId) continue;
      const index = b.indexes[sid] ?? 0;
      if (!this.deps.getSession(sid)) {
        results.push({ sessionId: sid, index, result: { ok: true, message: '会话已不在列表中' } });
        continue;
      }
      try {
        results.push({ sessionId: sid, index, result: await this.deps.end(sid, { force: true }) });
      } catch (err) {
        results.push({ sessionId: sid, index, result: { ok: false, message: String(err) } });
      }
    }
    return results;
  }

  private async item(b: BatchRecord, sid: string): Promise<BatchItemView> {
    const s = this.deps.getSession(sid);
    const index = b.indexes[sid] ?? 0;
    const st = b.stats[sid] ?? { turns: 0 };
    const alive = sessionAlive(s);
    const busy = alive && (s?.busy || s?.status === 'running' || s?.status === 'waiting_permission');
    const end = busy ? this.now() : st.lastTurnAt ?? (alive ? this.now() : b.endedAt ?? this.now());
    const item: BatchItemView = {
      sessionId: sid, index, label: s?.label ?? batchItemLabel(b.label, index), alive,
      durationMs: Math.max(0, end - (s?.createdAt ?? b.createdAt)),
      turnsCompleted: st.turns, topFiles: [],
    };
    if (!s) return item;
    item.status = s.status;
    if (s.worktree) item.worktree = s.worktree;
    if (s.verify) item.verify = s.verify;
    if (!s.worktree) return item;
    try {
      const c = await this.deps.getChanges(sid);
      item.changes = c.summary;
      item.topFiles = topChangedFiles(c.files);
      if (c.summary.error) item.error = c.summary.error;
    } catch (err) {
      item.error = String(err);
    }
    return item;
  }

  /** 进行中批次的会话都已不在列表里时转为 ended；返回是否有变化 */
  private settle(b: BatchRecord): boolean {
    if (b.status !== 'active') return false;
    if (b.sessionIds.some(sid => this.deps.getSession(sid))) return false;
    b.status = 'ended';
    b.endedAt = this.now();
    this.save();
    return true;
  }

  private save(): void {
    writeJsonAtomic(this.deps.file, [...this.batches.values()], { tag: 'batch' });
  }
}
