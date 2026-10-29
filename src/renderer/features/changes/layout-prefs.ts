/**
 * 改动页的版面偏好：自动换行、文件列表宽度与是否收起、分组的折叠状态，存 localStorage，重启后保留。
 * 与 diff-prefs 分开：这些只改样式，不需要重绘 diff；拖动列表宽度时也不会触发重绘。
 * 存储不可用时只保存在内存里；键删掉即恢复默认：不换行、列表 240px、展开。
 */

const WRAP_KEY = 'nexus.diff.wrap';
const LIST_W_KEY = 'nexus.changes.listW';
const LIST_HIDDEN_KEY = 'nexus.changes.listCollapsed';
const COLLAPSED_KEY = 'nexus.changes.collapsedGroups';

export const LIST_W_DEFAULT = 240;
export const LIST_W_MIN = 180;
export const LIST_W_MAX = 480;

type Listener = () => void;
const listeners = new Set<Listener>();
let wrapCache: boolean | undefined;
let widthCache: number | undefined;
let hiddenCache: boolean | undefined;
let collapsedCache: Set<string> | undefined;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 存储不可用时只留在内存 */ }
}

function emit(): void {
  for (const fn of [...listeners]) {
    try { fn(); } catch (err) { console.error('[layout-prefs] 偏好监听出错', err); }
  }
}

export function clampListWidth(w: number): number {
  return Math.round(Math.max(LIST_W_MIN, Math.min(LIST_W_MAX, w)));
}

/** 统一视图下长行是否折行显示，默认关（横向滚动） */
export function diffWrap(): boolean {
  if (wrapCache === undefined) wrapCache = read(WRAP_KEY) === '1';
  return wrapCache;
}

export function setDiffWrap(on: boolean): void {
  if (diffWrap() === on) return;
  wrapCache = on;
  write(WRAP_KEY, on ? '1' : '0');
  emit();
}

export function toggleDiffWrap(): boolean {
  setDiffWrap(!diffWrap());
  return diffWrap();
}

export function listWidth(): number {
  if (widthCache === undefined) {
    const n = Number(read(LIST_W_KEY));
    widthCache = Number.isFinite(n) && n > 0 ? clampListWidth(n) : LIST_W_DEFAULT;
  }
  return widthCache;
}

/** persist=false 只改内存（拖动过程中），松手时再带 persist 写入一次 */
export function setListWidth(w: number, persist = true): void {
  const next = clampListWidth(w);
  const changed = listWidth() !== next;
  widthCache = next;
  if (persist) write(LIST_W_KEY, String(next));
  if (changed) emit();
}

export function listCollapsed(): boolean {
  if (hiddenCache === undefined) hiddenCache = read(LIST_HIDDEN_KEY) === '1';
  return hiddenCache;
}

export function setListCollapsed(on: boolean): void {
  if (listCollapsed() === on) return;
  hiddenCache = on;
  write(LIST_HIDDEN_KEY, on ? '1' : '0');
  emit();
}

export function toggleListCollapsed(): boolean {
  setListCollapsed(!listCollapsed());
  return listCollapsed();
}

/** 已折叠的分组键（根目录加内外标记）；同一目录下次打开仍保持折叠 */
export function collapsedGroups(): Set<string> {
  if (collapsedCache === undefined) {
    let keys: unknown;
    try { keys = JSON.parse(read(COLLAPSED_KEY) ?? '[]'); } catch { keys = []; }
    collapsedCache = new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []);
  }
  return collapsedCache;
}

/** 折叠 / 展开一个分组，返回折叠后的状态 */
export function toggleCollapsedGroup(key: string): boolean {
  const set = collapsedGroups();
  const on = !set.has(key);
  if (on) set.add(key); else set.delete(key);
  write(COLLAPSED_KEY, JSON.stringify([...set]));
  emit();
  return on;
}

/** 任一版面偏好变化时回调；返回取消订阅 */
export function onLayoutPrefs(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
