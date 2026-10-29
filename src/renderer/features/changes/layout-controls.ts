import type { ChangesViewOptions } from './changes-types.js';
import { ignoreWs, onDiffPrefs, toggleIgnoreWs } from './diff-prefs.js';
import {
  diffWrap, LIST_W_DEFAULT, LIST_W_MIN, listCollapsed, listWidth, onLayoutPrefs, setListWidth, toggleDiffWrap,
  toggleListCollapsed,
} from './layout-prefs.js';

/**
 * 改动页的版面控件：自动换行按钮、忽略空白按钮、文件列表收起按钮、拖动分隔条调宽，以及专注审阅按钮。
 * 版面偏好变化只切换类名与宽度变量，不重绘 diff；分栏是否回退统一由 diff 区自己的尺寸监听决定。
 * 忽略空白按钮只同步选中态：切换后由改动视图重新拉取 diff。
 */

/** 拖宽文件列表时给 diff 区至少留这么宽 */
const DIFF_MIN_PX = 320;

export interface LayoutParts {
  host: HTMLElement;
  body: HTMLElement;
  /** 文件列表所在的整列（含搜索行），宽度拖动量这一列 */
  listCol: HTMLElement;
  splitter: HTMLElement;
  wrapBtn: HTMLButtonElement;
  wsBtn: HTMLButtonElement;
  listToggle: HTMLButtonElement;
}

export function bindLayoutControls(p: LayoutParts): void {
  const { host, body, listCol, splitter, wrapBtn, wsBtn, listToggle } = p;
  const apply = (): void => {
    const wrap = diffWrap();
    host.classList.toggle('chg-wrap', wrap);
    wrapBtn.classList.toggle('on', wrap);
    wrapBtn.setAttribute('aria-pressed', String(wrap));
    const collapsed = listCollapsed();
    body.classList.toggle('list-collapsed', collapsed);
    listToggle.classList.toggle('on', !collapsed);
    listToggle.setAttribute('aria-pressed', String(!collapsed));
    body.style.setProperty('--chg-list-w', `${listWidth()}px`);
  };
  apply();
  onLayoutPrefs(apply);
  wrapBtn.addEventListener('click', () => { toggleDiffWrap(); });
  const applyWs = (): void => {
    const ws = ignoreWs();
    wsBtn.classList.toggle('on', ws);
    wsBtn.setAttribute('aria-pressed', String(ws));
  };
  applyWs();
  onDiffPrefs(applyWs);
  wsBtn.addEventListener('click', () => { toggleIgnoreWs(); });
  listToggle.addEventListener('click', () => { toggleListCollapsed(); });

  // 拖动过程中只改内存，松手才写入存储；双击恢复默认
  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = listCol.getBoundingClientRect().width;
    const maxW = Math.max(LIST_W_MIN, body.clientWidth - DIFF_MIN_PX);
    try { splitter.setPointerCapture(e.pointerId); } catch { /* 指针已释放时无法捕获，仍按分隔条上的事件拖动 */ }
    body.classList.add('resizing');
    const move = (ev: PointerEvent): void => setListWidth(Math.min(maxW, startW + ev.clientX - startX), false);
    const end = (): void => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', end);
      splitter.removeEventListener('pointercancel', end);
      body.classList.remove('resizing');
      setListWidth(listWidth(), true);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', end);
    splitter.addEventListener('pointercancel', end);
  });
  splitter.addEventListener('dblclick', () => setListWidth(LIST_W_DEFAULT));
}

export interface FocusParts {
  focusBtn: HTMLButtonElement;
  focusText: HTMLElement;
}

/** 专注审阅按钮：没有接入外层布局时隐藏；返回按当前状态刷新按钮文字的函数 */
export function bindFocusButton(p: FocusParts, focusMode: ChangesViewOptions['focusMode']): () => void {
  const { focusBtn, focusText } = p;
  focusBtn.hidden = !focusMode;
  const sync = (): void => {
    if (!focusMode) return;
    const on = focusMode.on();
    focusBtn.classList.toggle('on', on);
    focusBtn.setAttribute('aria-pressed', String(on));
    focusText.textContent = on ? '退出专注' : '专注审阅';
    focusBtn.title = on ? '退出专注审阅（Esc）' : '专注审阅：收起会话列表与属性面板（F，Esc 退出）';
  };
  focusBtn.addEventListener('click', () => {
    if (!focusMode) return;
    focusMode.set(!focusMode.on());
    sync();
  });
  return sync;
}
