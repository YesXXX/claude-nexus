import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { panelHome } from './panel-home';
import type { TranscriptState } from '../shared/types';

type Env = Record<string, string | undefined>;

/**
 * Claude CLI 的配置目录：尊重 CLAUDE_CONFIG_DIR，缺省为用户目录下的 .claude。
 * Windows 上优先 USERPROFILE（与 CLI 自身的解析一致），取不到再用 os.homedir()。
 */
export function claudeConfigDir(env: Env = process.env): string {
  const custom = env.CLAUDE_CONFIG_DIR?.trim();
  if (custom) return custom;
  const home = process.platform === 'win32' ? (env.USERPROFILE || os.homedir()) : os.homedir();
  return path.join(home, '.claude');
}

/**
 * 对话记录根目录（其下每个项目一个子目录，子目录里是 `<claude 会话 id>.jsonl`）。
 * 顺序：CLAUDE_PANEL_TRANSCRIPT_ROOT 显式覆盖 → mock 模式下面板数据目录内的模拟根 → CLI 配置目录下的 projects。
 * e2e 与隔离实例靠前两条保证不碰真实 ~/.claude。
 */
export function claudeProjectsRoot(env: Env = process.env): string {
  const override = env.CLAUDE_PANEL_TRANSCRIPT_ROOT?.trim();
  if (override) return override;
  if (env.CLAUDE_PANEL_MOCK_CLAUDE) return mockProjectsRoot(env);
  return path.join(claudeConfigDir(env), 'projects');
}

/** mock-claude 缺省写对话记录的位置（与 scripts/mock-claude.js 的缺省值一致） */
export function mockProjectsRoot(env: Env = process.env): string {
  const home = env.CLAUDE_PANEL_HOME || panelHome();
  return path.join(home, 'mock-claude', 'projects');
}

/** CLI 把启动目录转写为项目子目录名的规则：非字母数字字符一律替换为 `-` */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export interface TranscriptLookup {
  state: TranscriptState;
  /** 找到的文件路径（state 为 found 时必有） */
  path?: string;
  size?: number;
}

/** 会话 id 只允许字母数字与连字符，防止拼路径时越出根目录 */
const SAFE_ID = /^[A-Za-z0-9-]+$/;

/**
 * 在对话记录根目录下定位 `<claudeId>.jsonl`：
 * - 先看 hint（hook 上报过的 transcript_path），文件名对得上且非空直接命中；
 * - 否则扫根目录下一级子目录；
 * - 文件不存在或大小为 0 判为 missing；根目录读不了判为 unknown（让调用方允许尝试）。
 */
export function locateTranscript(root: string, claudeId: string, hint?: string): TranscriptLookup {
  if (!SAFE_ID.test(claudeId)) return { state: 'missing' };
  const fileName = `${claudeId}.jsonl`;
  if (hint && path.basename(hint).toLowerCase() === fileName.toLowerCase()) {
    const size = fileSize(hint);
    if (size !== null && size > 0) return { state: 'found', path: hint, size };
  }
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return { state: 'unknown' };
  }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, fileName);
    const size = fileSize(candidate);
    if (size !== null && size > 0) return { state: 'found', path: candidate, size };
  }
  return { state: 'missing' };
}

/** 普通文件返回字节数，不存在或不是文件返回 null */
function fileSize(file: string): number | null {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * 解析真实路径；路径尚不存在时对最深的已存在祖先取 realpath，再拼回剩余部分
 * （hook 可能在 claude 创建文件之前就带来路径）。
 */
function realpathLoose(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * transcript 路径是否可读：必须以 .jsonl 结尾，realpath 后位于对话记录根目录之内
 * （防止 hook 传来 `..` 穿越、其他盘符或符号链接指向根目录之外）。Windows 下大小写不敏感比较。
 */
export function isUnderTranscriptRoot(p: string, root: string = claudeProjectsRoot()): boolean {
  if (typeof p !== 'string' || !p || !p.toLowerCase().endsWith('.jsonl')) return false;
  if (!path.isAbsolute(p)) return false;
  const win = process.platform === 'win32';
  const norm = (s: string): string => (win ? s.toLowerCase() : s);
  const base = norm(realpathLoose(root));
  const target = norm(realpathLoose(p));
  const rel = path.relative(base, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
