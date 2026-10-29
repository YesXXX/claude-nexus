import type { AppContext } from '../core/context.js';
import { endSessionFlow } from '../actions/session-actions.js';

/**
 * 内置页头操作：复制路径、复制会话 id、结束会话，都放在「⋯」菜单里（续接与全新开始由续接模块放在页头）。
 * 面包屑里的项目名点击即复制工作目录。
 */

export function installBuiltinPaneActions(ctx: AppContext): void {
  const { registerPaneMenuItem } = ctx.registry;
  const copy = (text: string, done: string): void => {
    void navigator.clipboard?.writeText(text).then(() => ctx.toast(done), () => ctx.toast('复制失败', 'error'));
  };

  registerPaneMenuItem({
    id: 'core.copy-path', order: 300,
    item: s => ({ label: '复制路径', role: 'copy-path', title: s.cwd, run: () => copy(s.cwd, '已复制路径') }),
  });
  registerPaneMenuItem({
    id: 'core.copy-id', order: 310,
    item: s => ({ label: '复制会话 id', role: 'copy-id', title: s.id, run: () => copy(s.id, '已复制会话 id') }),
  });
  registerPaneMenuItem({
    id: 'core.end-session', order: 900,
    item: s => (s.readOnly ? null : { label: '结束会话', role: 'end-session', danger: true, run: () => { void endSessionFlow(s); } }),
  });

  const proj = document.getElementById('pane-project');
  proj?.addEventListener('click', () => {
    const cwd = proj.dataset.cwd;
    if (cwd) copy(cwd, '已复制路径');
  });
}
