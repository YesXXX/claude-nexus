import { dbg, short } from '../core/debug.js';

/**
 * 父会话与子代理终端共用的宿主管理：实例表、主题与宿主内容切换。
 * 两套终端共享同一宿主元素，切换时必须同时清理对方的元素，所以实例表放在一处。
 */

/** 父子会话共用的终端主题兜底值：与 renderer.css 的 --term-* 变量同源，样式表读不到时使用 */
export const TERM_THEME = {
  background: '#0d0d0d', foreground: '#d8d8d8', cursor: '#ececec',
  selectionBackground: 'rgba(255,255,255,.18)',
  black: '#1a1a1a', red: '#ff6b6b', green: '#6fd39b', yellow: '#f5d76e',
  blue: '#7aa2f7', magenta: '#c792ea', cyan: '#7dcfff', white: '#d8d8d8',
  brightBlack: '#6b6b6b', brightRed: '#ff8a8a', brightGreen: '#8fe3b4',
  brightYellow: '#ffe08a', brightBlue: '#9ab8ff', brightMagenta: '#d7b0f0',
  brightCyan: '#a5e1ff', brightWhite: '#ffffff',
};

/** 主题键名转成 CSS 变量名：brightBlack → --term-bright-black */
function termVar(key: string): string {
  return `--term-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`;
}

/** 按样式表里的 --term-* 变量取终端主题，缺的项用兜底值；换肤后对已打开的终端重新赋值即可换色 */
export function termTheme(): typeof TERM_THEME {
  const cs = getComputedStyle(document.documentElement);
  const out = { ...TERM_THEME };
  for (const k of Object.keys(out) as Array<keyof typeof TERM_THEME>) {
    const v = cs.getPropertyValue(termVar(k)).trim();
    if (v) out[k] = v;
  }
  return out;
}

export interface TerminalEntry {
  term: any; fit: any; lastSent: string; readOnly: boolean;
  ro?: ResizeObserver;   // 子代理实例的常驻尺寸监听，销毁实例时一并断开
  received?: number;     // 子代理实例已写入的累计字符数（与主进程缓冲偏移对齐去重）
}
export const termMap = new Map<string, TerminalEntry>();          // 父会话：key = sessionId
export const subagentTermMap = new Map<string, TerminalEntry>();  // 子代理：  key = sessionId + '\0' + agentId

/** 换肤后给已打开的父会话与子代理终端重新赋主题；xterm 赋值即重绘，不重建实例、不丢缓冲 */
export function applyTermTheme(): void {
  const theme = termTheme();
  for (const entry of [...termMap.values(), ...subagentTermMap.values()]) entry.term.options.theme = theme;
}

/**
 * 宿主归属：父会话终端可能挂在单窗格宿主或某个窗格宿主上，同一会话的 xterm 元素只能在一处。
 * 宿主用 data-owner 声明当前归属的会话；元素所在的旧宿主仍在文档中且仍归属该会话时不迁移，
 * 避免同一轮渲染里两处都声明同一会话时元素来回搬动。
 */
export function claimHost(host: HTMLElement, id: string): void {
  if (host.dataset.owner !== id) host.dataset.owner = id;
}

export function releaseHost(host: HTMLElement): void {
  delete host.dataset.owner;
}

/** 让选中会话的 xterm 元素成为宿主唯一内容：先移除其他会话的元素，再挂载目标。
 *  （父子两套终端共享宿主，不清理旧元素会导致切换会话时新旧终端堆叠） */
export function swapHostTerm(host: HTMLElement, id: string, isSubagent: boolean): void {
  const targetMap = isSubagent ? subagentTermMap : termMap;
  const siblingMap = isSubagent ? termMap : subagentTermMap;
  for (const [, e] of siblingMap) {
    if (e.term.element && e.term.element.parentElement === host) e.term.element.remove();
  }
  for (const [otherId, e] of targetMap) {
    if (otherId !== id && e.term.element && e.term.element.parentElement === host) e.term.element.remove();
  }
  const entry = targetMap.get(id);
  const elem = entry?.term.element as HTMLElement | undefined;
  if (!elem || elem.parentElement === host) return;
  const cur = elem.parentElement;
  if (!isSubagent && cur && cur.isConnected && cur.dataset.owner === id) {
    dbg('term', `会话 ${short(id)} 的终端仍归另一宿主，跳过迁移`);
    return;
  }
  host.appendChild(elem);
}
