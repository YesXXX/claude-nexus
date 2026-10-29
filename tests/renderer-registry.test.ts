import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/shared/types';
import type { AppContext } from '../src/renderer/core/context';
import { state } from '../src/renderer/core/state';
import { installBuiltinHotkeys } from '../src/renderer/builtin/hotkeys';
import type { CommandContext, CommandProvider, HotkeyContext, HotkeySpec, PaletteItem } from '../src/renderer/core/registry';
import {
  collectCommandItems, commandProviders, detailTab, detailTabKey, detailTabs, findHotkey, findOpener, hotkeyHelpRows, hotkeysOf,
  inspectorSections, paneActions, paneMenuItems, refreshCommandProviders, registerCommands, registerDetailTab, registerHotkey,
  registerInspectorSection, registerOpener, registerPaneAction, registerPaneMenuItem, registerStatusBadge, registerTermCover, registry, renderEach, statusBadges,
  termCovers,
} from '../src/renderer/core/registry';
import { combo, formatCombo, matchCombo, normalizeCombo, normalizeKeys } from '../src/renderer/core/keys';

/** 注册表是模块级单例：每个用例注册的项在结束后统一注销，互不影响 */
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const ctx: CommandContext = { session: undefined, subagent: undefined, paneTab: 'term' };

function item(title: string): PaletteItem {
  return { section: '命令', icon: '', title, run: () => undefined };
}

function provider(id: string, order: number, titles: string[], extra: Partial<CommandProvider> = {}): CommandProvider {
  return { id, order, items: () => titles.map(item), ...extra };
}

function add(p: CommandProvider): () => void {
  const off = registerCommands(p);
  cleanups.push(off);
  return off;
}

describe('命令注册表', () => {
  it('按 order 排序，order 相同按注册先后', () => {
    add(provider('t.c', 500, ['c']));
    add(provider('t.a', 10, ['a1', 'a2']));
    add(provider('t.b', 500, ['b']));
    expect(commandProviders().map(p => p.id)).toEqual(['t.a', 't.c', 't.b']);
    expect(collectCommandItems(ctx).map(i => i.title)).toEqual(['a1', 'a2', 'c', 'b']);
  });

  it('重复 id 注册时抛错，注销后可以重新注册', () => {
    const off = add(provider('t.dup', 0, []));
    expect(() => registerCommands(provider('t.dup', 1, []))).toThrow(/重复注册/);
    off();
    expect(commandProviders().some(p => p.id === 't.dup')).toBe(false);
    add(provider('t.dup', 1, []));
    expect(commandProviders().find(p => p.id === 't.dup')?.order).toBe(1);
  });

  it('id 必须是「功能.名称」形式', () => {
    expect(() => registerCommands(provider('nodot', 0, []))).toThrow(/不合规/);
    expect(() => registerCommands(provider('Core.X', 0, []))).toThrow(/不合规/);
    expect(commandProviders()).toEqual([]);
  });

  it('注销函数只移除自己注册的那一项', () => {
    const off = add(provider('t.x', 0, ['first']));
    off();
    add(provider('t.x', 0, ['second']));
    off();   // 旧的注销函数不能把后来同名注册的项删掉
    expect(collectCommandItems(ctx).map(i => i.title)).toEqual(['second']);
  });

  it('条目按上下文生成', () => {
    add({ id: 't.ctx', order: 0, items: c => (c.paneTab === 'changes' ? [item('返回终端')] : [item('查看改动')]) });
    expect(collectCommandItems(ctx).map(i => i.title)).toEqual(['查看改动']);
    expect(collectCommandItems({ ...ctx, paneTab: 'changes' }).map(i => i.title)).toEqual(['返回终端']);
  });
});

describe('命令缓存刷新', () => {
  it('没有 provider 带 refresh 时返回 false', async () => {
    add(provider('t.plain', 0, ['x']));
    await expect(refreshCommandProviders()).resolves.toBe(false);
  });

  it('并行调用，任一返回 true 即为 true，失败与同步抛错都被忽略', async () => {
    const called: string[] = [];
    add(provider('t.fail', 0, [], { refresh: () => { called.push('fail'); return Promise.reject(new Error('ipc')); } }));
    add(provider('t.throw', 1, [], { refresh: () => { called.push('throw'); throw new Error('sync'); } }));
    add(provider('t.same', 2, [], { refresh: async () => { called.push('same'); return false; } }));
    add(provider('t.changed', 3, [], { refresh: async () => { called.push('changed'); return true; } }));
    await expect(refreshCommandProviders()).resolves.toBe(true);
    expect(called).toEqual(['fail', 'throw', 'same', 'changed']);
  });

  it('全部无变化时返回 false', async () => {
    add(provider('t.same', 0, [], { refresh: async () => false }));
    add(provider('t.fail', 1, [], { refresh: () => Promise.reject(new Error('x')) }));
    await expect(refreshCommandProviders()).resolves.toBe(false);
  });
});

// ================= 热键 =================

function key(k: string, mods: Partial<KeyboardEvent> = {}, code?: string): KeyboardEvent {
  const calls: string[] = [];
  return {
    key: k, code: code ?? (/^\d$/.test(k) ? `Digit${k}` : /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k),
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false, repeat: false,
    preventDefault: () => { calls.push('prevent'); }, stopPropagation: () => { calls.push('stop'); },
    calls, ...mods,
  } as unknown as KeyboardEvent;
}

const hkCtx = (over: Partial<HotkeyContext> = {}): HotkeyContext => ({
  target: null, inInput: false, inTerminal: false, inChanges: false, session: undefined, ...over,
});

describe('按键组合', () => {
  it('规范化：修饰键顺序固定，⇧ 等同 Shift，主键大写', () => {
    expect(normalizeCombo('shift+ctrl+d')).toBe('Ctrl+Shift+D');
    expect(normalizeCombo('Ctrl ⇧ D')).toBe('Ctrl+Shift+D');
    expect(normalizeCombo('escape')).toBe('Esc');
    expect(formatCombo('Ctrl+Shift+D')).toBe('Ctrl ⇧ D');
    expect(normalizeKeys('ctrl ⇧ k')).toBe(normalizeKeys('Ctrl Shift K'));
    expect(normalizeKeys('Ctrl K')).not.toBe(normalizeKeys('Ctrl ⇧ K'));
  });

  it('事件匹配要求修饰键完全一致，数字键按物理键位', () => {
    expect(combo(key('D', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+D');
    expect(matchCombo(key('d', { ctrlKey: true, shiftKey: true }), 'Ctrl ⇧ D')).toBe(true);
    expect(matchCombo(key('d', { ctrlKey: true }), 'Ctrl ⇧ D')).toBe(false);
    expect(matchCombo(key('!', { ctrlKey: true, shiftKey: true }, 'Digit1'), 'Ctrl+Shift+1')).toBe(true);
    expect(matchCombo(key('Escape'), 'Esc')).toBe(true);
  });
});

describe('热键注册表', () => {
  const spec = (id: string, phase: HotkeySpec['phase'], order: number, keys: string, extra: Partial<HotkeySpec> = {}): HotkeySpec => ({
    id, keys, label: id, phase, order, match: () => false, run: () => undefined, ...extra,
  });
  function addHk(s: HotkeySpec): void { cleanups.push(registerHotkey(s)); }

  it('同一阶段内按键规范化后重复时抛错，不同阶段允许', () => {
    addHk(spec('t.a', 'always', 0, 'Ctrl ⇧ X'));
    expect(() => registerHotkey(spec('t.b', 'always', 1, 'ctrl shift x'))).toThrow(/相同按键/);
    addHk(spec('t.c', 'outside-input', 0, 'Ctrl Shift X'));
  });

  it('按阶段与 order 匹配，第一个命中的胜出', () => {
    const hit: string[] = [];
    addHk(spec('t.late', 'always', 20, 'F2', { match: () => true, run: () => hit.push('late') }));
    addHk(spec('t.early', 'always', 10, 'F1', { match: () => true, run: () => hit.push('early') }));
    expect(findHotkey('always', key('x'), hkCtx())?.id).toBe('t.early');
    expect(findHotkey('outside-input', key('x'), hkCtx())).toBeUndefined();
  });

  it('快捷键区按 helpOrder 排列，help 为 false 的不展示', () => {
    addHk(spec('t.one', 'always', 0, 'F1', { label: '一', helpOrder: 20 }));
    addHk(spec('t.two', 'always', 5, 'F2', { label: '二', helpOrder: 10 }));
    addHk(spec('t.hidden', 'always', 1, 'F3', { label: '隐', help: false }));
    expect(hotkeyHelpRows()).toEqual([['二', 'F2'], ['一', 'F1']]);
  });
});

describe('内置热键', () => {
  const acts: string[] = [];
  const fakeCtx = {
    registry: {
      ...registry,
      registerHotkey: (s: HotkeySpec) => { const off = registerHotkey(s); cleanups.push(off); return off; },
    },
    actions: new Proxy({}, { get: (_t, name) => (...args: unknown[]) => { acts.push(`${String(name)}(${args.join(',')})`); } }),
  } as unknown as AppContext;
  const first = (phase: HotkeySpec['phase'], e: KeyboardEvent, over: Partial<HotkeyContext> = {}) =>
    findHotkey(phase, e, hkCtx(over))?.id;
  const waiting = { id: 's1', label: 'x', readOnly: false, status: 'waiting_permission', pendingAction: { toolName: 'Bash' } } as unknown as Session;

  beforeEach(() => {
    acts.length = 0;
    installBuiltinHotkeys(fakeCtx);
  });
  afterEach(() => {
    state.selectedId = null; state.selectedSubagent = null; state.paneTab = 'term'; state.sessions = [];
  });

  it('匹配顺序与原分发器的判断顺序一致', () => {
    expect(hotkeysOf('always').map(h => h.id)).toEqual([
      'core.toggle-changes', 'core.palette', 'core.palette-in-terminal', 'core.new-session', 'core.jump-to-index', 'core.focus-urgent',
    ]);
    expect(hotkeysOf('outside-input').map(h => h.id)).toEqual(['core.approve', 'core.step-session', 'core.escape']);
  });

  it('快捷键区内容与顺序保持不变', () => {
    expect(hotkeyHelpRows()).toEqual([
      ['新建会话', 'Ctrl N'], ['命令面板', 'Ctrl K'], ['命令面板（终端内）', 'Ctrl ⇧ K'], ['切换会话', 'Ctrl 1~9'],
      ['上下切换', 'J K'], ['审批', 'Y N A'], ['聚焦待处理', 'Alt ⇧ C'], ['返回父会话', 'Esc'], ['终端 / 改动', 'Ctrl ⇧ D'],
    ]);
  });

  it('终端内 Ctrl+K 让给终端，Ctrl+Shift+K 打开命令面板；Ctrl+N 同理', () => {
    expect(first('always', key('k', { ctrlKey: true }), { inTerminal: true })).toBeUndefined();
    expect(first('always', key('k', { ctrlKey: true }))).toBe('core.palette');
    expect(first('always', key('K', { ctrlKey: true, shiftKey: true }), { inTerminal: true })).toBe('core.palette-in-terminal');
    expect(first('always', key('n', { ctrlKey: true }), { inTerminal: true })).toBeUndefined();
    expect(first('always', key('n', { ctrlKey: true }))).toBe('core.new-session');
    expect(first('always', key('D', { ctrlKey: true, shiftKey: true }))).toBe('core.toggle-changes');
  });

  it('Alt+Shift+C 只用于展示，不参与匹配', () => {
    expect(first('always', key('C', { altKey: true, shiftKey: true }))).toBeUndefined();
  });

  it('Ctrl+数字只在对应序号有会话时命中', () => {
    expect(first('always', key('1', { ctrlKey: true }))).toBeUndefined();
    state.sessions = [{ ...waiting, status: 'running' } as Session];
    expect(first('always', key('1', { ctrlKey: true }))).toBe('core.jump-to-index');
    expect(first('always', key('2', { ctrlKey: true }))).toBeUndefined();
  });

  it('Y/N/A 只对等待权限的会话生效，组字与自动重复不触发', () => {
    expect(first('outside-input', key('y'))).toBeUndefined();
    expect(first('outside-input', key('y'), { session: waiting })).toBe('core.approve');
    expect(first('outside-input', key('y', { isComposing: true }), { session: waiting })).toBeUndefined();
    expect(first('outside-input', key('a', { repeat: true }), { session: waiting })).toBeUndefined();
    expect(first('outside-input', key('n', { ctrlKey: true }), { session: waiting })).toBeUndefined();
    const e = key('A');
    findHotkey('outside-input', e, hkCtx({ session: waiting }))!.run(e, hkCtx({ session: waiting }));
    expect(acts).toEqual(['approve(s1,always)']);
  });

  it('J/K 在终端内和改动列表内不拦截', () => {
    expect(first('outside-input', key('j'))).toBe('core.step-session');
    expect(first('outside-input', key('k'), { inTerminal: true })).toBeUndefined();
    expect(first('outside-input', key('j'), { inChanges: true })).toBeUndefined();
  });

  it('Esc：子代理视图回父会话，改动标签回终端，其余不拦截', () => {
    expect(first('outside-input', key('Escape'))).toBeUndefined();
    state.selectedSubagent = { sessionId: 's1', agentId: 'a1' };
    const e = key('Escape');
    findHotkey('outside-input', e, hkCtx())!.run(e, hkCtx());
    state.selectedSubagent = null;
    state.selectedId = 's1'; state.paneTab = 'changes';
    findHotkey('outside-input', e, hkCtx())!.run(e, hkCtx());
    expect(acts).toEqual(['selectSession(s1)', 'setPaneTab(term)']);
  });
});

// ================= 行指标 / 详情标签 / 属性面板分区 / 页头操作 =================

describe('界面扩展点注册表', () => {
  const s = { id: 's1' } as unknown as Session;
  const fakeEl = (text: string) => ({ text }) as unknown as HTMLElement;

  it('行指标按 order 排列，返回 null 的不显示，单项抛错不影响其余项', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cleanups.push(registerStatusBadge({ id: 't.b', order: 20, render: () => fakeEl('b') }));
    cleanups.push(registerStatusBadge({ id: 't.a', order: 10, render: () => fakeEl('a') }));
    cleanups.push(registerStatusBadge({ id: 't.none', order: 15, render: () => null }));
    cleanups.push(registerStatusBadge({ id: 't.bad', order: 12, render: () => { throw new Error('boom'); } }));
    const out = renderEach(statusBadges(), s, (m, x) => m.render(x)) as unknown as Array<{ text: string }>;
    expect(out.map(o => o.text)).toEqual(['a', 'b']);
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('详情标签按 id 最后一段作为标签名，名称部分重复时抛错', () => {
    cleanups.push(registerDetailTab({ id: 't.term', title: '终端', order: 0 }));
    cleanups.push(registerDetailTab({ id: 'usage.panel', title: '用量', order: 500 }));
    expect(detailTabs().map(detailTabKey)).toEqual(['term', 'panel']);
    expect(detailTab('panel')?.title).toBe('用量');
    expect(detailTab('usage.panel')).toBeUndefined();
    expect(() => registerDetailTab({ id: 'other.panel', title: 'x', order: 600 })).toThrow(/名称部分重复/);
  });

  it('属性面板分区、页头操作与页头菜单项按 order 排列', () => {
    cleanups.push(registerInspectorSection({ id: 't.late', order: 600, render: () => null }));
    cleanups.push(registerInspectorSection({ id: 't.early', order: 5, render: () => null }));
    cleanups.push(registerPaneAction({ id: 't.y', order: 9, render: () => null }));
    cleanups.push(registerPaneAction({ id: 't.x', order: 1, render: () => null }));
    cleanups.push(registerPaneMenuItem({ id: 't.end', order: 900, item: () => null }));
    cleanups.push(registerPaneMenuItem({ id: 't.copy', order: 300, item: () => null }));
    expect(inspectorSections().map(x => x.id)).toEqual(['t.early', 't.late']);
    expect(paneActions().map(x => x.id)).toEqual(['t.x', 't.y']);
    expect(paneMenuItems().map(x => x.id)).toEqual(['t.copy', 't.end']);
  });

  it('终端替代内容按 order 排列，可注销', () => {
    const off = registerTermCover({ id: 't.cover-b', order: 20, render: () => null });
    cleanups.push(registerTermCover({ id: 't.cover-a', order: 10, render: () => null }));
    expect(termCovers().map(x => x.id)).toEqual(['t.cover-a', 't.cover-b']);
    off();
    expect(termCovers().map(x => x.id)).toEqual(['t.cover-a']);
  });

  it('打开入口按 id 查找，注销后找不到', () => {
    const open = vi.fn();
    const off = registerOpener({ id: 't.panel', order: 0, open });
    findOpener('t.panel')?.open();
    expect(open).toHaveBeenCalledTimes(1);
    expect(findOpener('t.none')).toBeUndefined();
    off();
    expect(findOpener('t.panel')).toBeUndefined();
  });

  it('命令面板条目按分组排序，组内保持注册顺序', () => {
    add({ id: 't.h', order: 0, items: () => [{ section: '历史', icon: '', title: 'h1', run: () => undefined }] });
    add({ id: 't.s', order: 1, items: () => [{ section: '会话', icon: '', title: 's1', run: () => undefined }] });
    add(provider('t.c', 2, ['c1', 'c2']));
    expect(collectCommandItems(ctx).map(i => i.title)).toEqual(['c1', 'c2', 's1', 'h1']);
  });

  it('registry 汇总了全部注册入口', () => {
    expect(Object.keys(registry).sort()).toEqual([
      'registerChangesExtension', 'registerCommands', 'registerDetailTab', 'registerHotkey', 'registerInspectorSection', 'registerOpener', 'registerPaneAction',
      'registerPaneMenuItem', 'registerSettingsSection', 'registerStatusBadge', 'registerTermCover',
    ]);
  });
});
