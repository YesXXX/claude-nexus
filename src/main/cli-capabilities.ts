import { execFile } from 'child_process';
import * as path from 'path';
import { panelHome } from './panel-home';
import { readJson, writeJsonAtomic } from './json-store';
import { log } from './logger';
import { sanitizeChildEnv } from './claude-launch';

/** 本机 claude CLI 支持的启动参数（各机器版本不一，按版本探测并缓存） */
export interface CliCapabilities {
  /** `claude --version` 输出首行；未探测或探测失败为 null */
  version: string | null;
  resume: boolean;
  sessionId: boolean;
  forkSession: boolean;
  name: boolean;
  probedAt: number;
}

/** 探测完成前或失败时使用：只认 --resume 与 --settings，新建会话不预分配 id */
export const CONSERVATIVE_CAPS: CliCapabilities = Object.freeze({
  version: null, resume: true, sessionId: false, forkSession: false, name: false, probedAt: 0,
});

/** mock-claude 实现了全部参数 */
export const MOCK_CAPS: CliCapabilities = Object.freeze({
  version: 'mock', resume: true, sessionId: true, forkSession: true, name: true, probedAt: 0,
});

/** 从帮助文本判断支持的参数：只看参数名，不依赖说明文字的措辞 */
export function parseHelp(text: string): Pick<CliCapabilities, 'resume' | 'sessionId' | 'forkSession' | 'name'> {
  return {
    resume: /--resume\b/.test(text),
    sessionId: /--session-id\b/.test(text),
    forkSession: /--fork-session\b/.test(text),
    name: /(^|\s)-n, --name\b/m.test(text),
  };
}

let current: CliCapabilities | null = null;

/** 当前可用能力：mock 模式全开；否则为最近一次探测结果，未探测时为保守值 */
export function currentCaps(env: Record<string, string | undefined> = process.env): CliCapabilities {
  if (env.CLAUDE_PANEL_MOCK_CLAUDE) return MOCK_CAPS;
  return current ?? CONSERVATIVE_CAPS;
}

/** 测试用：直接设置或清空当前能力 */
export function setCurrentCaps(caps: CliCapabilities | null): void {
  current = caps;
}

/** 运行 claude 的方式（测试注入假实现，避免触碰真实 CLI） */
export type CliRunner = (args: string[]) => Promise<string>;

export interface ProbeOptions {
  run?: CliRunner;
  cacheFile?: string;
  now?: () => number;
}

export function capabilitiesCacheFile(): string {
  return path.join(panelHome(), 'cli-capabilities.json');
}

/**
 * 探测 CLI 能力：先跑 `claude --version`，与缓存版本一致就用缓存；
 * 版本变化或无缓存时跑 `claude --help` 解析参数并写缓存。
 * 任一步失败都回落保守值，不抛出。结果同时写入 currentCaps。
 */
export async function probeCapabilities(opts: ProbeOptions = {}): Promise<CliCapabilities> {
  const run = opts.run ?? runClaude;
  const cacheFile = opts.cacheFile ?? capabilitiesCacheFile();
  const now = opts.now ?? Date.now;
  let version: string;
  try {
    version = firstLine(await run(['--version']));
    if (!version) throw new Error('版本输出为空');
  } catch (err) {
    log('cli', `探测 claude 版本失败，使用保守能力：${String(err)}`);
    current = CONSERVATIVE_CAPS;
    return current;
  }
  const cached = readJson<CliCapabilities>(cacheFile, { tag: 'cli' });
  if (cached && cached.version === version && isCaps(cached)) {
    current = cached;
    return current;
  }
  try {
    const help = await run(['--help']);
    const caps: CliCapabilities = { version, ...parseHelp(help), probedAt: now() };
    if (!caps.resume) log('cli', `claude ${version} 帮助中未见 --resume，续接功能不可用`);
    writeJsonAtomic(cacheFile, caps, { tag: 'cli' });
    log('cli', `claude ${version} 能力：sessionId=${caps.sessionId} forkSession=${caps.forkSession} name=${caps.name}`);
    current = caps;
  } catch (err) {
    log('cli', `读取 claude 帮助失败，使用保守能力：${String(err)}`);
    current = { ...CONSERVATIVE_CAPS, version };
  }
  return current;
}

function isCaps(v: CliCapabilities): boolean {
  return typeof v.resume === 'boolean' && typeof v.sessionId === 'boolean'
    && typeof v.forkSession === 'boolean' && typeof v.name === 'boolean';
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? '';
}

/** 实际调用 claude：Windows 上 claude 是 .cmd 包装，必须经 cmd.exe；env 同样剥离父进程标记 */
function runClaude(args: string[]): Promise<string> {
  const isWin = process.platform === 'win32';
  const file = isWin ? 'cmd.exe' : 'claude';
  const fullArgs = isWin ? ['/c', 'claude.cmd', ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(file, fullArgs, {
      timeout: 15_000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024,
      env: sanitizeChildEnv(process.env),
    }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}
