/**
 * diff 显示偏好：统一 / 分栏视图、语法高亮与忽略空白开关，存 localStorage，重启后保留。
 * 存储不可用（隐私模式、配额满等）时只保存在内存里，读不到按默认值处理。
 * 键删掉即恢复默认：统一视图、高亮开、忽略空白关。
 * 忽略空白改变 diff 内容本身，改动视图会按它重新拉取 diff，其余偏好只影响绘制。
 */

export type DiffViewMode = 'unified' | 'split';

const VIEW_KEY = 'nexus.diff.view';
const HL_KEY = 'nexus.diff.highlight';
const WS_KEY = 'nexus.diff.ignoreWs';

type Listener = () => void;
const listeners = new Set<Listener>();
let viewCache: DiffViewMode | undefined;
let hlCache: boolean | undefined;
let wsCache: boolean | undefined;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 存储不可用时只留在内存 */ }
}

function emit(): void {
  for (const fn of [...listeners]) {
    try { fn(); } catch (err) { console.error('[diff-prefs] 偏好监听出错', err); }
  }
}

export function diffView(): DiffViewMode {
  if (viewCache === undefined) viewCache = read(VIEW_KEY) === 'split' ? 'split' : 'unified';
  return viewCache;
}

export function setDiffView(v: DiffViewMode): void {
  if (diffView() === v) return;
  viewCache = v;
  write(VIEW_KEY, v);
  emit();
}

export function toggleDiffView(): DiffViewMode {
  setDiffView(diffView() === 'split' ? 'unified' : 'split');
  return diffView();
}

/** 语法高亮与词级差异的总开关，默认开；'0' 与 'off' 视为关 */
export function highlightOn(): boolean {
  if (hlCache === undefined) {
    const raw = read(HL_KEY);
    hlCache = raw !== '0' && raw !== 'off';
  }
  return hlCache;
}

export function setHighlight(on: boolean): void {
  if (highlightOn() === on) return;
  hlCache = on;
  write(HL_KEY, on ? '1' : '0');
  emit();
}

export function toggleHighlight(): boolean {
  setHighlight(!highlightOn());
  return highlightOn();
}

/** 是否忽略空白差异（相当于 git diff -w），默认关；只影响 diff 内容，不影响改动列表的统计 */
export function ignoreWs(): boolean {
  if (wsCache === undefined) wsCache = read(WS_KEY) === '1';
  return wsCache;
}

export function setIgnoreWs(on: boolean): void {
  if (ignoreWs() === on) return;
  wsCache = on;
  write(WS_KEY, on ? '1' : '0');
  emit();
}

export function toggleIgnoreWs(): boolean {
  setIgnoreWs(!ignoreWs());
  return ignoreWs();
}

/** 任一偏好变化时回调；返回取消订阅 */
export function onDiffPrefs(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
