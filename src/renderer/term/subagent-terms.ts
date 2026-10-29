import type { Session, SubagentEntry } from '../../shared/types';
import { unseenPart } from '../../shared/subagent-log.js';
import { api } from '../core/api.js';
import { byId } from '../core/dom.js';
import { dbg, short } from '../core/debug.js';
import { state } from '../core/state.js';
import type { TerminalEntry } from './host.js';
import { subagentTermMap, swapHostTerm, termTheme } from './host.js';

/**
 * 子代理只读终端：回放缓冲、增量写入与加载队列。
 * xterm / FitAddon 由 index.html 中的 wrapper script 挂到 window，只能在函数内读取。
 */
declare const Terminal: any;
declare const FitAddon: any;

/** 回放请求在途的子代理：期间到达的实时增量先排队，回放写入后再按偏移去重补写 */
const subagentLoading = new Map<string, Array<{ chunk: string; end: number }>>();

export function writeSubagentChunk(entry: TerminalEntry, chunk: string, end: number): void {
  const part = unseenPart(chunk, end, entry.received ?? 0);
  if (part) entry.term.write(part);
  if (end > (entry.received ?? 0)) entry.received = end;
}

/** 子代理增量：已建实例按偏移写入；回放请求在途则排队，未建实例且无请求的直接丢弃 */
export function writeSubagentOutput(sessionId: string, agentId: string, chunk: string, end: number): void {
  const key = sessionId + '\0' + agentId;
  const entry = subagentTermMap.get(key);
  if (entry) { writeSubagentChunk(entry, chunk, end); return; }
  subagentLoading.get(key)?.push({ chunk, end });
}

// 子代理终端挂载：先取缓冲回放（已有实例换宿主即可）；无实例 → 拉全量缓冲后懒创建
export function mountSubagentTerminal(s: Session, sub: SubagentEntry): void {
  const host = byId('subagent-terminal-host');
  const key = s.id + '\0' + sub.agentId;
  const entry = subagentTermMap.get(key);
  // 通用 fit 兜底：fit() 在 0×0 宿主上调用会把 xterm 内联 style 写成 0×0，
  // 后续即使用户切走再切回也再不会自动重测；用 ResizeObserver 监听 host 真有尺寸时再 fit
  const safeFit = (term: any, fit: any, label: string): void => {
    const doFit = (w: number, h: number): void => {
      // fit 之前强制清掉旧的内联 style：fit() 是基于当前 inline style 增量计算，
      // 上一轮 0×0 内联 style 会污染新尺寸算出的 cols/rows
      const xel = term.element as HTMLElement | undefined;
      if (xel) { xel.style.width = ''; xel.style.height = ''; }
      try {
        fit.fit();
        // fit 写完后再强制覆盖一遍内联 style：用 host 的实际矩形（含 padding）
        // 而非 fit 算出的 cols*charW，避免 padding box vs content box 算错
        if (xel) {
          xel.style.width = w + 'px';
          xel.style.height = h + 'px';
        }
      } catch (err) { dbg('term', `${label} fit 异常：${err}`); }
    };
    const r0 = host.getBoundingClientRect();
    if (r0.width < 1 || r0.height < 1) {
      const ro = new ResizeObserver(() => {
        const rr = host.getBoundingClientRect();
        if (rr.width < 1 || rr.height < 1) return;
        ro.disconnect();
        doFit(rr.width, rr.height);
      });
      ro.observe(host);
      setTimeout(() => ro.disconnect(), 5000);
      return;
    }
    requestAnimationFrame(() => doFit(r0.width, r0.height));
  };
  if (entry) {
    swapHostTerm(host, key, true);
    safeFit(entry.term, entry.fit, `子代理 ${sub.agentId.slice(0, 8)} 已有`);
    return;
  }
  // render() 随每次会话推送执行：回放请求在途时不重复发起
  if (subagentLoading.has(key)) return;
  subagentLoading.set(key, []);
  void api().subagentLog(s.id, sub.agentId).then(snap => {
    const queued = subagentLoading.get(key) ?? [];
    subagentLoading.delete(key);
    if (state.selectedSubagent?.sessionId !== s.id || state.selectedSubagent.agentId !== sub.agentId) return;
    const e = ensureSubagentTerm(s.id, sub.agentId, host, snap.text, snap.end);
    for (const q of queued) writeSubagentChunk(e, q.chunk, q.end);
    swapHostTerm(host, key, true);
    safeFit(e.term, e.fit, `子代理 ${sub.agentId.slice(0, 8)} 新建`);
  }, () => { subagentLoading.delete(key); });
}

/**
 * 子代理只读 xterm：每 (sessionId, agentId) 懒创建并缓存。disableStdin=true + 不接 onData
 * → 键盘输入永远不落到终端；只通过 term.write() 渲染回放与增量流。
 */
function ensureSubagentTerm(sessionId: string, agentId: string, host: HTMLElement, initial: string, initialEnd: number): TerminalEntry {
  const key = sessionId + '\0' + agentId;
  let entry = subagentTermMap.get(key);
  if (entry) { swapHostTerm(host, key, true); return entry; }
  // 子代理终端独立实例（与父会话共享主题但不挂输入 / onResize）
  const term = new Terminal({
    fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace',
    fontSize: 13,
    cols: 120, rows: 30,
    theme: termTheme(),
    cursorBlink: false, scrollback: 5000,
    // 搜索插件的匹配高亮用到 registerDecoration，属于 proposed API
    allowProposedApi: true,
    disableStdin: true,
    // 内容源是 subagent-log 拼出的纯文本（\n 分行，非 PTY 原始字节），
    // 不补 \r 的话 xterm 只换行不归列，历史越长错位越明显（阶梯状乱码）
    convertEol: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // 永久 ResizeObserver：xterm 元素的 inline style width/height 在某些时序下
  // 被 FitAddon 写成 0×0（首次 fit 时宿主仍 hidden 或 layout 未完成）。
  // 挂永久 RO 把 xterm 元素强制设为 host 的 client 尺寸，确保 canvas 永远有可绘区域。
  const xtermEl = term.element as HTMLElement;
  const stretchXterm = (): void => {
    const r = host.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    if (xtermEl) {
      xtermEl.style.width = r.width + 'px';
      xtermEl.style.height = r.height + 'px';
    }
  };
  stretchXterm();
  const refit = (): void => {
    stretchXterm();
    try { fit.fit(); } catch (err) { dbg('term', `子代理 ${short(agentId)} fit 异常：${err}`); }
  };
  const ro = new ResizeObserver(refit);
  ro.observe(host);
  // 首次 fit 推迟到下一帧：让 host 布局稳定
  requestAnimationFrame(refit);
  if (initial) term.write(initial);
  entry = { term, fit, lastSent: `${term.cols}x${term.rows}`, readOnly: true, ro, received: initialEnd };
  subagentTermMap.set(key, entry);
  return entry;
}

/** 父会话从列表移除时销毁其全部子代理 xterm 实例；防止悬挂引用 + DOM 泄露 */
export function disposeSubagentTermsForSession(sessionId: string): void {
  for (const key of subagentLoading.keys()) {
    if (key.startsWith(sessionId + '\0')) subagentLoading.delete(key);
  }
  for (const [key, e] of subagentTermMap) {
    if (key.startsWith(sessionId + '\0')) {
      e.ro?.disconnect();
      e.term.element?.remove();
      e.term.dispose();
      subagentTermMap.delete(key);
    }
  }
}
