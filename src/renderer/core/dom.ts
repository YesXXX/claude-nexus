import type { Session } from '../../shared/types';

/**
 * 渲染层共用的 DOM 小工具与错误文本处理。
 * 只在函数内访问 document，模块导入时没有副作用。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 按 id 取界面元素；缺失说明 index.html 与代码不一致，直接抛错暴露问题 */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`界面元素缺失：#${id}`);
  return node as T;
}

/** 按 id 取元素，允许缺失 */
export function queryEl(id: string): HTMLElement | null { return document.getElementById(id); }

/** 创建元素并设置类名与文本；文本只用 textContent 写入，不拼 HTML */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 致命错误显示：任何初始化阶段的异常都直接渲染到页面，方便用户反馈 */
export function fatal(msg: string): void {
  let box = document.querySelector<HTMLPreElement>('.fatal-error');
  if (!box) {
    box = document.createElement('pre');
    box.className = 'fatal-error';
    document.body.appendChild(box);
  }
  box.textContent = msg;
  console.error(msg);
}

/** 状态图标：SVG symbol 引用，颜色由 .si.st-* 的 color 经 currentColor 传入 */
export function statusIcon(status: Session['status'], extraCls = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `si st-${status}${extraCls ? ' ' + extraCls : ''}`);
  svg.setAttribute('viewBox', '0 0 14 14');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#s-${status}`);
  svg.appendChild(use);
  return svg;
}

/** 线条图标：16×16 画布、描边取 currentColor，每段路径一个 path */
export function lineIcon(paths: readonly string[], size = 14, stroke = 1.4): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

/** 常用线条图标的路径 */
export const ICON_PATHS = {
  list: ['M3.5 2.5h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z', 'M6 2.5v11'],
  undo: ['M5 3 2 6l3 3', 'M2 6h7.5a4 4 0 0 1 0 8H7'],
  copy: [
    'M6.8 5h5.4A1.8 1.8 0 0 1 14 6.8v5.4a1.8 1.8 0 0 1-1.8 1.8H6.8A1.8 1.8 0 0 1 5 12.2V6.8A1.8 1.8 0 0 1 6.8 5Z',
    'M11 5V3.8A1.8 1.8 0 0 0 9.2 2H3.8A1.8 1.8 0 0 0 2 3.8v5.4A1.8 1.8 0 0 0 3.8 11H5',
  ],
  open: ['M9 2.5h4.5V7', 'M13.5 2.5 7.5 8.5', 'M12 9.5v3a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 2 12.5v-7A1.5 1.5 0 0 1 3.5 4h3'],
  reveal: ['M1.8 4.2c0-.8.6-1.4 1.4-1.4h3l1.4 1.6h5.2c.8 0 1.4.6 1.4 1.4v6.4c0 .8-.6 1.4-1.4 1.4H3.2c-.8 0-1.4-.6-1.4-1.4Z'],
  focus: ['M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10'],
  wrap: ['M2 3.5h12M2 8h9.5a2.25 2.25 0 0 1 0 4.5H8', 'm9.5 11-1.5 1.5L9.5 14', 'M2 12.5h3'],
  ignoreWs: [
    'M2.5 5.6c1.2-1.4 2.8-1.4 4 0s2.8 1.4 4 0c.7-.8 1.4-1.1 2-.9',
    'M2.5 10.4c1.2-1.4 2.8-1.4 4 0s2.8 1.4 4 0c.7-.8 1.4-1.1 2-.9',
  ],
  prev: ['m10 3-5 5 5 5'],
  next: ['m6 3 5 5-5 5'],
  refresh: ['M13.5 8A5.5 5.5 0 1 1 11.8 4', 'M13.5 2.5V5.5H10.5'],
  chevron: ['m3.5 6 4.5 4.5L12.5 6'],
  trash: [
    'M2.5 4.5h11',
    'M6.2 4.5V3.4c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.1',
    'M4.3 4.5l.6 8.4c.1.5.5.9 1 .9h4.2c.5 0 .9-.4 1-.9l.6-8.4',
    'M6.7 7.2v4.2M9.3 7.2v4.2',
  ],
} as const;

/** IPC 抛出的错误带「Error invoking remote method 'x': Error: 」前缀，界面只展示后面的原因 */
export function ipcErrorText(err: unknown): string {
  const msg = String((err as Error)?.message ?? err);
  return msg.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}
