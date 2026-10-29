import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import {
  cmdBridgeArgs,
  launchEditorVars,
  resolveProgram,
  substituteEditorArgs,
  tokenizeEditorCommand,
  type LaunchDeps,
} from '../src/main/editor-launch';

/** 与 child_process.spawn 的返回对象够像即可：once 监听、unref 不做事 */
type FakeChild = EventEmitter & { unref(): void };

function fakeSpawn(behavior: (child: FakeChild) => void) {
  const calls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = [];
  const impl = ((file: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ file, args, opts });
    const child = new EventEmitter() as FakeChild;
    child.unref = () => undefined;
    behavior(child);
    return child;
  }) as unknown as typeof spawn;
  return { impl, calls };
}

describe('tokenizeEditorCommand', () => {
  it('按空白切分，双引号里的空白不算分隔符，引号不保留', () => {
    expect(tokenizeEditorCommand('code -g {file}:{line}')).toEqual({
      ok: true, argv: ['code', '-g', '{file}:{line}'],
    });
    expect(tokenizeEditorCommand('"C:\\Program Files\\IDE\\bin\\idea.exe" --line {line} {file}')).toEqual({
      ok: true, argv: ['C:\\Program Files\\IDE\\bin\\idea.exe', '--line', '{line}', '{file}'],
    });
    expect(tokenizeEditorCommand('  code   {file}  ')).toEqual({ ok: true, argv: ['code', '{file}'] });
  });

  it('空命令与未闭合的引号报错', () => {
    expect(tokenizeEditorCommand('   ')).toEqual({ ok: false, error: '命令为空' });
    expect(tokenizeEditorCommand('')).toEqual({ ok: false, error: '命令为空' });
    expect(tokenizeEditorCommand('code "unclosed {file}')).toEqual({ ok: false, error: '命令里的双引号没有闭合' });
  });
});

describe('substituteEditorArgs', () => {
  it('占位符做整参替换，行号列号补默认值', () => {
    expect(substituteEditorArgs(
      ['code', '-g', '{file}:{line}:{col}'],
      { file: 'D:\\x\\a b.txt', line: 12, col: 3 },
    )).toEqual({ ok: true, program: 'code', args: ['-g', 'D:\\x\\a b.txt:12:3'] });
    expect(substituteEditorArgs(['idea', '--line', '{line}', '{file}'], { file: 'a.txt', line: 7 })).toEqual({
      ok: true, program: 'idea', args: ['--line', '7', 'a.txt'],
    });
  });

  it('参数里没有 {file} 时拒绝启动；程序名里的占位符不替换', () => {
    expect(substituteEditorArgs(['code', '{line}'], { file: 'a', line: 1 })).toEqual({
      ok: false, error: '命令里没有 {file} 占位符，无法确定要打开的文件',
    });
    const r = substituteEditorArgs(['{file}', '{file}'], { file: 'a.txt', line: 2 });
    expect(r.ok && r.program).toBe('{file}');
  });
});

describe('resolveProgram', () => {
  const winEnv = { PATH: 'C:\\tools;C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };

  it('裸名沿 PATH 与 PATHEXT 找：.cmd 标记为走 cmd 代跑，.exe 直接启动', () => {
    const exists = (p: string): boolean => p.toLowerCase() === 'c:\\tools\\code.cmd';
    const cmd = resolveProgram('code', { isWindows: true, env: winEnv, existsSync: exists });
    // 扩展名按 PATHEXT 里的写法补全（真实环境是大写）
    expect(cmd).toEqual({ file: 'C:\\tools\\code.CMD', viaCmd: true });

    const exe = resolveProgram('code', {
      isWindows: true, env: winEnv,
      existsSync: p => p.toLowerCase() === 'c:\\bin\\code.exe',
    });
    expect(exe).toEqual({ file: 'C:\\bin\\code.EXE', viaCmd: false });
  });

  it('带路径的按路径找，找不到明确报错；裸名找不到时原样交还系统兜底', () => {
    const none = (): boolean => false;
    expect(resolveProgram('C:\\tools\\code.cmd', { isWindows: true, env: winEnv, existsSync: none })).toEqual({
      error: '命令路径不存在：C:\\tools\\code.cmd',
    });
    expect(resolveProgram('code', { isWindows: true, env: winEnv, existsSync: none })).toEqual({
      file: 'code', viaCmd: false,
    });
    // 非 Windows 原样返回
    expect(resolveProgram('/usr/bin/code', { isWindows: false, env: {}, existsSync: none })).toEqual({
      file: '/usr/bin/code', viaCmd: false,
    });
  });
});

describe('cmdBridgeArgs', () => {
  it('整条命令外加一层引号，每个参数独立双引号，内嵌引号加倍', () => {
    expect(cmdBridgeArgs('C:\\tools\\code.cmd', ['-g', 'D:\\x\\a b.txt:12'])).toEqual(
      ['/d', '/s', '/c', '"C:\\tools\\code.cmd" "-g" "D:\\x\\a b.txt:12"'],
    );
    expect(cmdBridgeArgs('C:\\t\\x.cmd', ['he said "hi"'])).toEqual(
      ['/d', '/s', '/c', '"C:\\t\\x.cmd" "he said ""hi"""'],
    );
  });
});

describe('launchEditorVars', () => {
  const vars = { file: 'D:\\proj\\a b.txt', line: 12 };

  it('命令为空或缺 {file} 占位符时给出可读错误', async () => {
    expect(await launchEditorVars('', vars)).toContain('外部编辑器命令不可用：命令为空');
    expect(await launchEditorVars('code {line}', vars)).toContain('{file}');
  });

  it('可执行文件直接 spawn（shell:false），启动成功返回空串', async () => {
    const fake = fakeSpawn(child => child.emit('spawn'));
    const deps: LaunchDeps = {
      isWindows: true,
      env: { PATH: 'C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      existsSync: p => p.toLowerCase() === 'c:\\bin\\code.exe',
      spawnImpl: fake.impl,
      settleMs: 500,
    };
    expect(await launchEditorVars('code -g {file}:{line}', vars, deps)).toBe('');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].file.toLowerCase()).toBe('c:\\bin\\code.exe');
    expect(fake.calls[0].args).toEqual(['-g', 'D:\\proj\\a b.txt:12']);
    expect(fake.calls[0].opts).toMatchObject({ shell: false, detached: true, stdio: 'ignore', windowsHide: true });
  });

  it('cmd 脚本经 cmd.exe 代跑并整体加引号', async () => {
    const fake = fakeSpawn(child => child.emit('spawn'));
    const deps: LaunchDeps = {
      isWindows: true,
      env: { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      existsSync: p => p.toLowerCase() === 'c:\\tools\\code.cmd',
      spawnImpl: fake.impl,
      settleMs: 500,
    };
    expect(await launchEditorVars('code -g {file}:{line}', vars, deps)).toBe('');
    expect(fake.calls[0].file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(fake.calls[0].args).toEqual(['/d', '/s', '/c', '"C:\\tools\\code.CMD" "-g" "D:\\proj\\a b.txt:12"']);
    expect(fake.calls[0].opts).toMatchObject({ shell: false, windowsVerbatimArguments: true });
  });

  it('启动失败把错误转成界面提示：找不到命令与无权限', async () => {
    const notFound = fakeSpawn(child => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
    const deps: LaunchDeps = {
      isWindows: true, env: { PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      existsSync: () => false, spawnImpl: notFound.impl, settleMs: 500,
    };
    const err = await launchEditorVars('code {file}', vars, deps);
    expect(err).toContain('找不到命令：code');
    expect(err).toContain('外部编辑器命令');

    const denied = fakeSpawn(child => child.emit('error', Object.assign(new Error('nope'), { code: 'EACCES' })));
    const deps2: LaunchDeps = {
      isWindows: true, env: { PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      existsSync: () => true, spawnImpl: denied.impl, settleMs: 500,
    };
    // 带扩展名的裸名命中「existsSync 恒真」时按可执行文件直接 spawn
    expect(await launchEditorVars('code.exe {file}', vars, deps2)).toBe('没有权限启动：code.exe');
  });

  it('既不成功也不报错时按设置的上限放行，不一直等下去', async () => {
    const silent = fakeSpawn(() => undefined);
    const deps: LaunchDeps = {
      isWindows: false, env: {},
      existsSync: () => true, spawnImpl: silent.impl, settleMs: 30,
    };
    expect(await launchEditorVars('code {file}', vars, deps)).toBe('');
  });
});
