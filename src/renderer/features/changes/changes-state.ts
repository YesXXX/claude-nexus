import { buildErrorBox, sharedBannerText } from './changes-list.js';

/**
 * 改动视图的外壳状态：占位区与主体的二选一显示、出错占位、共用目录横幅、刷新按钮的转圈。
 * 只操作传入的元素，不持有业务状态。
 */

export interface ShellParts {
  stateEl: HTMLElement;
  body: HTMLElement;
  banner: HTMLElement;
  refreshBtn: HTMLElement;
}

export interface Shell {
  /** 传节点显示占位并隐藏主体；传 null 清掉占位并显示主体 */
  showState(node: Node | null): void;
  showError(raw: string, onRetry: () => void): void;
  renderBanner(sharedWith: number): void;
  setBusy(busy: boolean): void;
}

export function createShell(p: ShellParts): Shell {
  const showState = (node: Node | null): void => {
    if (node) {
      p.stateEl.replaceChildren(node);
      p.stateEl.hidden = false;
      p.body.hidden = true;
    } else {
      p.stateEl.replaceChildren();
      p.stateEl.hidden = true;
      p.body.hidden = false;
    }
  };
  return {
    showState,
    showError: (raw, onRetry) => showState(buildErrorBox(raw, onRetry)),
    renderBanner(sharedWith: number): void {
      p.banner.hidden = sharedWith <= 0;
      p.banner.textContent = sharedBannerText(sharedWith);
    },
    setBusy(busy: boolean): void {
      p.refreshBtn.classList.toggle('spin', busy);
    },
  };
}
