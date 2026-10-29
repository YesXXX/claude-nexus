import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { E2eApp, SessionInfo } from './harness';
import { q } from './harness';

/**
 * e2e 夹具：工作目录、临时 git 仓库、表单新建会话、等待会话状态等。
 * 所有文件只写进实例的临时根目录。
 */

/** 在 work 下建一个空目录作为会话工作目录 */
export function mkWorkDir(app: E2eApp, name: string): string {
  const dir = path.join(app.work, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 以命令行参数注入身份运行 git，不读写全局配置 */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=e2e',
    '-c', 'user.email=e2e@local',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false',
    ...args,
  ], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 在 work 下初始化一个带首次提交的临时 git 仓库，files 为相对路径到内容的映射 */
export function initGitRepo(app: E2eApp, name: string, files: Record<string, string>): string {
  const dir = mkWorkDir(app, name);
  git(dir, '-c', 'init.defaultBranch=main', 'init', '-q');
  writeFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** 写入一组文件（自动建父目录） */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/**
 * 在实例的 claude 目录下写一份子代理 transcript，目录结构与 Claude 一致：
 * projects/<proj>/<claudeId>/subagents/agent-<id>.jsonl。返回文件路径。
 */
export function writeSubagentTranscript(app: E2eApp, agentId: string, lines: unknown[]): string {
  const file = path.join(app.claude, 'projects', 'e2e-proj', 'e2e-claude-session', 'subagents', `agent-${agentId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  appendJsonl(file, lines);
  return file;
}

/** 向 jsonl 文件追加若干行 */
export function appendJsonl(file: string, lines: unknown[]): void {
  fs.appendFileSync(file, lines.map(l => JSON.stringify(l) + '\n').join(''));
}

/** 点击 scope 内文本完全匹配的按钮 */
export async function clickButton(app: E2eApp, scope: string, text: string): Promise<void> {
  const ok = await app.eval<boolean>(`(() => {
    const b = [...document.querySelectorAll(${q(`${scope} button`)})]
      .find(x => (x.textContent ?? '').trim() === ${q(text)});
    if (!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`找不到按钮「${text}」（${scope}）`);
}

/** 父会话列表行的选择器 */
export function rowSel(id: string): string {
  return `[data-role="parent"][data-session-id="${id}"]`;
}

/** 打开详情页头的「⋯」菜单并点 data-role 对应的菜单项（如 end-session、export-output、copy-path） */
export async function clickPaneMenu(app: E2eApp, role: string): Promise<void> {
  await app.waitVisible('#pane-more');
  await app.click('#pane-more');
  await app.waitVisible(`.pane-menu [data-role="${role}"]`);
  await app.click(`.pane-menu [data-role="${role}"]`);
}

/** 父会话行是否带选中样式 */
export async function isRowSelected(app: E2eApp, id: string): Promise<boolean> {
  return app.eval<boolean>(`document.querySelector(${q(rowSel(id))})?.classList.contains('sel') === true`);
}

/** 当前选中的父会话 id（没有选中返回 null） */
export async function selectedSessionId(app: E2eApp): Promise<string | null> {
  return app.eval<string | null>(
    `document.querySelector('[data-role="parent"].sel')?.getAttribute('data-session-id') ?? null`);
}

/**
 * 通过首页表单新建会话：回到首页，填标签与工作目录，在标签框回车提交；
 * 等列表出现新行且详情页显示后返回新会话 id。
 * prepare 在填好工作目录之后、填标签之前执行，用于勾选独立工作区等表单选项。
 */
export async function createSessionViaForm(
  app: E2eApp, label: string, cwd: string, prepare?: () => Promise<void>,
): Promise<string> {
  const before = new Set((await app.list()).map(s => s.id));
  if (!(await app.visible('#main-empty'))) {
    await app.click('#btn-new');
    await app.waitVisible('#main-empty');
  }
  await app.fill('#form-cwd', cwd);
  if (prepare) await prepare();
  await app.fill('#form-label', label);
  await app.press('Enter');
  const id = await app.until(async () => {
    const created = (await app.list()).find(s => !before.has(s.id) && s.label === label);
    return created?.id;
  }, { timeout: 20_000, message: `新会话「${label}」出现在 list() 中` });
  await app.waitFor(`!!document.querySelector(${q(rowSel(id))})`, { message: `会话 ${id} 的列表行` });
  await app.waitVisible('#main-pane');
  return id;
}

/** 通过首页表单新建独立工作区会话，等 mock-claude 启动后返回会话 id 与工作区路径 */
export async function createWorktreeSession(
  app: E2eApp, label: string, repo: string, branch: string,
): Promise<{ id: string; wtPath: string }> {
  const id = await createSessionViaForm(app, label, repo, async () => {
    await app.waitVisible('#wt-row');
    await app.waitFor(`document.querySelector('#wt-on')?.disabled === false`, { message: '工作区开关可用' });
    await app.click('#wt-on');
    await app.waitFor(`!!document.querySelector('#wt-fields') && !document.querySelector('#wt-fields').closest('[hidden]')`,
      { message: '分支输入框出现' });
    await app.fill('#wt-branch', branch);
  });
  const s = await app.session(id);
  if (!s?.worktree) throw new Error(`会话 ${id} 没有独立工作区`);
  await waitOutput(app, id, 'mock-claude 已启动');
  return { id, wtPath: s.worktree.path };
}

/** 等待会话状态满足条件，返回最新的会话信息 */
export async function waitStatus(app: E2eApp, id: string, status: string | string[], timeout = 15_000): Promise<SessionInfo> {
  const want = Array.isArray(status) ? status : [status];
  let last = '';
  try {
    return await app.until(async () => {
      const s = await app.session(id);
      last = s?.status ?? '(不存在)';
      return s && want.includes(s.status) ? s : undefined;
    }, { timeout, message: `会话 ${id} 状态变为 ${want.join('/')}` });
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}；最后状态 ${last}`);
  }
}

/** 等待会话终端缓冲包含指定文本 */
export async function waitOutput(app: E2eApp, id: string, text: string, timeout = 15_000): Promise<string> {
  return app.until(async () => {
    const out = await app.output(id);
    return out.includes(text) ? out : '';
  }, { timeout, message: `会话 ${id} 的终端缓冲包含「${text}」` });
}

/**
 * 在页面里订阅会话推送，记录某个会话依次经历的状态（相邻重复只记一次）。
 * 轮询 list() 可能错过一闪而过的状态，推送记录不会。
 */
export async function recordStatuses(app: E2eApp, id: string): Promise<() => Promise<string[]>> {
  const key = `__e2eStatuses_${id.replace(/[^a-zA-Z0-9]/g, '')}`;
  await app.eval(`(() => {
    const k = ${q(key)}, id = ${q(id)};
    window[k] = [];
    window.panelApi.onSessions(list => {
      const s = list.find(x => x.id === id);
      const arr = window[k];
      if (s && arr[arr.length - 1] !== s.status) arr.push(s.status);
    });
    return true;
  })()`);
  return () => app.eval<string[]>(`window[${q(key)}] ?? []`);
}

/** 终端是否持有焦点 */
export function terminalFocusedExpr(): string {
  return `document.activeElement?.classList.contains('xterm-helper-textarea') === true`;
}

/** 当前可见终端（.xterm-rows）的文本 */
export async function xtermText(app: E2eApp, scope = '#main-pane'): Promise<string> {
  return app.eval<string>(`(() => {
    const rows = [...document.querySelectorAll(${JSON.stringify(`${scope} .xterm-rows`)})]
      .filter(el => el.getClientRects().length > 0);
    return rows.map(el => el.textContent ?? '').join('\\n');
  })()`);
}

/** 向会话终端写入一行（经 panelApi.input，与在终端里回车提交一致） */
export async function sendLine(app: E2eApp, id: string, text: string): Promise<void> {
  const ok = await app.eval<boolean>(`window.panelApi.input(${q(id)}, ${q(`${text}\r`)})`);
  if (!ok) throw new Error(`向会话 ${id} 写入失败`);
}

/** 跑完一轮 mock 任务：提交任务、等待权限、允许、等回合结束。mock 随之写一行对话记录 */
export async function runTurn(app: E2eApp, id: string, task: string): Promise<void> {
  await sendLine(app, id, task);
  await waitStatus(app, id, 'waiting_permission');
  await sendLine(app, id, 'y');
  await waitStatus(app, id, 'completed');
}

/** 让 mock 以 /exit 正常退出，等到进程退出码写回会话 */
export async function exitSession(app: E2eApp, id: string): Promise<SessionInfo> {
  await sendLine(app, id, '/exit');
  return app.until(async () => {
    const s = await app.session(id);
    return s && s.exitCode === 0 ? s : undefined;
  }, { timeout: 15_000, message: `会话 ${id} 进程退出` });
}

/** mock 写下的对话记录文件（<home>/mock-claude/projects/<目录>/<id>.jsonl），没有返回 null */
export function transcriptFile(app: E2eApp, claudeId: string): string | null {
  const root = path.join(app.home, 'mock-claude', 'projects');
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, `${claudeId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** 某个面板会话的会话记录（经 panelApi.recordGet） */
export async function recordOf(app: E2eApp, id: string): Promise<Record<string, unknown> | null> {
  return app.eval<Record<string, unknown> | null>(`window.panelApi.recordGet(${q(id)})`);
}

/** scope 内文本完全匹配的按钮是否存在 */
export async function hasButton(app: E2eApp, scope: string, text: string): Promise<boolean> {
  return app.eval<boolean>(`[...document.querySelectorAll(${q(`${scope} button`)})]
    .some(x => (x.textContent ?? '').trim() === ${q(text)})`);
}

/** 改动页切到指定视角（默认是「本会话改动」），等按钮高亮 */
export async function switchChangesScope(app: E2eApp, scope: 'session' | 'repo'): Promise<void> {
  const sel = `#changes-host .chg-scope .chg-seg-btn[data-scope="${scope}"]`;
  await app.waitFor(`!!document.querySelector(${q(sel)})`, { message: `改动页有「${scope}」视角按钮` });
  await app.click(sel);
  await app.waitFor(`document.querySelector(${q(sel)})?.classList.contains('on') === true`, { message: `改动页切到「${scope}」视角` });
}
