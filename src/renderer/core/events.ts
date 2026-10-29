import type { Session } from '../../shared/types';

/**
 * 极小事件总线：只用于打断依赖环的跨模块通知（例如选中会话后命令面板自行关闭），
 * 不用来传递业务数据，也不替代 render()。监听函数同步执行，按注册顺序调用。
 */
export interface PanelEvents {
  /** 用户选中了另一个会话或子代理 */
  'selection-changed': { sessionId: string | null };
  /** 主进程推送了新的会话列表，state.sessions 已更新 */
  'sessions-updated': { sessions: Session[] };
}

type Listener<K extends keyof PanelEvents> = (e: PanelEvents[K]) => void;

const listeners: { [K in keyof PanelEvents]?: Set<Listener<K>> } = {};

/** 订阅事件，返回取消订阅函数 */
export function on<K extends keyof PanelEvents>(type: K, fn: Listener<K>): () => void {
  let set = listeners[type] as Set<Listener<K>> | undefined;
  if (!set) {
    set = new Set();
    (listeners as Record<K, Set<Listener<K>>>)[type] = set;
  }
  set.add(fn);
  return () => { set.delete(fn); };
}

export function emit<K extends keyof PanelEvents>(type: K, e: PanelEvents[K]): void {
  const set = listeners[type] as Set<Listener<K>> | undefined;
  if (!set) return;
  for (const fn of [...set]) fn(e);
}
