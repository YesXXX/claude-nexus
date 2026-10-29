import type { FileDiff } from '../../../shared/types';
import { renderDiff } from './diff-render.js';
import { buildSplit } from './diff-split.js';
import { TOO_LARGE_NOTICE, createHighlighter, tooLargeToHighlight, type Highlighter } from './diff-highlight.js';
import { diffView, highlightOn, onDiffPrefs, type DiffViewMode } from './diff-prefs.js';
import { restoreAnchor, takeAnchor, type ScrollAnchor } from './diff-anchor.js';
import { createViewControl } from './diff-view-control.js';

/**
 * diff 区的绘制协调：按偏好决定统一 / 分栏与是否着色，渲染后启动懒绘制；换文件、刷新、隐藏时丢弃未完成的绘制。
 * 偏好变化或 diff 区宽度跨过分栏门槛时按当前内容原地重绘，按行号对齐滚动位置，
 * 并通知改动视图让扩展（批注等）重画装饰。
 */

const OFF_NOTICE = '语法高亮已关闭，可在命令面板「开关语法高亮」重新打开';
const NARROW_NOTICE = 'diff 区不足 640px，分栏暂按统一显示 · 按 B 收起文件列表或 F 专注审阅可恢复分栏';
/** diff 区宽度低于这个值时分栏按统一视图绘制；恢复时多留一点余量，避免滚动条出没导致来回切换 */
const NARROW_PX = 640;
const WIDE_MARGIN = 24;
/** 从顶部打开的大 diff 先挂这么多行，其余分批补上，避免一次排版几千行卡住首屏 */
const SYNC_ROWS = 400;
const BATCH_ROWS = 500;

export interface DiffPresenter {
  /** 工具栏上的「统一 / 分栏」按钮 */
  readonly control: HTMLElement;
  /** 绘制一个文件的 diff，保持滚动位置 */
  render(d: FileDiff): void;
  /** 停掉懒绘制并忘掉当前内容（之后的偏好变化不再重绘），diff 区换成给定内容（不传则清空） */
  clear(...nodes: Node[]): void;
  /** 视图隐藏：停掉懒绘制并忘掉当前内容，已绘制的内容保留（未补完的行一次补齐） */
  pause(): void;
  /** 当前实际绘制的视图（偏好为分栏但过窄时为统一） */
  shown(): DiffViewMode;
}

interface Pending { code: Element; rest: DocumentFragment }

/** 代码区行数过多时把第 SYNC_ROWS 行之后的节点摘出来，留给分批补上 */
function splitTail(frag: DocumentFragment): Pending | undefined {
  const code = frag.querySelector('.chg-code');
  if (!code || code.childElementCount <= SYNC_ROWS + BATCH_ROWS) return undefined;
  const range = document.createRange();
  range.setStartBefore(code.children[SYNC_ROWS]);
  range.setEndAfter(code.lastChild as Node);
  return { code, rest: range.extractContents() };
}

export function createDiffPresenter(scroll: HTMLElement, rerendered: () => void): DiffPresenter {
  let hl: Highlighter | undefined;
  let current: FileDiff | undefined;
  let lastOn = highlightOn();
  let offNotice = false;
  let pending: Pending | undefined;
  let narrow = false;
  let shownMode: DiffViewMode = 'unified';
  const control = createViewControl();

  /** 按 diff 区当前宽度更新过窄标记；宽度为 0（未显示）时保持原判断，返回是否有变化 */
  const measure = (): boolean => {
    const w = scroll.clientWidth;
    if (w <= 0) return false;
    const next = narrow ? w < NARROW_PX + WIDE_MARGIN : w < NARROW_PX;
    if (next === narrow) return false;
    narrow = next;
    return true;
  };

  /** 丢弃未补上的行（内容随即被整体替换时用）；已排队的回调发现不是当前批次就直接返回 */
  const dropPending = (): void => {
    pending = undefined;
  };

  /** 未补上的行一次补齐 */
  const flushPending = (): void => {
    if (!pending) return;
    pending.code.append(pending.rest);
    pending = undefined;
  };

  /** 等这一帧排版绘制完再补下一批，每帧只排一批新行 */
  const later = (p: Pending): void => {
    window.requestAnimationFrame(() => { window.setTimeout(() => { if (pending === p) feed(p); }, 0); });
  };

  const feed = (p: Pending): void => {
    const batch = document.createDocumentFragment();
    for (let n = 0; n < BATCH_ROWS && p.rest.firstChild; n++) batch.append(p.rest.firstChild);
    p.code.append(batch);
    if (p.rest.firstChild) {
      later(p);
      return;
    }
    pending = undefined;
    // 补齐后让批注等扩展按完整内容重画装饰
    rerendered();
  };

  const stop = (): void => {
    hl?.dispose();
    hl = undefined;
  };

  const draw = (d: FileDiff, anchor?: ScrollAnchor): void => {
    stop();
    dropPending();
    measure();
    const notices: string[] = [];
    const wantSplit = diffView() === 'split';
    if (wantSplit && narrow) notices.push(NARROW_NOTICE);
    const on = highlightOn();
    if (on && tooLargeToHighlight(d)) notices.push(TOO_LARGE_NOTICE);
    else if (on) hl = createHighlighter(d, true);
    else if (offNotice) { notices.push(OFF_NOTICE); offNotice = false; }
    shownMode = wantSplit && !narrow ? 'split' : 'unified';
    const top = scroll.scrollTop;
    const left = scroll.scrollLeft;
    const frag = renderDiff(d, { sink: hl?.sink, notices, body: shownMode === 'split' ? buildSplit : undefined });
    // 只有停在顶部时才分批，停在中间的刷新与换视图要整段挂上才能恢复滚动位置
    const tail = !anchor && top === 0 && left === 0 ? splitTail(frag) : undefined;
    scroll.replaceChildren(frag);
    if (!anchor || !restoreAnchor(scroll, anchor)) scroll.scrollTop = top;
    scroll.scrollLeft = left;
    hl?.start(scroll);
    current = d;
    control.render(narrow);
    if (tail) {
      pending = tail;
      later(tail);
    }
  };

  /** 按当前内容原地重绘，滚动按行号对齐 */
  const redraw = (): void => {
    if (!current || !scroll.isConnected) return;
    flushPending();
    draw(current, takeAnchor(scroll));
    rerendered();
  };

  onDiffPrefs(() => {
    const on = highlightOn();
    if (lastOn && !on) offNotice = true;
    lastOn = on;
    control.render(narrow);
    redraw();
  });

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (!measure()) return;
      control.render(narrow);
      // 只有偏好为分栏时宽度才影响绘制
      if (diffView() === 'split') redraw();
    }).observe(scroll);
  }

  // 分栏下拖选文字只选按下那一侧，复制不会混入另一栏
  scroll.addEventListener('mousedown', (e) => {
    const code = scroll.querySelector('.chg-split');
    if (!code) return;
    const half = (e.target as HTMLElement | null)?.closest?.('.chg-half');
    code.classList.toggle('sel-l', !!half?.classList.contains('l'));
    code.classList.toggle('sel-r', !!half?.classList.contains('r'));
  });

  control.render(narrow);

  return {
    control: control.el,
    render: (d: FileDiff) => draw(d),
    clear(...nodes: Node[]): void {
      stop();
      dropPending();
      current = undefined;
      scroll.replaceChildren(...nodes);
    },
    pause(): void {
      stop();
      flushPending();
      current = undefined;
    },
    shown: () => shownMode,
  };
}
