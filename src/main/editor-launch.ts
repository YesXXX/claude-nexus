import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 外部编辑器命令的解析与启动（diff 跳转用）。
 * 安全口径：
 * - 命令先按参数切分（双引号包裹含空格的路径），占位符 {file} {line} {col} 在参数内替换，
 *   从头到尾不把用户输入拼进 shell 命令行，spawn 一律 shell:false；
 * - Windows 上 .cmd/.bat 脚本（VS Code 的 code 就是 code.cmd）无法直接 spawn（Node 拒绝），
 *   改由 cmd.exe /d /s /c 代跑：整条命令外加一层双引号、每个参数单独双引号，
 *   Windows 文件名不允许出现双引号，参数内容无法借引号逃逸；路径里的 %变量% 会被
 *   cmd 展开属极端情况，只影响该参数取值，不会引入新的命令；
 * - 可执行文件（.exe/.com）直接 spawn，不经 cmd。
 */

export const EDITOR_COMMAND_MAX = 1000;

export interface EditorVars {
  file: string;
  line: number;
  col?: number;
}

export type TokenizeResult = { ok: true; argv: string[] } | { ok: false; error: string };

/** 按空白切分命令，双引号内的空白不算分隔符；引号本身不保留在参数里 */
export function tokenizeEditorCommand(cmd: string): TokenizeResult {
  const trimmed = cmd.trim();
  if (!trimmed) return { ok: false, error: '命令为空' };
  const argv: string[] = [];
  let cur = '';
  let inQuote = false;
  let has = false;
  for (const ch of trimmed) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (!inQuote && /\s/.test(ch)) {
      if (cur || has) argv.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (inQuote) return { ok: false, error: '命令里的双引号没有闭合' };
  if (cur || has) argv.push(cur);
  if (!argv.length || !argv[0]) return { ok: false, error: '命令为空' };
  return { ok: true, argv };
}

export type SubstituteResult = { ok: true; program: string; args: string[] } | { ok: false; error: string };

/** 把占位符替换进除程序名以外的参数；没有 {file} 时拒绝启动（否则编辑器不知道要打开哪个文件） */
export function substituteEditorArgs(argv: string[], vars: EditorVars): SubstituteResult {
  const line = String(Math.max(1, Math.floor(vars.line)));
  const col = String(vars.col !== undefined ? Math.max(1, Math.floor(vars.col)) : 1);
  let usedFile = false;
  const args: string[] = [];
  for (const a of argv.slice(1)) {
    if (a.includes('{file}')) usedFile = true;
    args.push(a.split('{file}').join(vars.file).split('{line}').join(line).split('{col}').join(col));
  }
  if (!usedFile) return { ok: false, error: '命令里没有 {file} 占位符，无法确定要打开的文件' };
  return { ok: true, program: argv[0], args };
}

interface FsDeps {
  isWindows?: boolean;
  env?: Record<string, string | undefined>;
  existsSync?: (p: string) => boolean;
}

export interface ResolvedProgram {
  /** 实际启动的文件：脚本时为解析出的 .cmd/.bat 完整路径 */
  file: string;
  /** 经 cmd.exe 代跑的 Windows 脚本 */
  viaCmd: boolean;
}

/**
 * 解析程序名到可启动的文件：带路径的按路径找（无扩展名时按 PATHEXT 补全），
 * 裸名沿 PATH 加 PATHEXT 找；.cmd/.bat 标记为走 cmd 代跑。
 * 裸名在 PATH 里找不到时原样返回交由系统再找一次（注册表 App Paths 之类），启动失败再报错。
 */
export function resolveProgram(program: string, deps: FsDeps = {}): ResolvedProgram | { error: string } {
  const isWindows = deps.isWindows ?? process.platform === 'win32';
  const env = deps.env ?? process.env;
  const exists = deps.existsSync ?? ((p: string) => fs.existsSync(p));
  const isScript = (p: string): boolean => {
    const ext = path.extname(p).toLowerCase();
    return ext === '.cmd' || ext === '.bat';
  };
  const found = (p: string): ResolvedProgram => ({ file: p, viaCmd: isWindows && isScript(p) });

  if (!isWindows) return { file: program, viaCmd: false };

  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';').map(s => s.trim()).filter(Boolean);
  const hasSep = /[\\/]/.test(program);
  const hasExt = path.extname(program) !== '';

  const candidates: string[] = [];
  if (hasSep) {
    if (hasExt) candidates.push(program);
    else for (const e of exts) candidates.push(program + e);
  } else {
    const dirs = (env.PATH ?? '').split(';').map(s => s.trim()).filter(Boolean);
    for (const dir of dirs) {
      if (hasExt) candidates.push(path.join(dir, program));
      else for (const e of exts) candidates.push(path.join(dir, program + e));
    }
    if (hasExt) candidates.push(program);
  }
  for (const c of candidates) {
    if (exists(c)) return found(c);
  }
  if (hasSep) return { error: `命令路径不存在：${program}` };
  // 裸名没找到也交由系统按自己的规则再找（如 App Paths 登记的程序），找不到由启动错误兜底
  return { file: program, viaCmd: false };
}

/** cmd.exe 代跑用的参数：整条命令行外加一层双引号，配合 /s 剥掉外层后内部引号恰好平衡 */
export function cmdBridgeArgs(resolved: string, args: string[]): string[] {
  const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  return ['/d', '/s', '/c', [resolved, ...args].map(quote).join(' ')];
}

export interface LaunchDeps extends FsDeps {
  /** 注入替代 spawn（单测用），缺省用 child_process.spawn */
  spawnImpl?: typeof spawn;
  /** 等待启动结果的时间上限，超时按成功放行（进程已交给系统，不再阻塞界面） */
  settleMs?: number;
}

/**
 * 用配置的编辑器命令打开文件并跳到行号。返回空串表示已启动，否则为给界面展示的错误文本。
 * detached + stdio ignore：编辑器独立于面板存活，面板退出不影响它。
 */
export async function launchEditorAt(
  command: string, file: string, line: number, deps: LaunchDeps = {},
): Promise<string> {
  return launchEditorVars(command, { file, line }, deps);
}

export async function launchEditorVars(
  command: string, vars: EditorVars, deps: LaunchDeps = {},
): Promise<string> {
  const t = tokenizeEditorCommand(command);
  if (!t.ok) return `外部编辑器命令不可用：${t.error}`;
  const s = substituteEditorArgs(t.argv, vars);
  if (!s.ok) return `外部编辑器命令不可用：${s.error}`;
  const r = resolveProgram(s.program, deps);
  if ('error' in r) return `找不到命令：${r.error}（可在设置的「改动与 diff」里检查外部编辑器命令）`;

  const doSpawn = deps.spawnImpl ?? spawn;
  const isWindows = deps.isWindows ?? process.platform === 'win32';
  const env = deps.env ?? process.env;
  let child: ReturnType<typeof spawn>;
  try {
    child = r.viaCmd
      ? doSpawn(env.ComSpec || env.comspec || 'cmd.exe', cmdBridgeArgs(r.file, s.args), {
        shell: false, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
      })
      : doSpawn(r.file, s.args, { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
  } catch (err) {
    return spawnErrorText(s.program, err, isWindows);
  }
  // 等到确认启动（spawn 事件）或失败（error 事件）；编辑器随后的事都与面板无关
  let errText = '';
  await new Promise<void>(resolve => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, deps.settleMs ?? 3000);
    const finish = (text: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      errText = text;
      resolve();
    };
    child.once('spawn', () => finish(''));
    child.once('error', (err: Error) => finish(spawnErrorText(s.program, err, isWindows)));
  });
  child.unref();
  return errText;
}

function spawnErrorText(program: string, err: unknown, isWindows: boolean): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') {
    return isWindows
      ? `找不到命令：${program}（可在设置的「改动与 diff」里检查外部编辑器命令）`
      : `找不到命令：${program}`;
  }
  if (code === 'EACCES' || code === 'EPERM') return `没有权限启动：${program}`;
  return `启动外部编辑器失败：${(err as Error)?.message ?? String(err)}`;
}
