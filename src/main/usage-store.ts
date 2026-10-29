import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import { readJson, writeJsonAtomic } from './json-store';
import type { CountTuple, RecentMap, UsageSettings } from '../shared/usage-types';
import { localDateOf } from '../shared/usage-parse';
import { defaultUsageSettings, sanitizeUsageSettings } from '../shared/usage-format';

/**
 * 用量账本持久化：账本目录下的 ledger.json 同时保存各 transcript 的读取状态与每日账本。
 * 两者放在同一个文件里原子写入，崩溃时不会出现「偏移写了、账没记」导致的重复或漏计。
 * 记账后防抖落盘；退出时同步落盘；启动时清理 90 天之前的每日数据。
 * 用量设置单独存 settings.json（低频写，便于用户手改）。
 */

export const LEDGER_VERSION = 1;
const DEFAULT_DEBOUNCE_MS = 2000;
export const KEEP_DAYS = 90;
const DAY_MS = 24 * 3600 * 1000;

export type FileKind = 'main' | 'subagent' | 'compact';

/** 主线程最近一条 assistant 的上下文占用 */
export interface LastContext {
  used: number;
  model: string;
  at: number;
  compacted: boolean;
}

/** 单个 transcript 文件的读取状态 */
export interface FileState {
  /** 所属面板会话 id */
  sessionId: string;
  kind: FileKind;
  agentId: string | null;
  /** 已消费到的字节位置（总在换行之后） */
  offset: number;
  /** 计数下限：timestamp 早于此值的消息不计 */
  countFrom: number;
  /** 去重用的最近 message.id 及其已记数值 */
  recent: RecentMap;
  /** 本文件已记入账本的量，按日期、桶拆分；文件变短时据此撤销 */
  contrib: Record<string, Record<string, CountTuple>>;
  lastContext?: LastContext;
  /** 每个模型观测到的最大单次上下文 */
  observedMax: Record<string, number>;
  /** 本文件出现过的压缩次数 */
  compactions?: number;
  /** 已提醒过的上下文档位，形如「压缩次数:档位」 */
  ctxAlerted?: string[];
  /** 会话已结束：保留偏移防止续接后重复计数，但不计入任何会话摘要 */
  detached?: boolean;
  /** 最近一次被 hook 提及或读取的时间 */
  seenAt: number;
}

export interface DaySession {
  label: string;
  models: Record<string, CountTuple>;
}

export interface DayLedger {
  models: Record<string, CountTuple>;
  sessions: Record<string, DaySession>;
  /** 旧版本记下的当日预算已提醒档位：预算功能已移除，字段只为兼容旧账本保留 */
  alerted: number[];
}

export interface Ledger {
  version: number;
  files: Record<string, FileState>;
  days: Record<string, DayLedger>;
  /** 从 cost-state 等处得知使用 1M 窗口的模型（归一化 id） */
  flagged1m: string[];
}

export function emptyLedger(): Ledger {
  return { version: LEDGER_VERSION, files: {}, days: {}, flagged1m: [] };
}

export function emptyDay(): DayLedger {
  return { models: {}, sessions: {}, alerted: [] };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 形状检查：只校验顶层结构，具体字段在使用时按缺省处理 */
function validLedger(v: unknown): v is Ledger {
  return isObj(v) && v.version === LEDGER_VERSION && isObj(v.files) && isObj(v.days)
    && (v.flagged1m === undefined || Array.isArray(v.flagged1m));
}

/** 读入后补齐缺省字段，避免旧文件或手改文件缺字段导致运行时异常 */
function normalize(l: Ledger): Ledger {
  l.flagged1m = Array.isArray(l.flagged1m) ? l.flagged1m.filter(x => typeof x === 'string') : [];
  for (const [p, f] of Object.entries(l.files)) {
    if (!isObj(f) || typeof f.sessionId !== 'string') { delete l.files[p]; continue; }
    f.offset = Number.isFinite(f.offset) && f.offset >= 0 ? f.offset : 0;
    f.countFrom = Number.isFinite(f.countFrom) ? f.countFrom : 0;
    f.recent = Array.isArray(f.recent) ? f.recent : [];
    f.contrib = isObj(f.contrib) ? f.contrib : {};
    f.observedMax = isObj(f.observedMax) ? f.observedMax : {};
    f.kind = f.kind === 'subagent' || f.kind === 'compact' ? f.kind : 'main';
    f.agentId = typeof f.agentId === 'string' ? f.agentId : null;
    f.seenAt = Number.isFinite(f.seenAt) ? f.seenAt : 0;
  }
  for (const [d, day] of Object.entries(l.days)) {
    if (!isObj(day)) { delete l.days[d]; continue; }
    day.models = isObj(day.models) ? day.models : {};
    day.sessions = isObj(day.sessions) ? day.sessions : {};
    day.alerted = Array.isArray(day.alerted) ? day.alerted.filter(x => typeof x === 'number') : [];
  }
  return l;
}

export interface UsageStoreOptions {
  debounceMs?: number;
  now?: () => number;
}

export class UsageStore {
  readonly file: string;
  ledger: Ledger = emptyLedger();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private disposed = false;
  private readonly debounceMs: number;
  private readonly now: () => number;

  constructor(readonly dir: string, opts: UsageStoreOptions = {}) {
    this.file = path.join(dir, 'ledger.json');
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * 读入账本。不存在时为空账本；损坏时备份为 ledger.json.bad- 加时间戳后重建空账本
   * （之后各文件从偏移 0 重读，计数下限防止计入会话创建前的内容）。
   */
  load(): Ledger {
    const exists = fs.existsSync(this.file);
    const raw = exists ? readJson<unknown>(this.file, { tag: 'usage' }) : null;
    if (raw !== null && validLedger(raw)) {
      this.ledger = normalize(raw);
    } else {
      this.ledger = emptyLedger();
      if (exists) this.backupBroken();
    }
    this.pruneDays();
    return this.ledger;
  }

  private backupBroken(): void {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const bad = `${this.file}.bad-${stamp}`;
    try {
      fs.renameSync(this.file, bad);
      log('usage', `用量账本损坏，已备份为 ${bad} 并重建空账本；此前的历史用量需从 transcript 重新累计`);
    } catch (err) {
      log('usage', `用量账本损坏且备份失败：${String(err)}`);
    }
  }

  /** 删除 90 天之前的每日数据与长期未提及的已结束文件状态 */
  pruneDays(): number {
    const cutoff = localDateOf(this.now() - KEEP_DAYS * DAY_MS);
    let removed = 0;
    for (const d of Object.keys(this.ledger.days)) {
      if (d < cutoff) { delete this.ledger.days[d]; removed++; }
    }
    const fileCutoff = this.now() - KEEP_DAYS * DAY_MS;
    for (const [p, f] of Object.entries(this.ledger.files)) {
      if (f.detached && f.seenAt < fileCutoff) delete this.ledger.files[p];
    }
    if (removed > 0) this.markDirty();
    return removed;
  }

  /** 标记有改动，防抖落盘 */
  markDirty(): void {
    this.dirty = true;
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushSync();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** 立即同步落盘（退出时调用）；没有改动时不写 */
  flushSync(): boolean {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return true;
    const ok = writeJsonAtomic(this.file, this.ledger, { tag: 'usage', indent: 0 });
    if (ok) this.dirty = false;
    return ok;
  }

  dispose(): void {
    this.flushSync();
    this.disposed = true;
  }

  get settingsFile(): string {
    return path.join(this.dir, 'settings.json');
  }

  /** 读设置：缺失用默认值；损坏或不合法时用默认值并记一次日志（不覆盖原文件，便于用户手改修复） */
  loadSettings(): UsageSettings {
    if (!fs.existsSync(this.settingsFile)) return defaultUsageSettings();
    const raw = readJson<unknown>(this.settingsFile, { tag: 'usage' });
    const r = raw === null ? null : sanitizeUsageSettings(raw);
    if (r?.ok) return r.value;
    log('usage', `用量设置无效，使用默认值：${r ? r.error : '无法解析'}（${this.settingsFile}）`);
    return defaultUsageSettings();
  }

  /** 写设置（调用方已校验） */
  saveSettings(s: UsageSettings): boolean {
    return writeJsonAtomic(this.settingsFile, s, { tag: 'usage', indent: 2 });
  }
}
