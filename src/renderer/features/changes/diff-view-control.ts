import { el } from '../../core/dom.js';
import { diffView, setDiffView } from './diff-prefs.js';

/**
 * 工具栏「统一 / 分栏」分段按钮：点击只改偏好，绘制由 diff 区订阅偏好后完成。
 * 偏好为分栏但 diff 区过窄时，分栏按钮转为琥珀色并在悬停提示里说明原因，偏好本身不变。
 */

export interface ViewControl {
  readonly el: HTMLElement;
  /** 按当前偏好与是否过窄刷新按钮状态 */
  render(narrow: boolean): void;
}

export const NARROW_TIP = 'diff 区不足 640px，暂按统一视图显示；收起文件列表（B）、专注审阅（F）或放宽窗口后自动恢复分栏';

export function createViewControl(): ViewControl {
  const root = el('div', 'chg-seg chg-view-seg');
  const uni = el('button', 'chg-seg-btn', '统一');
  const split = el('button', 'chg-seg-btn', '分栏');
  uni.type = 'button';
  split.type = 'button';
  uni.dataset.view = 'unified';
  split.dataset.view = 'split';
  uni.title = '增删合在一栏显示（V 切换）';
  root.append(uni, split);
  uni.addEventListener('click', () => setDiffView('unified'));
  split.addEventListener('click', () => setDiffView('split'));
  return {
    el: root,
    render(narrow: boolean): void {
      const pref = diffView();
      const fallback = pref === 'split' && narrow;
      uni.classList.toggle('on', pref === 'unified');
      split.classList.toggle('on', pref === 'split');
      split.title = fallback ? NARROW_TIP : '左旧右新并排显示（V 切换）';
      root.classList.toggle('narrow', fallback);
    },
  };
}
