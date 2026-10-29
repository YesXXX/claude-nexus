import type { CellMetrics, GridSize } from '../../shared/pane-geometry.js';
import { DEFAULT_CELL_METRICS } from '../../shared/pane-geometry.js';
import { dbg, short } from '../core/debug.js';
import type { TerminalEntry } from './host.js';
import { termMap } from './host.js';

/**
 * 窗格宿主的尺寸适配：共享一个 ResizeObserver，同一帧内的多次请求合并为一次 fit。
 * 宿主 0×0（隐藏）时绝不 fit，否则 xterm 会被写成 0×0 并把 PTY 缩到最小；
 * 从隐藏恢复可见时补一次 fit 与整屏刷新。分隔条拖动期间挂起，松手后统一 fit。
 */

let ro: ResizeObserver | null = null;
const pending = new Set<HTMLElement>();
const forced = new Set<HTMLElement>();
const lastSize = new WeakMap<HTMLElement, string>();
const wasHidden = new WeakSet<HTMLElement>();
let raf = 0;
let suspended = false;

function observer(): ResizeObserver {
  ro ??= new ResizeObserver(entries => {
    for (const e of entries) requestHostFit(e.target as HTMLElement);
  });
  return ro;
}

export function observePaneHost(host: HTMLElement): void {
  observer().observe(host);
}

export function unobservePaneHost(host: HTMLElement): void {
  ro?.unobserve(host);
  pending.delete(host);
  forced.delete(host);
}

function schedule(): void {
  if (suspended || raf) return;
  raf = requestAnimationFrame(flush);
}

/** 请求在下一帧 fit；force 用于元素刚挂入宿主，尺寸未变也要 fit 一次 */
export function requestHostFit(host: HTMLElement, force = false): void {
  pending.add(host);
  if (force) forced.add(host);
  schedule();
}

/** 挂起期间只积压请求，恢复时对积压的宿主统一 fit 一次 */
export function setFitSuspended(on: boolean): void {
  suspended = on;
  if (!on && pending.size > 0) schedule();
}

function flush(): void {
  raf = 0;
  const hosts = [...pending];
  pending.clear();
  for (const host of hosts) {
    const force = forced.delete(host);
    fitHost(host, force);
  }
}

/** 宿主声明归属的会话且其 xterm 元素确实挂在该宿主上时返回实例 */
function ownedEntry(host: HTMLElement): TerminalEntry | null {
  const id = host.dataset.owner;
  if (!id) return null;
  const entry = termMap.get(id);
  return entry && entry.term.element?.parentElement === host ? entry : null;
}

function fitHost(host: HTMLElement, force: boolean): void {
  const entry = ownedEntry(host);
  if (!entry) return;
  const r = host.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) {
    wasHidden.add(host);
    return;
  }
  const size = `${Math.round(r.width)}x${Math.round(r.height)}`;
  const revived = wasHidden.has(host);
  if (!force && !revived && lastSize.get(host) === size) return;
  wasHidden.delete(host);
  try {
    entry.fit.fit();
  } catch (err) {
    dbg('term', `会话 ${short(host.dataset.owner ?? '')} fit 异常：${err}`);
  }
  if (revived) entry.term.refresh(0, entry.term.rows - 1);
  lastSize.set(host, size);
}

/** 按宿主当前尺寸估算 xterm 能容纳的列行（不改变终端尺寸）；未挂载或宿主隐藏返回 null */
export function measurePaneHost(host: HTMLElement): GridSize | null {
  const entry = ownedEntry(host);
  if (!entry) return null;
  const r = host.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  const d = entry.fit.proposeDimensions?.() as { cols: number; rows: number } | undefined;
  if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return null;
  return { cols: d.cols, rows: d.rows };
}

let charW = 0;
let lineH = 0;
let fontsHooked = false;

function measureCharW(): number {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return DEFAULT_CELL_METRICS.charW;
  ctx.font = '13px "Cascadia Code", "Cascadia Mono", Consolas, monospace';
  const w = ctx.measureText('M'.repeat(100)).width / 100;
  return w > 0 ? w : DEFAULT_CELL_METRICS.charW;
}

/** 终端字体度量：字宽用 canvas 实测，行高取已挂载 xterm 的行元素，字体加载完成后重测一次 */
export function cellMetrics(): CellMetrics {
  if (!fontsHooked && document.fonts) {
    fontsHooked = true;
    void document.fonts.ready.then(() => { charW = 0; lineH = 0; });
  }
  if (!charW) charW = measureCharW();
  if (!lineH) {
    const row = document.querySelector('.terminal-host .xterm-rows > div') as HTMLElement | null;
    if (row && row.offsetHeight > 0) lineH = row.offsetHeight;
  }
  return { ...DEFAULT_CELL_METRICS, charW, lineH: lineH || DEFAULT_CELL_METRICS.lineH };
}
