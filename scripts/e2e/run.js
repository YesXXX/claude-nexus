// @ts-check
'use strict';
/**
 * e2e 运行入口：npm run e2e [-- --packaged] [--port 9345] [--keep] [--no-build] [用例过滤词...]
 *
 * 前置检查（平台、Node 版本、调试端口）→ 清理上次被强制中断留下的残留 → 构建 → 串行运行 vitest e2e 用例 → 收尾自检。
 * 端口被占用时直接报错退出，不结束占用方。
 * --packaged 针对 electron-builder 生成的 release/win-unpacked 目录版运行，不执行 npm run build。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const procs = require('./procs');
const { assertWebSocket } = require('./cdp');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGED_EXE = path.join(PROJECT_ROOT, 'release', 'win-unpacked', 'Claude Nexus.exe');

const HELP = [
  '用法：npm run e2e -- [选项] [用例过滤词...]',
  `  --packaged      针对安装版目录 release/win-unpacked 运行（默认端口 ${procs.DEFAULT_PACKAGED_PORT}，不执行构建）`,
  `  --port <端口>   远程调试端口，默认 ${procs.DEFAULT_PORT}（也可用环境变量 E2E_PORT）`,
  '  --keep          结束后保留每个实例的临时根目录（打印路径），供排查',
  '  --no-build      跳过 npm run build',
  '  过滤词          只运行文件名包含过滤词的用例，例如 02 palette',
].join('\n');

const say = (/** @type {string} */ m) => console.log(`[e2e] ${m}`);

function timestamp() {
  const d = new Date();
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 前置检查失败时打印原因并以非零码退出 */
function fail(/** @type {string} */ msg) {
  console.error(`[e2e] ${msg}`);
  process.exit(2);
}

/**
 * 运行一轮 vitest，返回退出码。非 0 时打印退出码：1 是有用例失败，
 * 大于 255 的 NTSTATUS（如 0xC0000409）说明进程原生崩溃
 * @param {string[]} vitestArgs
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<number>}
 */
function runVitest(vitestArgs, env) {
  const child = spawn(process.execPath, vitestArgs, { cwd: PROJECT_ROOT, env, stdio: 'inherit' });
  return new Promise(resolve => {
    child.once('exit', (c, sig) => {
      if (c !== 0) say(`用例进程退出：code=${c}${c !== null && c > 255 ? `（0x${(c >>> 0).toString(16)}）` : ''} signal=${sig ?? '-'}`);
      resolve(c ?? (sig ? 1 : 0));
    });
    child.once('error', err => { console.error(err); resolve(1); });
  });
}

/** Windows 上 NTSTATUS 错误码（0xC0000000 起）表示进程异常终止，而不是用例失败 */
function isNativeCrash(/** @type {number} */ code) {
  return code >>> 0 >= 0xC0000000;
}

async function main() {
  /** @type {ReturnType<typeof procs.parseArgs>} */
  let args;
  try {
    args = procs.parseArgs(process.argv.slice(2), process.env);
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\n${HELP}`);
    return;
  }
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (process.platform !== 'win32') fail('e2e 目前只支持 Windows（进程树与清理依赖 PowerShell 与 taskkill）');
  try { assertWebSocket(); } catch (err) { fail(err instanceof Error ? err.message : String(err)); }
  if (args.packaged && !fs.existsSync(PACKAGED_EXE)) {
    fail(`找不到安装版目录版：${PACKAGED_EXE}\n请先执行 npm run build && npx electron-builder --win --dir`);
  }

  const sweep = await procs.sweepLeftovers(say);
  if (sweep.removed.length) say(`已清理上次残留的临时目录 ${sweep.removed.length} 个`);

  if (await procs.portInUse(args.port)) {
    fail(`调试端口 ${args.port} 已被占用（可能是手动调试中的实例），不会结束占用方。请换一个端口，例如：npm run e2e -- ${args.packaged ? '--packaged ' : ''}--port ${args.port === 9345 ? 9355 : 9345}`);
  }

  if (args.packaged) {
    say(`安装版模式：${PACKAGED_EXE}（不执行 npm run build，源码改动需重新打包才会生效）`);
  } else if (args.build) {
    say('构建：npm run build');
    const r = spawnSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit', shell: true });
    if (r.status !== 0) fail(`构建失败（退出码 ${r.status}）`);
  }

  const outDir = path.join(PROJECT_ROOT, '.e2e-out', timestamp());
  /** @type {Record<string, string | undefined>} */
  const env = {
    ...process.env,
    E2E_PORT: String(args.port),
    E2E_KEEP: args.keep ? '1' : '0',
    E2E_OUT: outDir,
  };
  // 只由 --packaged 决定可执行文件，外部环境里残留的 E2E_EXE 不生效
  delete env.E2E_EXE;
  if (args.packaged) env.E2E_EXE = PACKAGED_EXE;
  const vitest = path.join(PROJECT_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const vitestArgs = [vitest, 'run', '--config', 'vitest.e2e.config.ts', ...args.filters];
  say(`运行用例：${args.packaged ? '安装版' : '开发态'}，调试端口 ${args.port}${args.filters.length ? `，过滤 ${args.filters.join(' ')}` : ''}`);
  const started = Date.now();

  // Ctrl+C 同时送达 vitest；这里不立即退出，等它结束后再做残留清理
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    say('收到中断信号，等待用例进程结束后清理残留…');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let code = await runVitest(vitestArgs, env);
  if (!interrupted && isNativeCrash(code)) {
    // 用例进程偶发原生崩溃（Node 自身 abort，退出码 0xC0000409，无任何输出），与被测应用无关；
    // 清掉崩溃留下的实例后整轮重跑一次，重跑结果为准，崩溃记录保留在输出里
    say(`用例进程原生崩溃（0x${(code >>> 0).toString(16)}），清理后整轮重跑一次`);
    const swept = await procs.sweepLeftovers(say);
    if (swept.removed.length) say(`已清理崩溃留下的临时目录 ${swept.removed.length} 个`);
    if (!(await procs.waitPortClosed(args.port, 10_000))) fail(`调试端口 ${args.port} 未释放，无法重跑`);
    code = await runVitest(vitestArgs, env);
  }

  const after = await procs.sweepLeftovers(say);
  if (after.removed.length) say(`收尾清理了 ${after.removed.length} 个残留临时目录（用例进程未正常清理）`);
  const portFree = await procs.waitPortClosed(args.port, 10_000);
  if (!portFree) say(`警告：调试端口 ${args.port} 仍可连接`);
  say(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (fs.existsSync(outDir)) say(`失败现场：${outDir}`);

  process.exit(interrupted ? 130 : (portFree ? code : (code || 1)));
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
