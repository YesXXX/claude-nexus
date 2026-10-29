import * as fs from 'fs';
import * as path from 'path';
import { isActivityLevel, isActivityType, type ActivityEvent } from '../shared/activity';
import { writeTextAtomic } from './json-store';
import { log } from './logger';

/**
 * 活动日志的 JSONL 落盘：每行一个事件，同 id 后写覆盖前写（原地更新的事件追加新版本）。
 * 启动读盘逐行解析，损坏行计数跳过；整体读取失败时把文件改名为 .bad-<时间戳> 后从空开始。
 * 只负责文件读写，不做上限裁剪与压缩决策，那些由 ActivityLog 决定。
 */

export interface ActivityLoadResult {
  /** 按 id 去重（取最后一个版本）后、按 seq 升序的事件 */
  events: ActivityEvent[];
  /** 无法解析或字段不合法的行数 */
  skipped: number;
  /** 文件中的非空行数 */
  lines: number;
}

function isStoredEvent(v: unknown): v is ActivityEvent {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === 'string' && !!e.id
    && typeof e.seq === 'number' && Number.isFinite(e.seq)
    && typeof e.rev === 'number'
    && typeof e.at === 'number' && Number.isFinite(e.at)
    && typeof e.updatedAt === 'number'
    && isActivityType(e.type) && isActivityLevel(e.level)
    && typeof e.source === 'string' && typeof e.title === 'string'
    && (e.sessionId === undefined || typeof e.sessionId === 'string');
}

export class ActivityFileStore {
  /** 当前文件的非空行数与字节数（追加时累加，重写后重置），供压缩判断 */
  lines = 0;
  bytes = 0;

  constructor(readonly file: string, private readonly now: () => number = () => Date.now()) {}

  load(): ActivityLoadResult {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        log('activity', `读取活动日志失败（${code ?? String(err)}），改名后重新开始`);
        this.quarantine();
      }
      return { events: [], skipped: 0, lines: 0 };
    }
    const byId = new Map<string, ActivityEvent>();
    let skipped = 0;
    let lines = 0;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      lines++;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { skipped++; continue; }
      if (!isStoredEvent(parsed)) { skipped++; continue; }
      byId.set(parsed.id, parsed);
    }
    this.lines = lines;
    this.bytes = Buffer.byteLength(text);
    const events = [...byId.values()].sort((a, b) => a.seq - b.seq);
    return { events, skipped, lines };
  }

  /** 追加若干事件；失败只记日志 */
  append(events: ActivityEvent[]): void {
    if (events.length === 0) return;
    const text = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, text);
      this.lines += events.length;
      this.bytes += Buffer.byteLength(text);
    } catch (err) {
      log('activity', `追加活动日志失败：${String(err)}`);
    }
  }

  /** 整体重写为给定事件（压缩或清空） */
  rewrite(events: ActivityEvent[]): boolean {
    const text = events.length > 0 ? events.map(e => JSON.stringify(e)).join('\n') + '\n' : '';
    const ok = writeTextAtomic(this.file, text, 'activity');
    if (ok) {
      this.lines = events.length;
      this.bytes = Buffer.byteLength(text);
    }
    return ok;
  }

  /** 无法读取的文件改名保留，便于事后排查 */
  private quarantine(): void {
    const bad = `${this.file}.bad-${this.now()}`;
    try {
      fs.renameSync(this.file, bad);
      log('activity', `已把无法读取的活动日志改名为 ${path.basename(bad)}`);
    } catch (err) {
      log('activity', `活动日志改名失败：${String(err)}`);
    }
  }
}
