import { byId } from '../core/dom.js';
import { inspectorSections, renderEach } from '../core/registry.js';
import { inspectorShown } from '../core/review-layout.js';
import { selectedSession, state } from '../core/state.js';

/** 属性面板：分区由属性面板分区注册表按 order 组装 */
export function renderInspector(): void {
  const insp = byId('inspector');
  insp.innerHTML = '';
  // 改动标签下属性面板只是被布局收起，内容照常生成，展开时无需等下一轮渲染
  if (state.inspectorHidden && !inspectorShown()) return;
  insp.append(...renderEach(inspectorSections(), selectedSession(), (sec, s) => sec.render(s)));
}
