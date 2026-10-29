/**
 * 改动列表顶部的搜索框：输入防抖后通知视图按新词过滤（匹配逻辑在 filterShown），
 * Enter 回列表，Esc 清空并回列表（已为空时交给全局 Esc，如退出专注审阅）。
 * 搜索词由控制器持有；视图重算列表后调 sync 在右侧显示「匹配数 / 总数」。
 */

/** 输入停止多久后才应用过滤 */
const DEBOUNCE_MS = 120;

export interface SearchBox {
  /** 当前搜索词（空串不过滤） */
  query(): string;
  /** 丢弃待执行的防抖（视图隐藏时） */
  cancel(): void;
  /** 同步匹配计数：搜索生效且与总数不同时显示 N / M，平时留空 */
  sync(shown: number, total: number): void;
  /** 聚焦并全选（/ 热键用） */
  focus(): void;
}

export function bindSearchBox(
  input: HTMLInputElement, info: HTMLElement, list: HTMLElement, onChange: (q: string) => void,
): SearchBox {
  let q = '';
  let timer: number | undefined;

  const cancel = (): void => {
    window.clearTimeout(timer);
    timer = undefined;
  };

  const fire = (next: string): void => {
    if (next === q) return;
    q = next;
    onChange(q);
  };

  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      fire(input.value);
    }, DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!input.value) return;
      e.stopPropagation();
      input.value = '';
      cancel();
      fire('');
      list.focus({ preventScroll: true });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      list.focus({ preventScroll: true });
    }
  });

  return {
    query: () => q,
    cancel,
    sync(shown, total): void {
      const filtering = !!q.trim() && shown !== total;
      info.textContent = filtering ? `${shown} / ${total}` : '';
      info.title = q.trim() ? `匹配 ${shown} 个，共 ${total} 个` : '';
    },
    focus(): void {
      input.focus();
      input.select();
    },
  };
}
