import type { HotkeyContext, HotkeyPhase } from '../core/registry.js';
import { findHotkey } from '../core/registry.js';
import { selectedSession } from '../core/state.js';

/** 按键发生时的焦点上下文 */
export function hotkeyContext(e: KeyboardEvent): HotkeyContext {
  const t = e.target as HTMLElement | null;
  const inTerminal = !!t && t.classList.contains('xterm-helper-textarea');
  return {
    target: t,
    // xterm 的隐藏输入区虽是 textarea 但不算输入控件，否则终端聚焦时 Y/N/A 审批、Ctrl+K 等快捷键永不触发；
    // 其余 textarea（如批注意见）照常算输入控件，打字时不触发单键热键
    inInput: !!t && (t.tagName === 'INPUT' || t.isContentEditable || (t.tagName === 'TEXTAREA' && !inTerminal)),
    inTerminal,
    // 改动文件列表自己处理 J/K 与方向键
    inChanges: !!t && !!t.closest('#changes-host'),
    session: selectedSession(),
  };
}

function tryPhase(phase: HotkeyPhase, e: KeyboardEvent, ctx: HotkeyContext): boolean {
  const hk = findHotkey(phase, e, ctx);
  if (!hk) return false;
  hk.run(e, ctx);
  return true;
}

/**
 * 全局热键分发：唯一的 window 级 capture 阶段 keydown 监听（先于 xterm textarea）。
 * 顺序：任一模态打开时直接返回 → always 阶段 → 焦点在输入框则返回 → outside-input 阶段；
 * 每个阶段按注册表 order 匹配，第一个命中的执行后停止。
 */
export function bindHotkeys(): void {
  window.addEventListener('keydown', e => {
    // 任一模态（命令面板 / 更新设置 / 更新弹窗 / 确认框）打开时不响应全局热键（含焦点落在模态按钮上的场景）
    if (document.querySelector('.modal-backdrop:not([hidden])')) return;
    const ctx = hotkeyContext(e);
    if (tryPhase('always', e, ctx)) return;
    if (ctx.inInput) return;
    tryPhase('outside-input', e, ctx);
  }, true);
}
