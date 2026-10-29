import type { Session } from '../../shared/types';
import { api } from '../core/api.js';
import { byId } from '../core/dom.js';
import { dbg, short } from '../core/debug.js';
import { isMultiPane } from '../core/panes.js';
import { findSession, state } from '../core/state.js';
import type { TerminalEntry } from './host.js';
import { claimHost, subagentTermMap, swapHostTerm, termMap, termTheme } from './host.js';
import { requestHostFit } from './pane-fit.js';

/**
 * 父会话终端：xterm.js 完整还原 Claude TUI（清屏、光标、颜色）。
 * 负责创建、换入宿主、尺寸适配、输入转发、输入法锚点与聚焦。
 */
// xterm / FitAddon 由 index.html 中的 wrapper script 挂到 window.Terminal / FitAddon
declare const Terminal: any;
declare const FitAddon: any;

/**
 * 在宿主（单窗格的 #terminal-host 或某个窗格的宿主）中创建/挂载会话终端。
 * 每个会话一个实例，切换宿主 = 移动 xterm 元素。
 */
export function ensureTerm(id: string, host: HTMLElement, initial: string, readOnly = false): TerminalEntry {
  let entry = termMap.get(id);
  if (entry) {
    swapHostTerm(host, id, false);
    return entry;
  }
  const term = new Terminal({
    fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace',
    fontSize: 13,
    cols: 120, rows: 30,             // 与 pty-factory 的初始尺寸保持一致
    theme: termTheme(),
    cursorBlink: false, scrollback: 5000,
    // 搜索插件的匹配高亮用到 registerDecoration，属于 proposed API
    allowProposedApi: true,
    // 注意：不能开 convertEol —— PTY 直通场景下换行已由 PTY（ONLCR）处理，
    // 再补 \r 会破坏 TUI 的光标列语义，导致滚动历史里左侧文字错位换行
    disableStdin: readOnly,         // 只读实例（子代理视图）彻底禁输入；父会话下面手动 onData 接管
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  if (!readOnly) term.onData((data: string) => { void api().input(id, data); });
  entry = { term, fit, lastSent: `${term.cols}x${term.rows}`, readOnly };
  // xterm 尺寸变化 → 同步给 PTY（让 TUI 重新布局）；只读会话无 PTY，跳过。
  // 必须在 fit() 之前注册：fit 触发的首次尺寸变化（120x30 → 宿主实际尺寸）
  // 也要送达 PTY，否则 PTY 停在初始 30 行，Claude 会把输入框画在可视区中间。
  term.onResize(() => {
    if (readOnly) return;
    const s = findSession(id);
    if (!s || s.readOnly) return;
    const size = `${term.cols}x${term.rows}`;
    if (size !== entry!.lastSent) {
      dbg('term', `会话 ${short(id)} 尺寸 → ${size}，同步给 PTY`);
      entry!.lastSent = size;
    }
    void api().resize(id, term.cols, term.rows);
  });
  fit.fit();
  if (initial) term.write(initial);
  if (!readOnly) pinImeAnchorToInputArea(term);
  termMap.set(id, entry);
  return entry;
}

/**
 * IME 锚点修复：Claude TUI 画完界面后把真实终端光标藏起并停在原点，
 * xterm 的隐藏 textarea（IME 锚点）与组字浮层都锚在真实光标处 → 中文组字
 * 预览/候选窗飘到终端左上角。组字与聚焦期间把 textarea 挪到视口底部
 * （TUI 自绘输入框所在区域），浮层与系统候选窗都会跟随它。
 */
function pinImeAnchorToInputArea(term: any): void {
  const textarea = term.textarea as HTMLTextAreaElement | null;
  if (!textarea) return;
  const pin = (): void => {
    const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen) return;
    textarea.style.left = '10px';
    textarea.style.top = `${Math.max(0, screen.clientHeight - 40)}px`;
  };
  // 只在聚焦/组字开始时定位一次；逐键重设会与 xterm 每次渲染的内联定位拉锯，
  // 组字预览因此闪烁——预览浮层改由 CSS 钉死（见 renderer.css）
  textarea.addEventListener('focus', pin);
  textarea.addEventListener('compositionstart', pin);
}

/** 拉取全量输出、尚未建好的会话：同一会话只发一次请求 */
const creating = new Set<string>();

function focusIfPending(id: string, entry: TerminalEntry): void {
  if (state.pendingFocusId !== id) return;
  entry.term.focus();
  state.pendingFocusId = null;
}

/** 宿主 0×0 时等它有尺寸再 fit：fit 会把 xterm 内联 style 写成 0×0，之后不再自动重测 */
function fitWhenSized(id: string, host: HTMLElement, e: TerminalEntry): void {
  const r = host.getBoundingClientRect();
  if (r.width >= 1 && r.height >= 1) {
    try { e.fit.fit(); } catch (err) { dbg('term', `会话 ${short(id)} fit 异常：${err}`); }
    return;
  }
  const ro = new ResizeObserver(() => {
    const rr = host.getBoundingClientRect();
    if (rr.width < 1 || rr.height < 1) return;
    ro.disconnect();
    try { e.fit.fit(); } catch (err) { dbg('term', `会话 ${short(id)} fit 异常：${err}`); }
  });
  ro.observe(host);
  setTimeout(() => ro.disconnect(), 5000);
}

/**
 * 把会话终端挂到指定宿主：已有实例 → 换入宿主；没有 → 拉全量输出后创建。
 * stillWanted 在异步拉取回来后复核宿主是否仍要显示该会话；
 * fitMode 为 direct 时直接 fit（单窗格宿主），observer 时交给窗格的合并 fit。
 */
export function mountTerminalIn(
  s: Session, host: HTMLElement, stillWanted: () => boolean, fitMode: 'direct' | 'observer',
): void {
  const entry = termMap.get(s.id);
  if (entry) {
    // 元素已在宿主中时跳过 fit：render() 随会话推送每秒执行，
    // 无谓的 fit→resize→PTY/TUI 重绘会让 IME 组字浮层反复重定位（窗口抖动、飘字）
    const wasAttached = entry.term.element?.parentElement === host;
    swapHostTerm(host, s.id, false);
    if (entry.term.element?.parentElement !== host) return;
    if (!wasAttached) {
      if (fitMode === 'direct') entry.fit.fit();
      else requestHostFit(host, true);
    }
    focusIfPending(s.id, entry);
    return;
  }
  if (creating.has(s.id)) return;
  creating.add(s.id);
  void api().output(s.id).then(initial => {
    creating.delete(s.id);
    // 拉取期间用户可能已切换到别的会话或改动标签；未创建的终端留到切回时再建
    if (!stillWanted()) return;
    const e = ensureTerm(s.id, host, initial);
    swapHostTerm(host, s.id, false);
    if (fitMode === 'direct') fitWhenSized(s.id, host, e);
    else requestHostFit(host, true);
    focusIfPending(s.id, e);
  }, err => {
    creating.delete(s.id);
    dbg('term', `会话 ${short(s.id)} 拉取输出失败：${err}`);
  });
}

// 单窗格终端挂载：稳定宿主 #terminal-host 归属选中会话
export function mountTerminal(s: Session): void {
  const host = byId('terminal-host');
  claimHost(host, s.id);
  mountTerminalIn(s, host, () =>
    state.selectedId === s.id && !state.selectedSubagent && state.paneTab === 'term' && !isMultiPane(), 'direct');
}

const chunkCount = new Map<string, number>();

/** 主进程推送的会话输出：只写入已创建的终端 */
export function writeOutput(id: string, chunk: string): void {
  const n = (chunkCount.get(id) ?? 0) + 1;
  chunkCount.set(id, n);
  const entry = termMap.get(id);
  if (!entry) {
    // 未选中的会话输出不创建终端（静默丢弃，等待选中时通过 output() 全量回放）
    return;
  }
  if (n <= 5) {
    dbg('term', `会话 ${short(id)} chunk#${n} len=${chunk.length} 内容=${JSON.stringify(chunk).slice(0, 160)}`);
  } else if (n % 100 === 0) {
    dbg('term', `会话 ${short(id)} 已接收 ${n} 块输出`);
  }
  entry.term.write(chunk);
}

/** 窗口或宿主尺寸变化：只 fit 当前选中的终端 */
export function fitVisible(host: HTMLElement | null, subHost: HTMLElement | null): void {
  if (!state.selectedId) return;
  if (state.selectedSubagent && state.selectedSubagent.sessionId === state.selectedId) {
    const key = state.selectedId + '\0' + state.selectedSubagent.agentId;
    const e = subagentTermMap.get(key);
    if (e && e.term.element && e.term.element.parentElement === subHost) e.fit.fit();
    return;
  }
  const e = termMap.get(state.selectedId);
  if (!e || !e.term.element || e.term.element.parentElement !== host) return;
  // 改动标签下终端卡片隐藏、宿主为 0×0，此时 fit 会把 PTY 缩到最小，必须跳过
  const r = host!.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return;
  e.fit.fit();
}

let paneFocusHandler: ((id: string) => boolean) | null = null;

/** 注入非终端标签的聚焦逻辑：返回 true 表示焦点已交给该标签，不再聚焦终端 */
export function setPaneFocusHandler(fn: (id: string) => boolean): void {
  paneFocusHandler = fn;
}

/** 全局热键、通知点击后的聚焦：终端内直接输入 */
export function focusSessionInput(id: string): void {
  // 当前标签不是终端时（如改动标签），焦点交给该标签的内容
  if (paneFocusHandler?.(id)) return;
  const entry = termMap.get(id);
  if (entry) {
    entry.term.focus();
    dbg('term', `会话 ${short(id)} 终端已聚焦`);
    return;
  }
  // 终端尚未创建（异步挂载中）：交给 state.pendingFocusId 在挂载完成后聚焦
  state.pendingFocusId = id;
}
