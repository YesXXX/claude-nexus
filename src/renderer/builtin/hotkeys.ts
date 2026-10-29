import { stepSelection } from '../../shared/session-view.js';
import type { AppContext } from '../core/context.js';
import { dbg, short } from '../core/debug.js';
import { detailTab } from '../core/registry.js';
import { reviewFocus, setReviewFocus } from '../core/review-layout.js';
import { state, visibleSessions } from '../core/state.js';

/**
 * 内置热键。order 与原先分发器里的判断顺序一一对应：
 * always 阶段依次为 Ctrl+Shift+D、Ctrl+K、Ctrl+Shift+K、Ctrl+N、Ctrl+1~9；
 * outside-input 阶段依次为 Y/N/A、J/K、Esc。
 * 快捷键区的展示顺序由 helpOrder 决定，与匹配顺序无关。
 * Alt+Shift+C 由主进程 globalShortcut 注册，这里只登记一条展示项（match 恒为 false）。
 */
export function installBuiltinHotkeys(ctx: AppContext): void {
  const { registerHotkey } = ctx.registry;
  const a = ctx.actions;

  // 详情标签切换：终端 ↔ 改动（Claude TUI 不占用该组合）
  registerHotkey({
    id: 'core.toggle-changes', keys: 'Ctrl ⇧ D', label: '终端 / 改动', phase: 'always', order: 0, helpOrder: 90,
    match: e => e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd',
    run: e => {
      e.preventDefault(); e.stopPropagation();
      a.setPaneTab(state.paneTab === 'term' ? 'changes' : 'term');
    },
  });

  // 命令面板：Ctrl+Shift+K 全局可用；Ctrl+K 在终端内让位给 readline 的清行
  registerHotkey({
    id: 'core.palette', keys: 'Ctrl K', label: '命令面板', phase: 'always', order: 10, helpOrder: 20,
    match: (e, c) => e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k' && !c.inTerminal,
    run: e => { e.preventDefault(); e.stopPropagation(); a.openPalette(); },
  });
  registerHotkey({
    id: 'core.palette-in-terminal', keys: 'Ctrl ⇧ K', label: '命令面板（终端内）', phase: 'always', order: 20, helpOrder: 30,
    match: e => e.ctrlKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'k',
    run: e => { e.preventDefault(); e.stopPropagation(); a.openPalette(); },
  });

  registerHotkey({
    id: 'core.new-session', keys: 'Ctrl N', label: '新建会话', phase: 'always', order: 30, helpOrder: 10,
    match: (e, c) => e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n' && !c.inTerminal,
    run: e => { e.preventDefault(); e.stopPropagation(); a.goHome(); },
  });

  // Ctrl+1~9 直达侧栏对应序号的会话（序号以当前过滤下的可见会话为准）
  const digitTarget = (e: KeyboardEvent) => {
    if (!e.ctrlKey || e.altKey || e.shiftKey || !e.code.startsWith('Digit')) return undefined;
    const n = Number(e.code.slice(5));
    return n >= 1 && n <= 9 ? visibleSessions()[n - 1] : undefined;
  };
  registerHotkey({
    id: 'core.jump-to-index', keys: 'Ctrl 1~9', label: '切换会话', phase: 'always', order: 40, helpOrder: 40,
    match: e => digitTarget(e) !== undefined,
    run: e => {
      const target = digitTarget(e)!;
      e.preventDefault(); e.stopPropagation();
      dbg('hotkey', `Ctrl+${e.code.slice(5)} → ${short(target.id)}（${target.label}）`);
      state.pendingFocusId = target.id;
      a.selectSession(target.id);
    },
  });

  registerHotkey({
    id: 'core.focus-urgent', keys: 'Alt ⇧ C', label: '聚焦待处理', phase: 'always', order: 490, helpOrder: 70,
    match: () => false,
    run: () => undefined,
  });

  // 审批：IME 组字中（拼音首键 y/n/a）与按键自动重复不触发，防误批/双发
  registerHotkey({
    id: 'core.approve', keys: 'Y N A', label: '审批', phase: 'outside-input', order: 0, helpOrder: 60,
    match: (e, c) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing || e.repeat) return false;
      const key = e.key.toLowerCase();
      if (key !== 'y' && key !== 'n' && key !== 'a') return false;
      const s = c.session;
      return !!s && !s.readOnly && s.status === 'waiting_permission' && !!s.pendingAction;
    },
    run: (e, c) => {
      const s = c.session!;
      const key = e.key.toLowerCase();
      e.preventDefault(); e.stopPropagation();   // 拦截，避免面板代发 y\n 与 TUI 自身选择双输
      const choice = key === 'y' ? 'yes' : key === 'n' ? 'no' : 'always';
      dbg('approve', `快捷键 ${key.toUpperCase()} → ${choice}（${s.label}）`);
      a.approve(s.id, choice);
    },
  });

  // J/K 上下切换会话（终端内输入字符优先，改动文件列表自己处理 J/K）
  registerHotkey({
    id: 'core.step-session', keys: 'J K', label: '上下切换', phase: 'outside-input', order: 10, helpOrder: 50,
    match: (e, c) => !e.ctrlKey && !e.altKey && !e.metaKey && !c.inTerminal && !c.inChanges
      && (e.key === 'j' || e.key === 'k'),
    run: e => {
      e.preventDefault();
      const ids = visibleSessions().map(s => s.id);
      const nextId = stepSelection(ids, state.selectedId, e.key === 'j' ? 1 : -1);
      if (nextId && nextId !== state.selectedId) {
        state.pendingFocusId = nextId;
        a.selectSession(nextId);
      }
    },
  });

  // 专注审阅中第一次 Esc 只退出专注；子代理视图下 Esc 回父会话；非终端标签（escBack 不为 false）下 Esc 回终端
  const escBackTab = (): boolean => state.paneTab !== 'term' && !!state.selectedId
    && detailTab(state.paneTab)?.escBack !== false;
  registerHotkey({
    id: 'core.escape', keys: 'Esc', label: '返回父会话', phase: 'outside-input', order: 20, helpOrder: 80,
    match: e => e.key === 'Escape' && (reviewFocus() || !!state.selectedSubagent || escBackTab()),
    run: e => {
      e.preventDefault();
      if (reviewFocus()) setReviewFocus(false);
      else if (state.selectedSubagent) a.selectSession(state.selectedSubagent.sessionId);
      else a.setPaneTab('term');
    },
  });
}
