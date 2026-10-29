import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { readJson, writeJsonAtomic } from './json-store';
import { log } from './logger';
import { gitOk, type GitRunner } from './git-runner';
import { parsePorcelainV2 } from '../shared/git-parse';
import {
  localDate, sanitizeTemplateInput, sortTemplates,
  type PromptTemplate, type TemplateContext, type TemplateSaveResult,
} from '../shared/template';

/**
 * 提示词模板存储：<panelHome>/templates.json，结构 { version: 1, templates }，原子写入。
 * 文件损坏或结构不对时改名为 templates.json.bak-<时间> 留档，以空列表启动，面板照常可用。
 */

interface FileShape { version: 1; templates: PromptTemplate[] }

/** 列表里改动文件最多列出的个数，超出时追加「等 N 个」 */
const CHANGED_FILES_MAX = 50;

function validTemplate(v: unknown): v is PromptTemplate {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return typeof t.id === 'string' && !!t.id && typeof t.name === 'string' && typeof t.body === 'string'
    && typeof t.createdAt === 'number' && typeof t.updatedAt === 'number';
}

export interface TemplateStoreOptions {
  now?: () => number;
}

export class TemplateStore {
  private items: PromptTemplate[] = [];
  private readonly now: () => number;

  constructor(readonly file: string, opts: TemplateStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** 读入模板；返回损坏时备份文件的路径（没有损坏为 undefined） */
  load(): string | undefined {
    this.items = [];
    if (!fs.existsSync(this.file)) return undefined;
    const raw = readJson<unknown>(this.file, { tag: 'templates' });
    const list = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).templates : undefined;
    if (raw === null || !Array.isArray(list)) return this.backupBroken();
    for (const t of list) {
      if (!validTemplate(t)) continue;
      const item: PromptTemplate = {
        id: t.id, name: t.name, body: t.body, createdAt: t.createdAt, updatedAt: t.updatedAt,
        useCount: typeof t.useCount === 'number' && t.useCount >= 0 ? Math.floor(t.useCount) : 0,
      };
      if (typeof t.description === 'string' && t.description) item.description = t.description;
      if (typeof t.lastUsedAt === 'number') item.lastUsedAt = t.lastUsedAt;
      this.items.push(item);
    }
    return undefined;
  }

  private backupBroken(): string | undefined {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const bak = `${this.file}.bak-${stamp}`;
    try {
      fs.renameSync(this.file, bak);
      log('templates', `模板文件损坏，已备份为 ${bak} 并以空列表启动`);
      return bak;
    } catch (err) {
      log('templates', `模板文件损坏且备份失败：${String(err)}`);
      return undefined;
    }
  }

  private persist(): boolean {
    const data: FileShape = { version: 1, templates: this.items };
    return writeJsonAtomic(this.file, data, { tag: 'templates' });
  }

  /** 最近使用的在前 */
  list(): PromptTemplate[] {
    return sortTemplates(this.items).map(t => ({ ...t }));
  }

  get(id: string): PromptTemplate | undefined {
    const t = this.items.find(x => x.id === id);
    return t ? { ...t } : undefined;
  }

  /** 带已有 id 为修改（保留创建时间与使用计数），否则新建 */
  save(input: unknown): TemplateSaveResult {
    const r = sanitizeTemplateInput(input);
    if (!r.ok) return r;
    const { id, name, body, description } = r.value;
    const now = this.now();
    const existing = id ? this.items.find(x => x.id === id) : undefined;
    let saved: PromptTemplate;
    if (existing) {
      existing.name = name;
      existing.body = body;
      if (description) existing.description = description; else delete existing.description;
      existing.updatedAt = now;
      saved = existing;
    } else {
      saved = { id: randomUUID(), name, body, createdAt: now, updatedAt: now, useCount: 0 };
      if (description) saved.description = description;
      this.items.push(saved);
    }
    if (!this.persist()) return { ok: false, error: '写入模板文件失败' };
    return { ok: true, template: { ...saved } };
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter(x => x.id !== id);
    if (this.items.length === before) return false;
    this.persist();
    return true;
  }

  /** 记一次使用：计数加一并更新最近使用时间 */
  touch(id: string): PromptTemplate | undefined {
    const t = this.items.find(x => x.id === id);
    if (!t) return undefined;
    t.useCount += 1;
    t.lastUsedAt = this.now();
    this.persist();
    return { ...t };
  }
}

export interface TemplateContextInput {
  /** 会话或表单的工作目录 */
  cwd: string;
  /** 工作区会话的主仓库根，项目名取它而不是工作区目录名 */
  repoRoot?: string;
  /** 会话已有的改动文件列表（来自改动统计）；缺省时用 git status 计算 */
  changedFiles?: string[];
  now?: number;
}

/** 改动文件按行列出，过多时截断并注明总数 */
export function formatChangedFiles(files: string[]): string {
  if (files.length <= CHANGED_FILES_MAX) return files.join('\n');
  return `${files.slice(0, CHANGED_FILES_MAX).join('\n')}\n等 ${files.length} 个文件`;
}

/**
 * 计算内置变量：分支取当前分支（分离头指针时为短 sha），项目取仓库根目录名（不是仓库时取目录名），
 * 改动文件优先用传入的列表，否则取 git status 的未提交文件。git 不可用时对应项缺省。
 */
export async function templateContext(git: GitRunner, input: TemplateContextInput): Promise<TemplateContext> {
  const cwd = input.cwd;
  const ctx: TemplateContext = { 日期: localDate(input.now ?? Date.now()), 目录: cwd };
  if (!fs.existsSync(cwd)) return ctx;
  const top = await git.run(cwd, ['rev-parse', '--show-toplevel']);
  if (!gitOk(top)) {
    ctx.项目 = path.basename(cwd);
    if (input.changedFiles) ctx.改动文件 = formatChangedFiles(input.changedFiles);
    return ctx;
  }
  ctx.项目 = path.basename(input.repoRoot ?? top.stdout.trim());
  const branch = await git.run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (gitOk(branch)) {
    const b = branch.stdout.trim();
    if (b && b !== 'HEAD') ctx.分支 = b;
    else {
      const sha = await git.run(cwd, ['rev-parse', '--short', 'HEAD']);
      if (gitOk(sha) && sha.stdout.trim()) ctx.分支 = sha.stdout.trim();
    }
  }
  if (input.changedFiles) {
    ctx.改动文件 = formatChangedFiles(input.changedFiles);
  } else {
    const st = await git.run(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
    if (gitOk(st)) {
      const files = parsePorcelainV2(st.stdout).filter(e => e.type !== 'ignored').map(e => e.path);
      ctx.改动文件 = formatChangedFiles(files);
    }
  }
  return ctx;
}
