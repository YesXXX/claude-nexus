import type { DegradeState, GridSize } from '../../shared/pane-geometry.js';
import { INITIAL_DEGRADE, MIN_DWELL_MS, minGrid, nextDegrade } from '../../shared/pane-geometry.js';

/**
 * 自动退化监视：任一窗格实测不足 60 列或 12 行时只显示焦点窗格，估算尺寸足够后恢复。
 * 尺寸变化频繁（拖窗口边、审批条出现），所以 150ms 防抖后再判定；
 * 因最短停留未到而暂不切换时，到期再复查一次，避免停在过期状态。
 */

export interface DegradeWatch {
  degraded(): boolean;
  worst(): GridSize | null;
  schedule(): void;
  reset(): void;
}

export interface DegradeDeps {
  /** 网格模式下各可见窗格的实测列行；最大化或已退化时返回空数组 */
  measure(): GridSize[];
  /** 按区域尺寸与布局树估算的最差窗格列行；区域不可见时为 null */
  estimate(): GridSize | null;
  /** 退化状态或最差尺寸变化后调用（重绘） */
  onChange(): void;
}

const DEBOUNCE_MS = 150;

export function createDegradeWatch(deps: DegradeDeps): DegradeWatch {
  let st: DegradeState = INITIAL_DEGRADE;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let recheck: ReturnType<typeof setTimeout> | null = null;

  const run = (): void => {
    timer = null;
    const now = Date.now();
    const next = nextDegrade(st, now, minGrid(deps.measure()), deps.estimate());
    const changed = next !== st;
    st = next;
    const wait = st.since + MIN_DWELL_MS - now;
    if (wait > 0 && !recheck) {
      recheck = setTimeout(() => { recheck = null; schedule(); }, wait + 20);
    }
    if (changed) deps.onChange();
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  };

  return {
    degraded: () => st.degraded,
    worst: () => st.worst,
    schedule,
    reset: () => {
      if (timer) clearTimeout(timer);
      if (recheck) clearTimeout(recheck);
      timer = null;
      recheck = null;
      st = INITIAL_DEGRADE;
    },
  };
}
