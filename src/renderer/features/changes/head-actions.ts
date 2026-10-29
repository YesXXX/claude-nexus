import type { ChangedFile, FileDiff } from '../../../shared/types';
import { ipcErrorText } from '../../core/dom.js';
import { firstHunkLine } from './changes-format.js';
import type { ChangesApi, ChangesViewOptions } from './changes-types.js';

/**
 * diff 标题栏的操作接线：用默认程序打开、在资源管理器定位、点击路径复制完整地址、上一个 / 下一个文件。
 * 所有取值都经回调读视图当前状态，本模块不持有状态。
 */

export interface HeadActionParts {
  openBtn: HTMLButtonElement;
  revealBtn: HTMLButtonElement;
  copyBtn: HTMLButtonElement;
  diffPath: HTMLElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
}

export interface HeadActionDeps {
  api: ChangesApi;
  toast: ChangesViewOptions['toast'];
  sessionId: () => string | undefined;
  /** 当前选中文件的路径（列表内唯一键） */
  selectedPath: () => string | undefined;
  /** 当前选中的文件对象；用于拼完整地址 */
  selectedFile: () => ChangedFile | undefined;
  addressOf: (f: ChangedFile) => string;
  isSession: () => boolean;
  shownDiff: () => FileDiff | undefined;
  /** 在展示列表里相对当前文件移动 delta 个位置 */
  step: (delta: number) => void;
}

export function bindHeadActions(p: HeadActionParts, d: HeadActionDeps): void {
  /** 传了行号且配置了外部编辑器时，主进程改为在编辑器中跳到该行；未配置编辑器时按默认程序打开 */
  const openSelected = async (reveal: boolean, line?: number): Promise<void> => {
    const id = d.sessionId();
    const path = d.selectedPath();
    if (!id || !path) return;
    try {
      const err = d.isSession()
        ? await d.api.sessionChanges.openPath(id, path, reveal, line)
        : await d.api.openPath(id, path, reveal, line);
      if (err) d.toast(err, 'error');
    } catch (e) {
      d.toast(ipcErrorText(e), 'error');
    }
  };
  p.openBtn.addEventListener('click', () => void openSelected(false, firstHunkLine(d.shownDiff())));
  p.revealBtn.addEventListener('click', () => void openSelected(true));

  const copyAddress = (): void => {
    const f = d.selectedFile();
    if (!f) return;
    void navigator.clipboard?.writeText(d.addressOf(f))
      .then(() => d.toast('已复制文件地址', 'success'))
      .catch(() => d.toast('复制失败', 'error'));
  };
  p.copyBtn.addEventListener('click', copyAddress);
  p.diffPath.addEventListener('click', copyAddress);
  p.prevBtn.addEventListener('click', () => d.step(-1));
  p.nextBtn.addEventListener('click', () => d.step(1));
}
