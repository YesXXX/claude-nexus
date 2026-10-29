import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';

// e2e 脚本是 CommonJS，可直接 node 运行，这里按 CommonJS 加载
const require = createRequire(import.meta.url);
const procs = require('../scripts/e2e/procs.js');
const cdp = require('../scripts/e2e/cdp.js');

const tmp = os.tmpdir();
const userHome = os.homedir();

describe('panelHomeProblem：测试实例数据目录守卫', () => {
  it('临时目录下的目录放行', () => {
    expect(procs.panelHomeProblem(path.join(tmp, 'nexus-e2e-abc', 'home'))).toBeNull();
  });

  it('真实面板数据目录及其子目录被拒绝', () => {
    const real = path.join(userHome, '.claude-session-panel');
    expect(procs.panelHomeProblem(real)).toMatch(/真实/);
    expect(procs.panelHomeProblem(path.join(real, 'sub'))).toMatch(/真实/);
  });

  it('包含真实面板数据目录的上级目录被拒绝', () => {
    expect(procs.panelHomeProblem(userHome, { tmpdir: path.dirname(userHome) })).toMatch(/真实/);
  });

  it('不在系统临时目录下被拒绝', () => {
    expect(procs.panelHomeProblem(path.join(userHome, 'some-dir'))).toMatch(/临时目录/);
    expect(procs.panelHomeProblem(tmp)).toMatch(/临时目录/);
  });

  it('带 .. 的穿越写法被拒绝，即使解析后仍在临时目录下', () => {
    // 用字符串拼接而非 path.join，后者会把 .. 规范化掉
    expect(procs.panelHomeProblem(`${tmp}\\a\\..\\b`)).toMatch(/\.\./);
    expect(procs.panelHomeProblem(`${tmp}\\nexus-e2e-x\\..\\..\\Users`)).toMatch(/\.\./);
  });

  it('空值与相对路径被拒绝', () => {
    expect(procs.panelHomeProblem('')).not.toBeNull();
    expect(procs.panelHomeProblem('relative\\home')).toMatch(/绝对路径/);
  });

  it('assertSafePanelHome 不合法时抛错', () => {
    expect(() => procs.assertSafePanelHome(path.join(userHome, '.claude-session-panel'))).toThrow();
    expect(() => procs.assertSafePanelHome(path.join(tmp, 'nexus-e2e-ok', 'home'))).not.toThrow();
  });
});

describe('isSafeTempRoot：可删除的临时根目录', () => {
  it('系统临时目录下 nexus-e2e- 开头的直接子目录', () => {
    expect(procs.isSafeTempRoot(path.join(tmp, 'nexus-e2e-AbC123'))).toBe(true);
  });

  it('前缀不符、只有前缀、层级更深、不在临时目录下、带 .. 均拒绝', () => {
    expect(procs.isSafeTempRoot(path.join(tmp, 'other-AbC123'))).toBe(false);
    expect(procs.isSafeTempRoot(path.join(tmp, 'nexus-e2e-'))).toBe(false);
    expect(procs.isSafeTempRoot(path.join(tmp, 'nexus-e2e-a', 'nexus-e2e-b'))).toBe(false);
    expect(procs.isSafeTempRoot(path.join(userHome, 'nexus-e2e-x'))).toBe(false);
    expect(procs.isSafeTempRoot(`${tmp}\\x\\..\\nexus-e2e-y`)).toBe(false);
    expect(procs.isSafeTempRoot('')).toBe(false);
    expect(procs.isSafeTempRoot(tmp)).toBe(false);
  });

  it('removeTempRoot 拒绝不安全的目录', () => {
    expect(() => procs.removeTempRoot(userHome)).toThrow(/拒绝删除/);
  });
});

describe('buildChildEnv：子进程环境', () => {
  it('去掉 ELECTRON_RUN_AS_NODE、CLAUDECODE、CLAUDE_CODE_* 与外部的 CLAUDE_PANEL_*，大小写不敏感', () => {
    const env = procs.buildChildEnv({
      PATH: 'p',
      ELECTRON_RUN_AS_NODE: '1',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      claude_code_sse_port: '1',
      CLAUDE_PANEL_HOME: 'C:\\real',
      Claude_Panel_Devtools: '1',
      UNDEF: undefined,
    }, { CLAUDE_PANEL_HOME: 'C:\\tmp\\home' });
    expect(env).toEqual({ PATH: 'p', CLAUDE_PANEL_HOME: 'C:\\tmp\\home' });
  });
});

describe('parseArgs：e2e 参数', () => {
  it('默认值', () => {
    expect(procs.parseArgs([])).toEqual({ port: 9335, keep: false, build: true, packaged: false, help: false, filters: [] });
  });

  it('--port 两种写法、--keep、--no-build 与过滤词', () => {
    const a = procs.parseArgs(['--port', '9345', '--keep', '--no-build', '02', 'palette']);
    expect(a).toEqual({ port: 9345, keep: true, build: false, packaged: false, help: false, filters: ['02', 'palette'] });
    expect(procs.parseArgs(['--port=9400']).port).toBe(9400);
  });

  it('E2E_PORT 生效，--port 优先', () => {
    expect(procs.parseArgs([], { E2E_PORT: '9350' }).port).toBe(9350);
    expect(procs.parseArgs(['--port', '9351'], { E2E_PORT: '9350' }).port).toBe(9351);
  });

  it('--packaged 默认使用安装版端口，--port 与 E2E_PORT 仍可覆盖', () => {
    const a = procs.parseArgs(['--packaged', '03']);
    expect(a).toEqual({ port: 9336, keep: false, build: true, packaged: true, help: false, filters: ['03'] });
    expect(procs.DEFAULT_PACKAGED_PORT).toBe(9336);
    expect(procs.parseArgs(['--packaged', '--port', '9346']).port).toBe(9346);
    expect(procs.parseArgs(['--port=9347', '--packaged']).port).toBe(9347);
    expect(procs.parseArgs(['--packaged'], { E2E_PORT: '9352' }).port).toBe(9352);
  });

  it('非法端口与未知参数报错', () => {
    expect(() => procs.parseArgs(['--port'])).toThrow();
    expect(() => procs.parseArgs(['--port', 'abc'])).toThrow(/端口/);
    expect(() => procs.parseArgs(['--port', '80'])).toThrow(/端口/);
    expect(() => procs.parseArgs(['--port', '70000'])).toThrow(/端口/);
    expect(() => procs.parseArgs([], { E2E_PORT: 'x' })).toThrow(/端口/);
    expect(() => procs.parseArgs(['--bogus'])).toThrow(/未知参数/);
  });
});

describe('进程树', () => {
  const list = [
    '0 0 0 System Idle Process',
    '100 4 1000 electron.exe',
    '101 100 1001 electron.exe',
    '102 100 1002 OpenConsole.exe',
    '103 102 1003 node.exe',
    '104 100 900 reused.exe',
    '105 104 1005 child-of-reused.exe',
    '200 4 1000 Claude Nexus.exe',
    '',
    'garbage line',
  ].join('\r\n');

  it('parseProcessList 解析 pid、父 pid、创建时间与含空格的进程名', () => {
    const m = procs.parseProcessList(list);
    expect(m.size).toBe(8);
    expect(m.get(200)).toEqual({ pid: 200, ppid: 4, created: '1000', name: 'Claude Nexus.exe' });
  });

  it('collectTree 广度遍历后代，跳过创建时间早于父进程的（pid 复用）', () => {
    const tree = procs.collectTree(procs.parseProcessList(list), 100);
    expect(tree.map((p: { pid: number }) => p.pid)).toEqual([100, 101, 102, 103]);
  });

  it('collectTree 根进程不存在时返回空', () => {
    expect(procs.collectTree(procs.parseProcessList(list), 999)).toEqual([]);
  });

  it('filetimeToMs 与 sameStart', () => {
    const ms = Date.UTC(2026, 0, 1);
    const ft = String((BigInt(ms) + 11644473600000n) * 10000n);
    expect(procs.filetimeToMs(ft)).toBe(ms);
    expect(procs.sameStart(ft, ms + 2000)).toBe(true);
    expect(procs.sameStart(ft, ms + 5000)).toBe(false);
    expect(procs.sameStart('0', 0)).toBe(false);
  });
});

describe('keyEventParams：按键组合', () => {
  it('普通字母带 text，Shift 时为大写', () => {
    expect(cdp.keyEventParams('y')).toEqual({ key: 'y', code: 'KeyY', windowsVirtualKeyCode: 89, text: 'y', modifiers: 0 });
    expect(cdp.keyEventParams('Shift+k')).toMatchObject({ key: 'K', code: 'KeyK', modifiers: 8, text: 'K' });
  });

  it('带 Ctrl 的组合不附带 text', () => {
    const p = cdp.keyEventParams('Control+Shift+D');
    expect(p).toEqual({ key: 'D', code: 'KeyD', windowsVirtualKeyCode: 68, modifiers: 10 });
    expect(cdp.keyEventParams('Ctrl+1')).toEqual({ key: '1', code: 'Digit1', windowsVirtualKeyCode: 49, modifiers: 2 });
  });

  it('命名键', () => {
    expect(cdp.keyEventParams('Enter')).toMatchObject({ key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    expect(cdp.keyEventParams('Escape')).toEqual({ key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, modifiers: 0 });
  });

  it('未知按键或修饰键报错', () => {
    expect(() => cdp.keyEventParams('F13')).toThrow();
    expect(() => cdp.keyEventParams('Hyper+a')).toThrow();
  });

  it('isPanelPage 只认面板主页面', () => {
    expect(cdp.isPanelPage({ type: 'page', url: 'file:///D:/x/dist/renderer/index.html' })).toBe(true);
    expect(cdp.isPanelPage({ type: 'page', url: 'devtools://devtools/bundled/renderer/index.html' })).toBe(false);
    expect(cdp.isPanelPage({ type: 'service_worker', url: 'file:///D:/x/dist/renderer/index.html' })).toBe(false);
  });
});
