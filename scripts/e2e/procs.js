// @ts-check
'use strict';
/**
 * e2e 的进程与路径工具：进程树快照（pid + 创建时间）、按快照结束进程、端口检测、临时目录安全校验、参数解析。
 * 只结束自己启动的进程树里、且创建时间与快照一致的进程，pid 被复用时跳过，绝不按进程名批量结束。
 */
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

/** 临时根目录名前缀：清理与残留扫描只认这个前缀 */
const ROOT_PREFIX = 'nexus-e2e-';
const DEFAULT_PORT = 9335;
/** 安装版模式的默认端口，与开发态错开，两者可以同时运行 */
const DEFAULT_PACKAGED_PORT = 9336;

/**
 * @typedef {{ pid: number, ppid: number, name: string, created: string }} ProcInfo
 * @typedef {{ pid: number, startedAt: number }} StartInfo
 * @typedef {{ owner?: StartInfo, root?: StartInfo, port?: number, kept?: boolean, procs: ProcInfo[] }} PidsFile
 */

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/**
 * Windows 路径不区分大小写，比较前统一；路径中已存在的最长前缀先解析真实路径（展开 8.3 短文件名与链接），
 * 其余部分按字面拼接
 */
function norm(/** @type {string} */ p) {
  const abs = path.resolve(p);
  let head = abs;
  /** @type {string[]} */
  const rest = [];
  for (;;) {
    try {
      head = fs.realpathSync.native(head);
      break;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) { head = abs; rest.length = 0; break; }
      rest.unshift(path.basename(head));
      head = parent;
    }
  }
  const r = path.join(head, ...rest);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** child 是否严格位于 parent 之下（不含 parent 本身） */
function isUnder(/** @type {string} */ child, /** @type {string} */ parent) {
  const rel = path.relative(norm(parent), norm(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 原始输入里是否带 `..` 路径段（resolve 之前检查，穿越写法一律拒绝） */
function hasDotDot(/** @type {string} */ p) {
  return p.split(/[\\/]+/).some(seg => seg === '..');
}

/**
 * 校验测试实例的 CLAUDE_PANEL_HOME：必须位于系统临时目录下、不能带 `..`、不能是真实的 ~/.claude-session-panel。
 * 返回拒绝原因，合法时返回 null。
 * @param {string} home
 * @param {{ tmpdir?: string, homedir?: string }} [opts]
 */
function panelHomeProblem(home, opts = {}) {
  const tmp = opts.tmpdir ?? os.tmpdir();
  const userHome = opts.homedir ?? os.homedir();
  if (typeof home !== 'string' || !home.trim()) return 'CLAUDE_PANEL_HOME 为空';
  if (!path.isAbsolute(home)) return `CLAUDE_PANEL_HOME 必须是绝对路径：${home}`;
  if (hasDotDot(home)) return `CLAUDE_PANEL_HOME 不能包含 .. 路径段：${home}`;
  const real = path.join(userHome, '.claude-session-panel');
  if (norm(home) === norm(real) || isUnder(home, real) || isUnder(real, home)) {
    return `CLAUDE_PANEL_HOME 不能指向真实的面板数据目录：${home}`;
  }
  if (!isUnder(home, tmp)) return `CLAUDE_PANEL_HOME 必须位于系统临时目录 ${tmp} 下：${home}`;
  return null;
}

/** 同上，不合法时抛错 */
function assertSafePanelHome(/** @type {string} */ home, /** @type {{ tmpdir?: string, homedir?: string }} */ opts = {}) {
  const why = panelHomeProblem(home, opts);
  if (why) throw new Error(why);
}

/**
 * 临时根目录是否可以删除：直接位于系统临时目录下、目录名以 nexus-e2e- 开头、不带 `..`。
 * @param {string} root
 * @param {string} [tmp]
 */
function isSafeTempRoot(root, tmp = os.tmpdir()) {
  if (typeof root !== 'string' || !root.trim() || !path.isAbsolute(root) || hasDotDot(root)) return false;
  const resolved = path.resolve(root);
  if (norm(path.dirname(resolved)) !== norm(tmp)) return false;
  const base = path.basename(resolved);
  return base.startsWith(ROOT_PREFIX) && base.length > ROOT_PREFIX.length;
}

/** 校验通过才删除临时根目录；返回是否删除成功 */
function removeTempRoot(/** @type {string} */ root) {
  if (!isSafeTempRoot(root)) throw new Error(`拒绝删除不在临时目录下或名称不符的目录：${root}`);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  return !fs.existsSync(root);
}

/**
 * 生成子进程环境：去掉会让 electron 以 node 方式运行的 ELECTRON_RUN_AS_NODE，
 * 去掉从 Claude Code 中运行时继承的 CLAUDECODE 与 CLAUDE_CODE_*，以及外部残留的 CLAUDE_PANEL_*，再叠加 extra。
 * Windows 环境变量名不区分大小写，按大写比较。
 * @param {Record<string, string | undefined>} base
 * @param {Record<string, string>} extra
 */
function buildChildEnv(base, extra) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const up = k.toUpperCase();
    if (up === 'ELECTRON_RUN_AS_NODE' || up === 'CLAUDECODE') continue;
    if (up.startsWith('CLAUDE_CODE_') || up.startsWith('CLAUDE_PANEL_')) continue;
    env[k] = v;
  }
  return Object.assign(env, extra);
}

/** @param {unknown} v */
function parsePort(v) {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) throw new Error(`端口必须是 1024~65535 的整数：${s || '(空)'}`);
  const n = Number(s);
  if (n < 1024 || n > 65535) throw new Error(`端口必须是 1024~65535 的整数：${s}`);
  return n;
}

/**
 * 解析 e2e 命令行参数。端口优先级：--port > E2E_PORT > 默认值（--packaged 时为安装版默认端口）。
 * 其余不以 -- 开头的参数作为用例文件过滤词。
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 */
function parseArgs(argv, env = {}) {
  const out = {
    port: DEFAULT_PORT,
    keep: false,
    build: true,
    packaged: false,
    help: false,
    /** @type {string[]} */
    filters: [],
  };
  let portSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') out.keep = true;
    else if (a === '--no-build') out.build = false;
    else if (a === '--packaged') out.packaged = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--port') {
      if (i + 1 >= argv.length) throw new Error('--port 后需要端口号');
      out.port = parsePort(argv[++i]);
      portSet = true;
    } else if (a.startsWith('--port=')) {
      out.port = parsePort(a.slice('--port='.length));
      portSet = true;
    } else if (a.startsWith('-')) {
      throw new Error(`未知参数：${a}`);
    } else {
      out.filters.push(a);
    }
  }
  if (!portSet && env.E2E_PORT !== undefined && env.E2E_PORT !== '') out.port = parsePort(env.E2E_PORT);
  else if (!portSet && out.packaged) out.port = DEFAULT_PACKAGED_PORT;
  return out;
}

// ---- 进程 ----

const PS_LIST = [
  'Get-CimInstance Win32_Process | ForEach-Object {',
  "  $c = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 };",
  "  '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $c, $_.Name",
  '}',
].join(' ');

/** @param {string} text @returns {Map<number, ProcInfo>} */
function parseProcessList(text) {
  /** @type {Map<number, ProcInfo>} */
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d+) (\d+) (\d+) (.*)$/.exec(line.trim());
    if (!m) continue;
    const pid = Number(m[1]);
    map.set(pid, { pid, ppid: Number(m[2]), created: m[3], name: m[4] });
  }
  return map;
}

/** 当前全部进程（pid → 父 pid、名称、创建时间）；创建时间是 FILETIME 字符串，用于识别 pid 复用 */
function listProcesses() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => {
        if (err) reject(new Error(`读取进程列表失败：${err.message}`));
        else resolve(parseProcessList(String(stdout)));
      });
  });
}

/**
 * 从 rootPid 出发按 ParentProcessId 广度遍历，返回自身与全部后代。
 * 子进程的创建时间必须不早于父进程，防止已退出父进程的 pid 被复用后误认后代。
 * @param {Map<number, ProcInfo>} all
 * @param {number} rootPid
 * @returns {ProcInfo[]}
 */
function collectTree(all, rootPid) {
  const root = all.get(rootPid);
  if (!root) return [];
  /** @type {Map<number, ProcInfo[]>} */
  const children = new Map();
  for (const p of all.values()) {
    if (p.pid === p.ppid) continue;
    const list = children.get(p.ppid) ?? [];
    list.push(p);
    children.set(p.ppid, list);
  }
  const out = [root];
  const seen = new Set([rootPid]);
  for (let i = 0; i < out.length; i++) {
    const parent = out[i];
    for (const c of children.get(parent.pid) ?? []) {
      if (seen.has(c.pid)) continue;
      if (BigInt(c.created) < BigInt(parent.created)) continue;
      seen.add(c.pid);
      out.push(c);
    }
  }
  return out;
}

/** 进程树快照 */
async function snapshotTree(/** @type {number} */ rootPid) {
  return collectTree(await listProcesses(), rootPid);
}

/** FILETIME（100ns，自 1601 年起）转为 Unix 毫秒 */
function filetimeToMs(/** @type {string} */ ft) {
  return Number(BigInt(ft) / 10000n) - 11644473600000;
}

/** 进程创建时间与记录的启动时刻是否吻合（容差内），用来确认 pid 没有被复用 */
function sameStart(/** @type {string} */ created, /** @type {number} */ ms, tolerance = 3000) {
  if (!/^\d+$/.test(created) || created === '0') return false;
  return Math.abs(filetimeToMs(created) - ms) <= tolerance;
}

/** 本进程（运行 e2e 的 node）的身份，写进 pids.json，残留扫描据此判断该目录的主人是否还活着 */
function ownerInfo() {
  return { pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1000) };
}

/**
 * 按快照结束进程：仍存在且创建时间一致才结束，pid 已复用则跳过。
 * @param {ProcInfo[]} procs
 */
async function killSnapshot(procs) {
  const result = { killed: [], reused: [], gone: [] };
  if (procs.length === 0) return result;
  const now = await listProcesses();
  for (const p of procs) {
    const cur = now.get(p.pid);
    if (!cur) { /** @type {number[]} */ (result.gone).push(p.pid); continue; }
    if (cur.created !== p.created) { /** @type {number[]} */ (result.reused).push(p.pid); continue; }
    try {
      execFileSync('taskkill', ['/PID', String(p.pid), '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch { /* 进程可能刚好自行退出 */ }
    /** @type {number[]} */ (result.killed).push(p.pid);
  }
  return result;
}

/** 只针对自己启动的 pid 结束整棵进程树 */
function killTree(/** @type {number} */ pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 快照中仍存活（且创建时间一致）的进程 */
async function aliveFromSnapshot(/** @type {ProcInfo[]} */ procs) {
  const now = await listProcesses();
  return procs.filter(p => now.get(p.pid)?.created === p.created);
}

// ---- 端口 ----

/** 能连上 127.0.0.1:port 即视为被占用 */
function canConnect(/** @type {number} */ port, timeout = 1000) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (/** @type {boolean} */ v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** 在 127.0.0.1 上监听失败（EADDRINUSE 等）也视为被占用 */
function canListen(/** @type {number} */ port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function portInUse(/** @type {number} */ port) {
  if (await canConnect(port)) return true;
  return !(await canListen(port));
}

/** 轮询直到端口连接被拒绝；返回是否在超时内释放 */
async function waitPortClosed(/** @type {number} */ port, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (!(await canConnect(port, 500))) return true;
    await sleep(200);
  }
  return !(await canConnect(port, 500));
}

// ---- pids.json 与残留清理 ----

function pidsFile(/** @type {string} */ root) {
  return path.join(root, 'pids.json');
}

/** @param {string} root @param {PidsFile} data */
function writePids(root, data) {
  fs.writeFileSync(pidsFile(root), JSON.stringify(data, null, 2));
}

/** @returns {PidsFile | null} */
function readPids(/** @type {string} */ root) {
  try {
    const data = JSON.parse(fs.readFileSync(pidsFile(root), 'utf8'));
    return data && Array.isArray(data.procs) ? data : null;
  } catch {
    return null;
  }
}

/**
 * 扫描系统临时目录下残留的 nexus-e2e-* 目录（上次运行被强制中断留下的）：
 * 主人进程仍在运行的（例如正在手动调试的 launch.js）与 --keep 保留的目录跳过；
 * 其余按 pids.json 只结束创建时间仍匹配的进程，再删除目录。
 * 快照还没来得及写入时，用记录的主进程 pid 与启动时刻核对身份后结束它的进程树。
 * @param {(msg: string) => void} [say]
 */
async function sweepLeftovers(say = () => {}) {
  const tmp = os.tmpdir();
  const report = { removed: /** @type {string[]} */ ([]), skipped: /** @type {string[]} */ ([]), killed: 0 };
  let names;
  try { names = fs.readdirSync(tmp); } catch { return report; }
  const dirs = names.filter(n => n.startsWith(ROOT_PREFIX)).map(n => path.join(tmp, n))
    .filter(d => { try { return fs.statSync(d).isDirectory() && isSafeTempRoot(d, tmp); } catch { return false; } });
  if (dirs.length === 0) return report;
  const now = await listProcesses();
  /** @param {StartInfo | undefined} s */
  const alive = s => {
    const cur = s ? now.get(s.pid) : undefined;
    return !!s && !!cur && sameStart(cur.created, s.startedAt);
  };
  for (const dir of dirs) {
    const data = readPids(dir);
    if (data?.kept) { report.skipped.push(dir); continue; }
    if (data?.owner && data.owner.pid !== process.pid && alive(data.owner)) {
      report.skipped.push(dir);
      continue;
    }
    if (data) {
      /** @type {ProcInfo[]} */
      const procs = [...data.procs];
      if (data.root && alive(data.root)) {
        for (const p of collectTree(now, data.root.pid)) {
          if (!procs.some(x => x.pid === p.pid)) procs.push(p);
        }
      }
      const r = await killSnapshot(procs);
      report.killed += r.killed.length;
      if (r.killed.length) say(`残留目录 ${dir}：结束 ${r.killed.length} 个遗留进程（pid ${r.killed.join(', ')}）`);
    }
    try {
      if (removeTempRoot(dir)) report.removed.push(dir);
      else report.skipped.push(dir);
    } catch (err) {
      say(`残留目录删除失败 ${dir}：${String(err)}`);
      report.skipped.push(dir);
    }
  }
  return report;
}

module.exports = {
  ROOT_PREFIX,
  DEFAULT_PORT,
  DEFAULT_PACKAGED_PORT,
  sleep,
  isUnder,
  panelHomeProblem,
  assertSafePanelHome,
  isSafeTempRoot,
  removeTempRoot,
  buildChildEnv,
  parsePort,
  parseArgs,
  parseProcessList,
  listProcesses,
  collectTree,
  snapshotTree,
  filetimeToMs,
  sameStart,
  ownerInfo,
  killSnapshot,
  killTree,
  aliveFromSnapshot,
  canConnect,
  portInUse,
  waitPortClosed,
  writePids,
  readPids,
  sweepLeftovers,
};
