/**
 * localStorage 读写：最近目录与标签、折叠的父会话、属性面板显隐、多窗格布局。
 * 存储不可用或内容损坏时一律降级为「无记忆」，不抛错。
 */

/** 新建会话历史：最近 5 条 cwd / 标签，由首页的原生 datalist 呈现 */
export const RECENT_CWDS_KEY = 'panel.recentCwds';
export const RECENT_LABELS_KEY = 'panel.recentLabels';
const RECENT_MAX = 5;

const COLLAPSED_SESSIONS_KEY = 'panel.collapsedSessions';
const INSPECTOR_HIDDEN_KEY = 'panel.inspectorHidden';
const LEGACY_CWD_KEY = 'lastCwd';

export function loadRecent(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export function pushRecent(key: string, value: string): void {
  const v = value.trim();
  if (!v) return;
  const next = [v, ...loadRecent(key).filter(x => x !== v)].slice(0, RECENT_MAX);
  try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* 存储不可用则降级 */ }
}

/** 旧版 lastCwd 一次性迁移进历史（迁移后删除旧键；读写都 try/catch，存储不可用则跳过） */
export function migrateLegacyCwd(): void {
  try {
    const legacy = localStorage.getItem(LEGACY_CWD_KEY);
    if (legacy && legacy.trim()) {
      pushRecent(RECENT_CWDS_KEY, legacy);
      localStorage.removeItem(LEGACY_CWD_KEY);
    }
  } catch { /* 存储不可用则跳过迁移 */ }
}

/** 折叠的父会话：仅影响侧栏子代理可见性，跨刷新保留 */
export function loadCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_SESSIONS_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}

export function saveCollapsed(ids: Set<string>): void {
  try { localStorage.setItem(COLLAPSED_SESSIONS_KEY, JSON.stringify([...ids])); } catch { /* 存储不可用则降级 */ }
}

/** 属性面板显隐：跨刷新保留 */
export function loadInspectorHidden(): boolean {
  try { return localStorage.getItem(INSPECTOR_HIDDEN_KEY) === '1'; } catch { return false; }
}

export function saveInspectorHidden(hidden: boolean): void {
  try { localStorage.setItem(INSPECTOR_HIDDEN_KEY, hidden ? '1' : '0'); } catch { /* 存储不可用则降级 */ }
}

const PANE_LAYOUT_KEY = 'nexus.paneLayout';

/** 多窗格布局：返回解析后的 JSON，缺失、损坏或存储不可用时为 null，由调用方回退单窗格 */
export function loadPaneLayoutRaw(): unknown {
  try {
    const raw = localStorage.getItem(PANE_LAYOUT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function savePaneLayoutRaw(json: string): void {
  try { localStorage.setItem(PANE_LAYOUT_KEY, json); } catch { /* 存储不可用则降级 */ }
}
