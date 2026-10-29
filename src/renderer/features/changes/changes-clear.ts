import type { ChangedFile, Session } from '../../../shared/types';
import type { SessionChangedFile } from '../../../shared/session-change-types';
import type { ChangesScope } from '../../core/changes-ext.js';
import { el, ipcErrorText } from '../../core/dom.js';
import type { ChangesApi, ChangesViewOptions } from './changes-types.js';

/**
 * 清除改动记录的三个入口：行内 ✕ 直接清单个文件；组头 ✕ 与工具栏按钮确认后分别按目录、
 * 按全会话清空。清除是彻底删除（条目与改前快照一并删，之后的新改动会重新记录），
 * 因此组头与工具栏入口都弹确认，文案写明「不能再撤销到改前」。
 * 只读会话（由其他面板实例运行）与非本会话视角不提供入口。
 */

export interface ClearDeps {
  api: ChangesApi;
  opts: Pick<ChangesViewOptions, 'toast' | 'confirm'>;
  /** 工具栏按钮；可见性随会话、视角与记录数同步 */
  btn: HTMLButtonElement;
  session: () => Session | undefined;
  sessionId: () => string | undefined;
  scope: () => ChangesScope;
  /** 当前列表的文件总数（无摘要时的数量兜底） */
  filesCount: () => number;
  refresh: () => void;
}

export interface ClearControls {
  /** 列表行悬停的 ✕ 按钮（不可清除时为 null） */
  rowAction(f: ChangedFile): Node | null;
  /** 组头 ✕：确认后按根目录清除，能清掉列表截断之外的条目 */
  clearGroup(f: SessionChangedFile, count: number): Promise<void>;
  /** 工具栏按钮与命令面板入口：确认后清空本会话全部记录 */
  clearAll(): Promise<void>;
  /** 按当前会话、视角与记录数同步工具栏按钮可见性 */
  sync(): void;
}

export function createClearControls(deps: ClearDeps): ClearControls {
  const { api, opts, btn } = deps;

  const canClear = (): boolean => deps.scope() === 'session' && !!deps.sessionId() && !deps.session()?.readOnly;

  const sync = (): void => {
    btn.hidden = !(canClear() && deps.filesCount() > 0);
  };

  /** 行内「清除此文件记录」按钮：粒度小，直接清除并提示，不弹确认 */
  const rowAction = (f: ChangedFile): Node | null => {
    if (!canClear()) return null;
    const b = el('button', 'chg-x chg-row-clear', '✕');
    b.type = 'button';
    b.title = '清除此文件的改动记录（删除改前快照，之后不能再撤销到改前）';
    b.addEventListener('click', e => { e.stopPropagation(); void dismissOne(f); });
    return b;
  };

  const dismissOne = async (f: ChangedFile): Promise<void> => {
    const id = deps.sessionId();
    if (!id) return;
    try {
      const r = await api.sessionChanges.dismiss(id, [f.path]);
      if (r.removed > 0) opts.toast(`已清除 ${f.path.split('/').pop() ?? f.path} 的改动记录`, 'success');
      else opts.toast('该文件没有可清除的记录', 'info');
    } catch (e) {
      opts.toast(ipcErrorText(e), 'error');
      return;
    }
    deps.refresh();
  };

  const clearGroup = async (f: SessionChangedFile, count: number): Promise<void> => {
    const id = deps.sessionId();
    if (!id || !opts.confirm) return;
    const ok = await opts.confirm({
      title: '清除此目录的改动记录',
      message: `删除 ${f.root}${f.outside ? '（工作目录外）' : ''} 下的改动记录与改前快照`
        + `（列表中显示 ${count} 个文件，实际清除该目录下全部）。清除后这些文件不能再撤销到改前。`,
      okText: '清除',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.sessionChanges.dismissRoot(id, f.root, f.outside);
      if (r.removed > 0) opts.toast(`已清除 ${r.removed} 条改动记录`, 'success');
      else opts.toast('该目录没有可清除的记录', 'info');
    } catch (e) {
      opts.toast(ipcErrorText(e), 'error');
      return;
    }
    deps.refresh();
  };

  const clearAll = async (): Promise<void> => {
    const id = deps.sessionId();
    if (!id || !opts.confirm || deps.session()?.readOnly) return;
    const count = deps.session()?.sessionChanges?.files ?? deps.filesCount();
    if (count <= 0) {
      opts.toast('当前没有改动记录', 'info');
      return;
    }
    const ok = await opts.confirm({
      title: '清除改动记录',
      message: `删除本会话全部 ${count} 条改动记录与改前快照。清除后这些文件不能再撤销到改前；之后的新改动会重新记录。`,
      okText: '清除',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.sessionChanges.clear(id);
      if (r.removed > 0) opts.toast(`已清除 ${r.removed} 条改动记录`, 'success');
      else opts.toast('当前没有改动记录', 'info');
    } catch (e) {
      opts.toast(ipcErrorText(e), 'error');
      return;
    }
    deps.refresh();
  };

  btn.addEventListener('click', () => void clearAll());

  return { rowAction, clearGroup, clearAll, sync };
}
