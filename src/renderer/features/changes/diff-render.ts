import type { DiffHunk, DiffLine, FileDiff } from '../../../shared/types';
import { lineText } from '../../../shared/diff-layout.js';
import { el } from '../../core/dom.js';

/**
 * 改动视图的 diff 渲染：纯 DOM 构建，不持有状态，不发请求。
 * 文件内容不可信，只用 textContent 写入，不拼 HTML；语法着色由 diff-highlight 在文本单元登记后按可视区补画。
 */

export type DiffSide = 'old' | 'new';
/** 渲染时登记一个文本单元（分块序号、分块内行序号、所属的旧 / 新流），供高亮懒绘制 */
export type CellSink = (txt: HTMLElement, hunk: number, index: number, side: DiffSide) => void;

const notice = (text: string, cls: string): HTMLElement => el('div', `chg-notice ${cls}`, text);

const placeholder = (text: string): HTMLElement => el('div', 'chg-placeholder', text);

export const noCell = (n: number | undefined): HTMLElement => el('span', 'chg-no', n !== undefined ? String(n) : '');

export const signText = (kind: DiffLine['kind']): string => (kind === 'add' ? '+' : kind === 'del' ? '-' : ' ');

/** 正文单元：元信息行以「\ 」开头原样显示，其余去掉行尾回车 */
export const textCell = (l: DiffLine): HTMLElement => el('span', 'chg-txt', l.kind === 'meta' ? `\\ ${l.text}` : lineText(l));

/** 代码区容器：行号栏宽度按最大行号的位数确定，所有行对齐 */
export function codeBox(hunks: DiffHunk[], cls = ''): HTMLElement {
  let maxNo = 1;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.oldNo !== undefined && l.oldNo > maxNo) maxNo = l.oldNo;
      if (l.newNo !== undefined && l.newNo > maxNo) maxNo = l.newNo;
    }
  }
  const code = el('div', cls ? `chg-code ${cls}` : 'chg-code');
  code.style.setProperty('--chg-nw', `${String(maxNo).length + 2}ch`);
  return code;
}

export function hunkHead(h: DiffHunk, hi: number): HTMLElement {
  const head = el('div', 'chg-hunk', h.header);
  head.dataset.h = String(hi);
  return head;
}

/**
 * 统一 diff 的 hunk 区：双行号栏、符号列与正文。
 * 每行带 data-h（分块序号）与 data-i（分块内行序号），与主进程按同一 diff 定位批注范围；
 * 有旧 / 新行号的行另带 data-o / data-n，供批注按文件行号找回所在行。
 * 删除行登记为旧流，新增与上下文行登记为新流。
 */
export function buildHunks(hunks: DiffHunk[], sink?: CellSink): HTMLElement {
  const code = codeBox(hunks);
  const frag = document.createDocumentFragment();
  hunks.forEach((h, hi) => {
    frag.append(hunkHead(h, hi));
    h.lines.forEach((l, li) => {
      const row = el('div', `chg-ln ${l.kind}`);
      row.dataset.h = String(hi);
      row.dataset.i = String(li);
      if (l.oldNo !== undefined) row.dataset.o = String(l.oldNo);
      if (l.newNo !== undefined) row.dataset.n = String(l.newNo);
      const txt = textCell(l);
      if (l.kind === 'meta') {
        row.append(el('span', 'chg-no'), el('span', 'chg-no'), el('span', 'chg-sign'), txt);
      } else {
        row.append(noCell(l.oldNo), noCell(l.newNo), el('span', 'chg-sign', signText(l.kind)), txt);
        sink?.(txt, hi, li, l.kind === 'del' ? 'old' : 'new');
      }
      frag.append(row);
    });
  });
  code.append(frag);
  return code;
}

export interface RenderOptions {
  /** 文本单元登记，不传则不着色 */
  sink?: CellSink;
  /** 替换默认统一视图的 hunk 区构建（分栏视图） */
  body?: (hunks: DiffHunk[], sink?: CellSink) => HTMLElement;
  /** 额外的顶部提示（如已关闭语法高亮） */
  notices?: string[];
}

/** 单文件 diff 区的全部内容：错误、编码与截断提示、二进制或无文本差异的占位、hunk */
export function renderDiff(d: FileDiff, opts: RenderOptions = {}): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (d.error) {
    frag.append(notice(d.error, 'err'));
  } else {
    if (d.notice) frag.append(notice(d.notice, 'warn'));
    if (d.notUtf8) frag.append(notice('文件可能不是 UTF-8 编码，显示可能有乱码', 'warn'));
    if (d.truncated) frag.append(notice('diff 过大，仅显示前一部分，完整内容请点「打开」查看', 'warn'));
    if (d.binary) frag.append(placeholder('二进制文件，不显示内容'));
    else if (d.hunks.length === 0) frag.append(placeholder(d.emptyText ?? '没有文本差异（可能仅重命名或权限变化）'));
    else {
      for (const n of opts.notices ?? []) frag.append(notice(n, 'warn'));
      frag.append((opts.body ?? buildHunks)(d.hunks, opts.sink));
    }
  }
  return frag;
}
