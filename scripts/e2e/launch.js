// @ts-check
'use strict';
/**
 * 启动一个隔离的面板实例供 e2e 使用：临时根目录、启动 electron、等待就绪、记录进程树、关闭与清理。
 *
 * 可单独运行，手动起一个隔离实例调试（Ctrl+C 结束并清理）：
 *   node scripts/e2e/launch.js [--port 9345] [--keep]
 * --keep 表示退出后保留临时根目录并打印路径。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const procs = require('./procs');
const { PanelPage, browserClose, findPageTarget, assertWebSocket } = require('./cdp');
const { readReceiverPort } = require('./hook');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const READY_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 8_000;
const PORT_TIMEOUT_MS = 10_000;

const CHROMIUM_FLAGS = [
  '--disable-gpu',
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

class PortBusyError extends Error {
  /** @param {number} port */
  constructor(port) {
    super(`调试端口 ${port} 已被占用（可能是手动调试中的实例）。请改用其他端口，例如 --port ${port === 9345 ? 9355 : 9345}；不会结束占用方。`);
    this.name = 'PortBusyError';
    this.port = port;
  }
}

/**
 * @typedef {object} LaunchOptions
 * @property {number} [port] 远程调试端口
 * @property {string} [exe] 指定可执行文件（安装版）；不传则用开发态 electron 加项目根
 * @property {Record<string, string>} [env] 额外环境变量，例如 CLAUDE_PANEL_ESCALATE_MS
 * @property {string} [root] 复用上一个实例保留下来的临时根目录（同一 home 重启），不传则新建
 * @property {(msg: string) => void} [log]
 */

/** @param {number} ms */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 轮询直到 fn 返回真值或超时
 * @template T
 * @param {() => Promise<T> | T} fn
 * @param {number} deadline
 * @param {string} what
 * @returns {Promise<T>}
 */
async function pollUntil(fn, deadline, what) {
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  throw new Error(`等待${what}超时${lastErr ? `（最后一次错误：${String(lastErr)}）` : ''}`);
}

/** 开发态的 electron 可执行文件路径 */
function devElectronPath() {
  // 在 node 中 require('electron') 返回 electron.exe 的路径
  const p = require('electron');
  if (typeof p !== 'string') throw new Error('无法解析 electron 可执行文件路径');
  return p;
}

/**
 * 展开环境变量值里的目录占位符：{root}、{home}、{work}、{claude} 替换为本实例临时根目录下的对应路径，
 * 用例在启动前拿不到临时目录，借此把 CLAUDE_PANEL_TRANSCRIPT_ROOT 之类的变量指向实例自己的目录。
 * @param {Record<string, string>} env
 * @param {Record<string, string>} dirs
 */
function expandEnv(env, dirs) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const s = String(v);
    const re = /\{(root|home|work|claude)\}/g;
    out[k] = re.test(s) ? path.normalize(s.replace(re, (_m, name) => dirs[name])) : s;
  }
  return out;
}

/**
 * 启动隔离实例并等待就绪。失败时自动清理后抛错。
 * @param {LaunchOptions} [opts]
 */
async function launch(opts = {}) {
  assertWebSocket();
  const port = opts.port ?? procs.DEFAULT_PORT;
  const say = opts.log ?? (() => {});
  if (await procs.portInUse(port)) throw new PortBusyError(port);

  const root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), procs.ROOT_PREFIX));
  if (!procs.isSafeTempRoot(root)) throw new Error(`临时根目录不符合预期：${root}`);
  if (opts.root && !fs.existsSync(root)) throw new Error(`要复用的临时根目录不存在：${root}`);
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  const claude = path.join(root, 'claude');
  for (const d of [home, work, claude]) fs.mkdirSync(d, { recursive: true });
  procs.assertSafePanelHome(home);

  const exe = opts.exe ?? devElectronPath();
  const args = [...(opts.exe ? [] : [PROJECT_ROOT]), `--remote-debugging-port=${port}`, ...CHROMIUM_FLAGS];
  const env = procs.buildChildEnv(process.env, {
    CLAUDE_PANEL_HOME: home,
    CLAUDE_PANEL_MOCK_CLAUDE: '1',
    CLAUDE_PANEL_DEVTOOLS: '0',
    CLAUDE_PANEL_WINDOW: 'inactive',
    CLAUDE_PANEL_NOTIFY: 'log',
    ...expandEnv(opts.env ?? {}, { root, home, work, claude }),
  });

  const owner = procs.ownerInfo();
  const spawnedAt = Date.now();
  const child = spawn(exe, args, { cwd: PROJECT_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  /** @type {string[]} */
  const output = [];
  const collect = (/** @type {Buffer} */ chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line) output.push(line);
    }
    if (output.length > 3000) output.splice(0, output.length - 3000);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  /** @type {number | null} */
  let exitCode = null;
  let exited = false;
  const exitPromise = new Promise(resolve => {
    child.once('exit', code => { exited = true; exitCode = code; resolve(undefined); });
    child.once('error', err => { exited = true; output.push(`[spawn error] ${String(err)}`); resolve(undefined); });
  });
  const pid = child.pid ?? 0;

  /** @type {procs.ProcInfo[]} */
  let snapshot = [];
  // 先记下主进程身份：快照写入前被强制中断时，下次运行据此清理
  procs.writePids(root, { owner, root: { pid, startedAt: spawnedAt }, port, procs: [] });

  const app = {
    root, home, work, claude, port, pid, exe,
    /** @type {InstanceType<typeof PanelPage> | null} */
    page: null,
    output,
    get exited() { return exited; },
    get exitCode() { return exitCode; },
    /** 重新记录进程树快照并写入 pids.json */
    async snapshot() {
      if (!exited) {
        const tree = await procs.snapshotTree(pid);
        // 合并历史快照：中途退出的会话进程也保留在清理名单里
        for (const p of tree) if (!snapshot.some(x => x.pid === p.pid && x.created === p.created)) snapshot.push(p);
      }
      procs.writePids(root, { owner, root: { pid, startedAt: spawnedAt }, port, procs: snapshot });
      return snapshot;
    },
    /** 当前全部日志文件内容（按文件名排序拼接） */
    readLogs() {
      const dir = path.join(home, 'logs');
      try {
        return fs.readdirSync(dir).filter(f => f.endsWith('.log')).sort()
          .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
      } catch {
        return '';
      }
    },
    /**
     * 关闭并清理：快照 → Browser.close → 等待退出（超时则结束自己的进程树）→ 按快照补结束 → 等端口释放 → 删除临时根目录
     * @param {{ keep?: boolean }} [o]
     */
    async close(o = {}) {
      const report = {
        graceful: false, forced: false, leftoverKilled: /** @type {number[]} */ ([]),
        portReleased: false, removed: false, kept: !!o.keep,
      };
      try { await app.snapshot(); } catch (err) { say(`关闭前快照失败：${String(err)}`); }
      app.page?.close();
      app.page = null;
      if (!exited) {
        try { await browserClose(port); } catch (err) { say(`Browser.close 失败：${String(err)}`); }
        await Promise.race([exitPromise, sleep(EXIT_TIMEOUT_MS)]);
        report.graceful = exited;
        if (!exited) {
          say(`主进程 ${pid} ${EXIT_TIMEOUT_MS}ms 内未退出，结束其进程树`);
          procs.killTree(pid);
          report.forced = true;
          await Promise.race([exitPromise, sleep(3000)]);
        }
      }
      try {
        const r = await procs.killSnapshot(snapshot);
        report.leftoverKilled = r.killed;
        if (r.killed.length) say(`按快照补结束 ${r.killed.length} 个进程：${r.killed.join(', ')}`);
      } catch (err) {
        say(`按快照清理失败：${String(err)}`);
      }
      report.portReleased = await procs.waitPortClosed(port, PORT_TIMEOUT_MS);
      if (o.keep) {
        procs.writePids(root, { owner, root: { pid, startedAt: spawnedAt }, port, kept: true, procs: snapshot });
        say(`已保留临时根目录：${root}`);
      } else {
        try { report.removed = procs.removeTempRoot(root); } catch (err) { say(`删除临时根目录失败：${String(err)}`); }
      }
      return report;
    },
  };

  try {
    const deadline = spawnedAt + READY_TIMEOUT_MS;
    await pollUntil(async () => {
      if (exited) throw new Error(`主进程已退出（code ${exitCode}）`);
      return findPageTarget(port);
    }, deadline, '面板页面目标');
    await pollUntil(() => {
      if (exited) throw new Error(`主进程已退出（code ${exitCode}）`);
      return readReceiverPort(home);
    }, deadline, ' receiver.port');
    app.page = await PanelPage.connect(port);
    const page = app.page;
    await pollUntil(async () => (await page.evaluate("document.documentElement.dataset.panelReady === '1'")) === true,
      deadline, '页面就绪标记');
    await app.snapshot();
  } catch (err) {
    const tail = output.slice(-30).join('\n');
    try { await app.close(); } catch { /* 清理失败不覆盖原始错误 */ }
    throw new Error(`实例启动失败：${err instanceof Error ? err.message : String(err)}${tail ? `\n主进程输出（末尾）：\n${tail}` : ''}`);
  }
  return app;
}

/** @typedef {Awaited<ReturnType<typeof launch>>} App */

async function main() {
  const args = procs.parseArgs(process.argv.slice(2), process.env);
  if (args.help) {
    console.log('用法：node scripts/e2e/launch.js [--port <端口>] [--keep]\n  启动隔离实例，Ctrl+C 结束并清理；--keep 保留临时根目录');
    return;
  }
  const say = (/** @type {string} */ m) => console.log(`[launch] ${m}`);
  const app = await launch({ port: args.port, log: say });
  say(`已就绪：pid ${app.pid}，调试端口 ${app.port}`);
  say(`临时根目录：${app.root}`);
  say('按 Ctrl+C 结束并清理');
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const r = await app.close({ keep: args.keep });
    say(`清理完成：${JSON.stringify(r)}`);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // 窗口被手动关掉（托盘退出）时同样清理
  const timer = setInterval(() => { if (app.exited) { clearInterval(timer); void shutdown(); } }, 500);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

module.exports = { launch, PortBusyError, PROJECT_ROOT, CHROMIUM_FLAGS };
