import * as fs from 'fs';
import * as path from 'path';
import { readJson, writeJsonAtomic } from './json-store';
import { gitOk, type GitRunner } from './git-runner';
import { log } from './logger';
import {
  DEFAULT_VERIFY_GLOBAL, sanitizeVerifyConfig, sanitizeVerifyGlobal,
  type VerifyConfig, type VerifyGlobal,
} from '../shared/verify-types';

/**
 * verify.json：{ version: 1, global, repos: { 仓库键: VerifyConfig } }，原子写入；
 * 解析失败或结构不对时改名为 .bak-<时间> 留档，以空配置启动。
 * 仓库键 = 主仓库根的绝对路径（Windows 下转小写、统一反斜杠）；非仓库目录用会话目录本身。
 */

interface VerifyFile {
  version: 1;
  global: VerifyGlobal;
  repos: Record<string, VerifyConfig>;
}

export interface RepoKeyInfo {
  key: string;
  /** 展示用的仓库根（保留原始大小写） */
  root: string;
  isRepo: boolean;
}

/** 路径规范化成仓库键 */
export function normalizeRepoKey(p: string): string {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * 解析目录所属的主仓库根：git-common-dir 的上一级（目录本身是工作区时也指向主仓库）。
 * repoRoot 已知（面板创建的工作区会话）时直接用；非仓库返回目录本身。
 */
export async function resolveRepoKey(git: GitRunner, cwd: string, repoRoot?: string): Promise<RepoKeyInfo> {
  if (repoRoot) return { key: normalizeRepoKey(repoRoot), root: path.resolve(repoRoot), isRepo: true };
  if (fs.existsSync(cwd)) {
    const r = await git.run(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']);
    if (gitOk(r)) {
      const [common, top] = r.stdout.split(/\r?\n/).map(s => s.trim());
      let root = top;
      if (common && path.basename(common).toLowerCase() === '.git') root = path.dirname(common);
      if (root) return { key: normalizeRepoKey(root), root: path.resolve(root), isRepo: true };
    }
  }
  return { key: normalizeRepoKey(cwd), root: path.resolve(cwd), isRepo: false };
}

export class VerifyConfigStore {
  private data: VerifyFile = { version: 1, global: { ...DEFAULT_VERIFY_GLOBAL }, repos: {} };

  constructor(private readonly file: string, private readonly now: () => number = () => Date.now()) {}

  /** 读入文件；损坏时返回备份文件路径 */
  load(): string | undefined {
    if (!fs.existsSync(this.file)) return undefined;
    const raw = readJson<unknown>(this.file, { tag: 'verify' });
    const parsed = raw && typeof raw === 'object' ? raw as Partial<VerifyFile> : null;
    if (!parsed || !parsed.repos || typeof parsed.repos !== 'object' || Array.isArray(parsed.repos)) {
      return this.backup();
    }
    const repos: Record<string, VerifyConfig> = {};
    for (const [k, v] of Object.entries(parsed.repos)) {
      const c = sanitizeVerifyConfig(v);
      if (c.ok) repos[k] = c.value;
    }
    this.data = { version: 1, global: sanitizeVerifyGlobal(parsed.global), repos };
    return undefined;
  }

  private backup(): string | undefined {
    const bak = `${this.file}.bak-${this.now()}`;
    try {
      fs.renameSync(this.file, bak);
      log('verify', `verify.json 无法解析，已改名为 ${bak}，以空配置启动`);
      return bak;
    } catch (err) {
      log('verify', `verify.json 损坏且备份失败：${String(err)}`);
      return undefined;
    }
  }

  get(key: string): VerifyConfig | null {
    const c = this.data.repos[key];
    return c ? { ...c } : null;
  }

  /** 保存或删除（config 为 null）某仓库的配置 */
  set(key: string, config: unknown): { ok: true; config: VerifyConfig | null } | { ok: false; error: string } {
    if (config === null) {
      delete this.data.repos[key];
      this.persist();
      return { ok: true, config: null };
    }
    const c = sanitizeVerifyConfig(config);
    if (!c.ok) return c;
    this.data.repos[key] = c.value;
    this.persist();
    return { ok: true, config: { ...c.value } };
  }

  global(): VerifyGlobal {
    return { ...this.data.global };
  }

  setGlobal(g: unknown): VerifyGlobal {
    this.data.global = sanitizeVerifyGlobal({ ...this.data.global, ...(g && typeof g === 'object' ? g : {}) });
    this.persist();
    return this.global();
  }

  private persist(): void {
    writeJsonAtomic(this.file, this.data, { tag: 'verify' });
  }
}
