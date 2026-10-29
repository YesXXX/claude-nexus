import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { readJson, writeJsonAtomic } from './json-store';
import { log } from './logger';
import { sanitizePresetInput, sortPresets, PRESET_MAX_COUNT, type PresetInput, type SessionPreset } from '../shared/preset';

/**
 * 会话预设存储：<panelHome>/presets.json，结构 { version: 1, presets }，原子写入。
 * 文件损坏或结构不对时改名为 presets.json.bak-<时间> 留档，以空列表启动，面板照常可用。
 */

interface FileShape { version: 1; presets: SessionPreset[] }

export interface PresetStoreOptions {
  now?: () => number;
}

function validPreset(v: unknown): v is SessionPreset {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return typeof p.id === 'string' && !!p.id && typeof p.name === 'string' && !!p.name && typeof p.cwd === 'string' && !!p.cwd
    && typeof p.worktree === 'boolean' && typeof p.createdAt === 'number' && typeof p.updatedAt === 'number'
    && typeof p.useCount === 'number';
}

export class PresetStore {
  private items: SessionPreset[] = [];
  private readonly now: () => number;

  constructor(readonly file: string, opts: PresetStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** 读入预设；返回损坏时备份文件的路径（没有损坏为 undefined） */
  load(): string | undefined {
    this.items = [];
    if (!fs.existsSync(this.file)) return undefined;
    const raw = readJson<unknown>(this.file, { tag: 'presets' });
    const list = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).presets : undefined;
    if (raw === null || !Array.isArray(list)) return this.backupBroken();
    for (const p of list) {
      if (!validPreset(p)) continue;
      const item: SessionPreset = {
        id: p.id, name: p.name, cwd: p.cwd, worktree: p.worktree,
        createdAt: p.createdAt, updatedAt: p.updatedAt, useCount: Math.max(0, Math.floor(p.useCount)),
      };
      if (typeof p.branch === 'string' && p.branch) item.branch = p.branch;
      if (typeof p.baseRef === 'string' && p.baseRef) item.baseRef = p.baseRef;
      if (typeof p.initialPrompt === 'string' && p.initialPrompt) item.initialPrompt = p.initialPrompt;
      if (typeof p.lastUsedAt === 'number') item.lastUsedAt = p.lastUsedAt;
      this.items.push(item);
    }
    return undefined;
  }

  private backupBroken(): string | undefined {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const bak = `${this.file}.bak-${stamp}`;
    try {
      fs.renameSync(this.file, bak);
      log('presets', `预设文件损坏，已备份为 ${bak} 并以空列表启动`);
      return bak;
    } catch (err) {
      log('presets', `预设文件损坏且备份失败：${String(err)}`);
      return undefined;
    }
  }

  private persist(): boolean {
    const data: FileShape = { version: 1, presets: this.items };
    return writeJsonAtomic(this.file, data, { tag: 'presets' });
  }

  /** 最近使用的在前，返回副本 */
  list(): SessionPreset[] {
    return sortPresets(this.items).map(p => ({ ...p }));
  }

  get(id: string): SessionPreset | undefined {
    const p = this.items.find(x => x.id === id);
    return p ? { ...p } : undefined;
  }

  /** 带已有 id 为修改（保留创建时间与使用计数），否则新建；同名不冲突，靠 id 区分 */
  save(input: unknown): { ok: true; preset: SessionPreset } | { ok: false; error: string } {
    const r = sanitizePresetInput(input);
    if (!r.ok) return r;
    const v: PresetInput = r.value;
    const now = this.now();
    const existing = v.id ? this.items.find(x => x.id === v.id) : undefined;
    let saved: SessionPreset;
    if (existing) {
      existing.name = v.name;
      existing.cwd = v.cwd;
      existing.worktree = v.worktree === true;
      delete existing.branch;
      delete existing.baseRef;
      delete existing.initialPrompt;
      if (v.branch) existing.branch = v.branch;
      if (v.baseRef) existing.baseRef = v.baseRef;
      if (v.initialPrompt) existing.initialPrompt = v.initialPrompt;
      existing.updatedAt = now;
      saved = existing;
    } else {
      if (this.items.length >= PRESET_MAX_COUNT) return { ok: false, error: `预设数量已达上限（${PRESET_MAX_COUNT} 个）` };
      saved = {
        id: randomUUID(), name: v.name, cwd: v.cwd, worktree: v.worktree === true,
        createdAt: now, updatedAt: now, useCount: 0,
      };
      if (v.branch) saved.branch = v.branch;
      if (v.baseRef) saved.baseRef = v.baseRef;
      if (v.initialPrompt) saved.initialPrompt = v.initialPrompt;
      this.items.push(saved);
    }
    if (!this.persist()) return { ok: false, error: '写入预设文件失败' };
    return { ok: true, preset: { ...saved } };
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter(x => x.id !== id);
    if (this.items.length === before) return false;
    this.persist();
    return true;
  }

  /** 用预设创建会话前记一次使用：计数加一并更新最近使用时间 */
  touch(id: string): SessionPreset | undefined {
    const p = this.items.find(x => x.id === id);
    if (!p) return undefined;
    p.useCount += 1;
    p.lastUsedAt = this.now();
    this.persist();
    return { ...p };
  }
}
