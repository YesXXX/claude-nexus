import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * e2e 用例的公共封装：beforeAll 启动全新的隔离实例，afterAll 断言页面无未捕获异常并清理；
 * 用例失败时自动保存现场（页面截图、控制台、DOM、日志）到 .e2e-out/<时间戳>/<用例>/。
 * 与应用交互只走黑盒方式：DOM 查询与点击、window.panelApi、CDP 按键与文本输入、POST /hook。
 */

const require = createRequire(import.meta.url);
const { launch } = require('../../scripts/e2e/launch.js');
const { postHook } = require('../../scripts/e2e/hook.js');

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface SessionInfo {
  id: string;
  label: string;
  cwd: string;
  status: string;
  readOnly?: boolean;
  pendingAction?: unknown;
  worktree?: { path: string; branch: string; repoRoot: string };
  subagents?: Array<{ agentId: string; status: string; description?: string }>;
  changes?: { files: number; additions: number; deletions: number };
  sessionChanges?: { files: number; additions: number; deletions: number; roots: number };
  pendingPrompt?: { state: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface LaunchedApp {
  root: string;
  home: string;
  work: string;
  claude: string;
  port: number;
  pid: number;
  output: string[];
  page: {
    evaluate(expr: string): Promise<unknown>;
    press(combo: string): Promise<void>;
    insertText(text: string): Promise<void>;
    screenshot(): Promise<Buffer>;
    reload(): Promise<void>;
    viewport(width?: number, height?: number): Promise<void>;
    console: string[];
    exceptions: string[];
  } | null;
  snapshot(): Promise<Array<{ pid: number; name: string; created: string }>>;
  readLogs(): string;
  close(o?: { keep?: boolean }): Promise<Record<string, unknown>>;
}

export interface UseAppOptions {
  /** 额外环境变量，例如 CLAUDE_PANEL_ESCALATE_MS */
  env?: Record<string, string>;
}

export interface WaitOptions {
  timeout?: number;
  message?: string;
}

/** 失败现场的输出目录：run.js 通过 E2E_OUT 指定，直接运行 vitest 时按当前时间生成 */
function outRoot(): string {
  if (process.env.E2E_OUT) return process.env.E2E_OUT;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  process.env.E2E_OUT = path.join(PROJECT_ROOT, '.e2e-out', ts);
  return process.env.E2E_OUT;
}

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** 把选择器安全地嵌进页面表达式 */
export function q(selector: string): string {
  return JSON.stringify(selector);
}

/** 页面表达式：元素存在、自身与祖先都没有 hidden 属性且有布局盒 */
export function visibleExpr(selector: string): string {
  return `(() => { const el = document.querySelector(${q(selector)});
    return !!el && !el.closest('[hidden]') && el.getClientRects().length > 0; })()`;
}

export class E2eApp {
  /** 当前文件的实例，beforeAll 中赋值 */
  app: LaunchedApp | null = null;
  private fileName = '';

  get root(): string { return this.need().root; }
  get home(): string { return this.need().home; }
  get work(): string { return this.need().work; }
  get claude(): string { return this.need().claude; }
  get port(): number { return this.need().port; }

  private need(): LaunchedApp {
    if (!this.app) throw new Error('实例尚未启动');
    return this.app;
  }

  private page(): NonNullable<LaunchedApp['page']> {
    const p = this.need().page;
    if (!p) throw new Error('页面连接不可用');
    return p;
  }

  /** 在页面中求值 */
  async eval<T = unknown>(expr: string): Promise<T> {
    return (await this.page().evaluate(expr)) as T;
  }

  /** 轮询页面表达式直到为真值，返回该值；超时抛错并附上最后一次的值或错误 */
  async waitFor<T = unknown>(expr: string, opts: WaitOptions = {}): Promise<T> {
    const timeout = opts.timeout ?? 10_000;
    const end = Date.now() + timeout;
    let last: unknown;
    let lastErr: unknown;
    while (Date.now() < end) {
      try {
        last = await this.eval(expr);
        lastErr = undefined;
        if (last) return last as T;
      } catch (err) {
        lastErr = err;
      }
      await sleep(100);
    }
    const detail = lastErr ? `最后一次错误：${String(lastErr)}` : `最后一次的值：${JSON.stringify(last)}`;
    throw new Error(`等待超时（${timeout}ms）：${opts.message ?? expr.slice(0, 200)}；${detail}`);
  }

  /** 轮询 node 侧条件直到为真值 */
  async until<T>(fn: () => Promise<T> | T, opts: WaitOptions = {}): Promise<NonNullable<T>> {
    const timeout = opts.timeout ?? 10_000;
    const end = Date.now() + timeout;
    let last: unknown;
    let lastErr: unknown;
    while (Date.now() < end) {
      try {
        const v = await fn();
        last = v;
        lastErr = undefined;
        if (v) return v as NonNullable<T>;
      } catch (err) {
        lastErr = err;
      }
      await sleep(100);
    }
    const detail = lastErr ? `最后一次错误：${String(lastErr)}` : `最后一次的值：${JSON.stringify(last)}`;
    throw new Error(`等待超时（${timeout}ms）：${opts.message ?? '条件未满足'}；${detail}`);
  }

  async visible(selector: string): Promise<boolean> {
    return this.eval<boolean>(visibleExpr(selector));
  }

  async waitVisible(selector: string, timeout?: number): Promise<void> {
    await this.waitFor(visibleExpr(selector), { timeout, message: `${selector} 可见` });
  }

  async waitHidden(selector: string, timeout?: number): Promise<void> {
    await this.waitFor(`!${visibleExpr(selector)}`, { timeout, message: `${selector} 不可见` });
  }

  async text(selector: string): Promise<string> {
    return this.eval<string>(`document.querySelector(${q(selector)})?.textContent ?? ''`);
  }

  async exists(selector: string): Promise<boolean> {
    return this.eval<boolean>(`!!document.querySelector(${q(selector)})`);
  }

  async count(selector: string): Promise<number> {
    return this.eval<number>(`document.querySelectorAll(${q(selector)}).length`);
  }

  /** 点击元素（元素必须存在） */
  async click(selector: string): Promise<void> {
    const ok = await this.eval<boolean>(`(() => { const el = document.querySelector(${q(selector)});
      if (!el) return false; el.scrollIntoView({ block: 'nearest' }); el.click(); return true; })()`);
    if (!ok) throw new Error(`找不到要点击的元素：${selector}`);
  }

  /** 聚焦元素（元素必须存在） */
  async focus(selector: string): Promise<void> {
    const ok = await this.eval<boolean>(`(() => { const el = document.querySelector(${q(selector)});
      if (!el) return false; el.focus(); return true; })()`);
    if (!ok) throw new Error(`找不到要聚焦的元素：${selector}`);
  }

  /** 让焦点离开输入控件与终端，回到页面主体 */
  async blur(): Promise<void> {
    await this.eval(`(() => { const a = document.activeElement; if (a && a !== document.body) a.blur(); return true; })()`);
  }

  /** 清空输入框后以文本输入方式填入（触发 input 事件，与人工输入一致） */
  async fill(selector: string, value: string): Promise<void> {
    await this.focus(selector);
    await this.eval(`(() => { const el = document.querySelector(${q(selector)});
      el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    if (value) await this.page().insertText(value);
  }

  /** 按键组合，例如 'Control+Shift+K'、'Enter'、'y' */
  async press(combo: string): Promise<void> {
    await this.page().press(combo);
  }

  /** 向当前焦点输入文本 */
  async type(text: string): Promise<void> {
    await this.page().insertText(text);
  }

  async list(): Promise<SessionInfo[]> {
    return this.eval<SessionInfo[]>('window.panelApi.list()');
  }

  async session(id: string): Promise<SessionInfo | undefined> {
    return (await this.list()).find(s => s.id === id);
  }

  /** 会话终端缓冲（主进程的原始输出） */
  async output(id: string): Promise<string> {
    return this.eval<string>(`window.panelApi.output(${q(id)})`);
  }

  /** 模拟 Claude 上报一个 hook 事件；opts 可去掉令牌或改 Content-Type，用于验证拒绝路径 */
  async postHook(sessionId: string, payload: Record<string, unknown>,
    opts?: { token?: string | null; contentType?: string }): Promise<number> {
    return postHook(this.home, sessionId, payload, opts);
  }

  /** 全部日志文件内容 */
  logs(): string {
    return this.need().readLogs();
  }

  /** 页面未捕获异常 */
  exceptions(): string[] {
    return [...this.page().exceptions];
  }

  /** 重载页面并等待渲染层重新就绪 */
  async reload(): Promise<void> {
    await this.eval(`document.documentElement.dataset.panelReady = '0'`);
    await this.page().reload();
    await this.waitFor(`document.documentElement.dataset.panelReady === '1'`, { timeout: 15_000, message: '重载后就绪' });
  }

  /** 模拟视口尺寸（只影响页面排版，不改真实窗口）；不传则恢复按窗口实际尺寸排版，不传高度时沿用当前高度 */
  async viewport(width?: number, height?: number): Promise<void> {
    await this.page().viewport(width, height);
  }

  /** 页面截图，保存到失败现场目录下，返回文件路径 */
  async shot(name: string): Promise<string> {
    const dir = path.join(outRoot(), safeName(this.fileName));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safeName(name)}.png`);
    fs.writeFileSync(file, await this.page().screenshot());
    return file;
  }

  /** 保存现场：页面截图、控制台与主进程输出、DOM、日志目录 */
  async saveArtifacts(caseName: string): Promise<string | null> {
    const app = this.app;
    if (!app) return null;
    const dir = path.join(outRoot(), safeName(`${this.fileName}--${caseName}`));
    fs.mkdirSync(dir, { recursive: true });
    const page = app.page;
    if (page) {
      try { fs.writeFileSync(path.join(dir, 'screenshot.png'), await page.screenshot()); } catch (err) {
        fs.writeFileSync(path.join(dir, 'screenshot-error.txt'), String(err));
      }
      try {
        const html = await page.evaluate('document.documentElement.outerHTML');
        fs.writeFileSync(path.join(dir, 'dom.html'), String(html));
      } catch (err) {
        fs.writeFileSync(path.join(dir, 'dom-error.txt'), String(err));
      }
    }
    const consoleText = [
      '== 页面控制台 ==', ...(page?.console ?? []),
      '', '== 未捕获异常 ==', ...(page?.exceptions ?? []),
      '', '== 主进程输出 ==', ...app.output,
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'console.txt'), consoleText);
    const logs = path.join(app.home, 'logs');
    if (fs.existsSync(logs)) fs.cpSync(logs, path.join(dir, 'logs'), { recursive: true });
    return dir;
  }

  /** 由 useApp 调用 */
  async start(fileName: string, opts: UseAppOptions): Promise<void> {
    this.fileName = fileName;
    this.env = opts.env ?? {};
    this.app = await this.launchAt();
  }

  private env: Record<string, string> = {};

  private launchAt(root?: string, env: Record<string, string> = {}): Promise<LaunchedApp> {
    const port = Number(process.env.E2E_PORT || 9335);
    const exe = process.env.E2E_EXE || undefined;
    return launch({ port, exe, root, env: { ...this.env, ...env }, log: (m: string) => console.log(`[e2e] ${m}`) });
  }

  /**
   * 关闭当前实例并用同一临时根目录（同一 home、work、claude）重新启动，模拟退出后再打开面板。
   * 关闭前页面有未捕获异常时直接抛错；between 在两次启动之间执行（可改磁盘上的记录等）；
   * env 叠加在 useApp 的环境变量之上，只对新实例生效。
   */
  async restart(opts: { env?: Record<string, string>; between?: () => Promise<void> | void } = {}): Promise<void> {
    const prev = this.need();
    const exceptions = prev.page ? [...prev.page.exceptions] : [];
    if (exceptions.length > 0) {
      await this.saveArtifacts('重启前未捕获异常').catch(() => null);
      throw new Error(`重启前页面出现 ${exceptions.length} 个未捕获异常：\n${exceptions.join('\n---\n')}`);
    }
    const report = await prev.close({ keep: true });
    this.app = null;
    if (!report.portReleased) throw new Error(`重启前实例未完全关闭：${JSON.stringify(report)}`);
    await opts.between?.();
    this.app = await this.launchAt(prev.root, opts.env);
  }

  /** 由 useApp 调用 */
  async stop(): Promise<Record<string, unknown> | null> {
    const app = this.app;
    if (!app) return null;
    const report = await app.close({ keep: process.env.E2E_KEEP === '1' });
    this.app = null;
    return report;
  }
}

/**
 * 在当前用例文件中注册实例的启动与清理，返回操作句柄。
 * 每个文件一个全新实例；afterAll 先断言页面无未捕获异常，再清理（清理总会执行）。
 */
export function useApp(opts: UseAppOptions = {}): E2eApp {
  const e2e = new E2eApp();
  let fileName = 'unknown';

  // vitest 要求钩子第一个参数用解构写法，套件对象在第二个参数
  beforeAll(async ({}, suite) => {
    const file = suite.file?.name ?? suite.name ?? '';
    fileName = path.basename(file).replace(/\.e2e\.ts$/, '') || 'unknown';
    await e2e.start(fileName, opts);
  });

  beforeEach((ctx) => {
    ctx.onTestFailed(async () => {
      const dir = await e2e.saveArtifacts(ctx.task.name).catch(err => `保存失败：${String(err)}`);
      if (dir) console.log(`[e2e] 失败现场：${dir}`);
    });
  });

  afterAll(async () => {
    if (!e2e.app) return;
    const exceptions = e2e.app.page ? [...e2e.app.page.exceptions] : [];
    if (exceptions.length > 0) {
      await e2e.saveArtifacts('未捕获异常').catch(() => null);
    }
    const report = await e2e.stop();
    if (report && (!report.portReleased || (!report.removed && !report.kept))) {
      throw new Error(`实例清理不完整：${JSON.stringify(report)}`);
    }
    if (exceptions.length > 0) {
      throw new Error(`页面出现 ${exceptions.length} 个未捕获异常（${fileName}）：\n${exceptions.join('\n---\n')}`);
    }
  });

  return e2e;
}
