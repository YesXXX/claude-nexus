import { byId } from './dom.js';
import { isMultiPane } from './panes.js';
import { saveInspectorHidden } from './persist.js';
import { render } from './render.js';
import { selectedSession, state } from './state.js';

/**
 * 审阅布局：会话详情停在「改动」标签时自动收起属性面板，把宽度让给 diff；终端标签显示多个窗格时同样收起。
 * 期间点属性面板按钮只临时展开，不改持久化的偏好。专注审阅再把会话列表一起收起。
 * 一离开这些场景（单窗格终端、选子代理、回首页），临时状态全部作废，属性面板按用户偏好恢复。
 */

let focus = false;
let inspectorOpen = false;

/** 当前是否在看某个父会话的改动标签 */
export function inReview(): boolean {
  return !!selectedSession() && !state.selectedSubagent && state.paneTab === 'changes';
}

export function reviewFocus(): boolean {
  return focus && inReview();
}

/** 终端标签下显示多个窗格：同样把属性面板的宽度让给终端 */
function multiPaneTerm(): boolean {
  return !!selectedSession() && !state.selectedSubagent && state.paneTab === 'term' && isMultiPane();
}

/** 当前场景是否自动收起属性面板（期间按钮只临时展开） */
function collapsing(): boolean {
  return inReview() || multiPaneTerm();
}

export function setReviewFocus(on: boolean): void {
  if (reviewFocus() === on) return;
  focus = on && inReview();
  render();
}

/** 属性面板是否显示：自动收起的场景看临时状态（默认收起），其余时候看用户偏好 */
export function inspectorShown(): boolean {
  return collapsing() ? inspectorOpen : !state.inspectorHidden;
}

export function toggleInspector(): void {
  if (collapsing()) {
    inspectorOpen = !inspectorOpen;
  } else {
    state.inspectorHidden = !state.inspectorHidden;
    saveInspectorHidden(state.inspectorHidden);
  }
  render();
}

/** 每轮渲染末尾调用：详情面板可能刚把标签退回终端，按最终状态同步外层布局 */
export function syncReviewLayout(): void {
  if (!inReview()) focus = false;
  if (!collapsing()) inspectorOpen = false;
  const app = byId('app');
  app.classList.toggle('no-inspector', !inspectorShown());
  app.classList.toggle('review-focus', focus);
  byId('btn-inspector').classList.toggle('on', inspectorShown());
}
