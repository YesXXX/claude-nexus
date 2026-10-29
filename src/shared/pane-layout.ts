/**
 * 终端区多窗格布局树。纯函数、不可变更新：所有操作返回新对象，无变化时返回原对象。
 * 叶子是一个窗格（会话 id 或空占位），拆分节点按方向与比例排列 2..4 个子节点。
 * 不变量：叶子总数 1..MAX_PANES；窗格 id 唯一；非空会话 id 在整棵树中唯一。
 */

export type SplitDir = 'row' | 'col';            // row = 左右排列，col = 上下排列
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export type DropZone = Edge | 'center';

export interface PaneLeaf {
  t: 'leaf';
  /** 窗格 id，形如 p1、p2，布局内唯一，与会话无关 */
  id: string;
  /** 会话 id；null 表示空占位 */
  sid: string | null;
  /** 最近一次看到的会话名，会话消失后用于提示原会话名 */
  label?: string;
  /** 空占位记住的原会话名；有值时副行显示「原会话「lost」已不存在」 */
  lost?: string;
}
export interface PaneSplit {
  t: 'split';
  dir: SplitDir;
  /** 与 children 等长的正数，规范化后和为 1 */
  sizes: number[];
  children: PaneNode[];
}
export type PaneNode = PaneLeaf | PaneSplit;
/** focus 为焦点窗格 id */
export interface PaneLayout { root: PaneNode; focus: string }

export const MAX_PANES = 4;
export const LAYOUT_VERSION = 1;
export const MIN_SIZE_FRAC = 0.05;
const MAX_DEPTH = 6;
const MAX_TEXT = 200;
const PANE_ID_RE = /^p[1-9]\d{0,3}$/;

export function singleLayout(sid: string | null): PaneLayout {
  return { root: { t: 'leaf', id: 'p1', sid }, focus: 'p1' };
}

/** 文档顺序：深度优先，子节点从前到后 */
export function leaves(root: PaneNode): PaneLeaf[] {
  const out: PaneLeaf[] = [];
  const walk = (n: PaneNode): void => {
    if (n.t === 'leaf') out.push(n);
    else n.children.forEach(walk);
  };
  walk(root);
  return out;
}

export function leafCount(root: PaneNode): number {
  return leaves(root).length;
}

export function findLeaf(root: PaneNode, paneId: string): PaneLeaf | undefined {
  return leaves(root).find(l => l.id === paneId);
}

export function leafOfSession(root: PaneNode, sid: string): PaneLeaf | undefined {
  return leaves(root).find(l => l.sid === sid);
}

/** 现有 p<n> 的最大 n + 1 */
export function nextPaneId(root: PaneNode): string {
  let max = 0;
  for (const l of leaves(root)) {
    const m = /^p(\d+)$/.exec(l.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `p${max + 1}`;
}

export function edgeDir(edge: Edge): SplitDir {
  return edge === 'left' || edge === 'right' ? 'row' : 'col';
}

/** path 为从根起的 children 下标序列 */
export function nodeAt(root: PaneNode, path: readonly number[]): PaneNode | undefined {
  let n: PaneNode = root;
  for (const i of path) {
    if (n.t !== 'split' || i < 0 || i >= n.children.length) return undefined;
    n = n.children[i];
  }
  return n;
}

/** 窗格在树中的路径；不存在返回 null */
export function pathOfPane(root: PaneNode, paneId: string): number[] | null {
  if (root.t === 'leaf') return root.id === paneId ? [] : null;
  for (let i = 0; i < root.children.length; i++) {
    const sub = pathOfPane(root.children[i], paneId);
    if (sub) return [i, ...sub];
  }
  return null;
}

/** 形状与窗格 id 组成的键，不含会话与比例：用于判断是否需要重建 DOM */
export function structureKey(root: PaneNode): string {
  if (root.t === 'leaf') return root.id;
  return `${root.dir}[${root.children.map(structureKey).join(',')}]`;
}

/** 按路径替换节点，沿途复制父节点 */
function replaceAt(root: PaneNode, path: readonly number[], fn: (n: PaneNode) => PaneNode): PaneNode {
  if (path.length === 0) return fn(root);
  if (root.t !== 'split') return root;
  const [i, ...rest] = path;
  const child = root.children[i];
  if (!child) return root;
  const next = replaceAt(child, rest, fn);
  if (next === child) return root;
  const children = root.children.slice();
  children[i] = next;
  return { ...root, children };
}

/** 能否再拆出一个窗格：拖入的会话已在布局中时，原窗格会关闭，不占名额 */
export function canSplit(layout: PaneLayout, movingSid: string | null): boolean {
  const moving = movingSid !== null && leafOfSession(layout.root, movingSid) ? 1 : 0;
  return leafCount(layout.root) - moving < MAX_PANES;
}

/**
 * 在目标窗格的 edge 一侧拆出新窗格。父节点同方向时作为兄弟插入并对半分目标占比，
 * 否则把目标原位包成新的拆分节点。满格、找不到目标、会话已在布局中时返回 null；焦点不变。
 */
export function splitLeaf(layout: PaneLayout, paneId: string, edge: Edge, sid: string | null): PaneLayout | null {
  const { root } = layout;
  if (leafCount(root) >= MAX_PANES) return null;
  if (sid !== null && leafOfSession(root, sid)) return null;
  const path = pathOfPane(root, paneId);
  if (!path) return null;
  const dir = edgeDir(edge);
  const before = edge === 'left' || edge === 'top';
  const added: PaneLeaf = { t: 'leaf', id: nextPaneId(root), sid };
  const parentPath = path.slice(0, -1);
  const parent = path.length > 0 ? nodeAt(root, parentPath) : undefined;
  if (parent && parent.t === 'split' && parent.dir === dir) {
    const i = path[path.length - 1];
    const half = parent.sizes[i] / 2;
    const children = parent.children.slice();
    const sizes = parent.sizes.slice();
    const at = before ? i : i + 1;
    sizes[i] = half;
    children.splice(at, 0, added);
    sizes.splice(at, 0, half);
    return { root: replaceAt(root, parentPath, () => ({ ...parent, sizes, children })), focus: layout.focus };
  }
  const next = replaceAt(root, path, old => ({
    t: 'split', dir, sizes: [0.5, 0.5], children: before ? [added, old] : [old, added],
  }));
  return { root: next, focus: layout.focus };
}

/**
 * 关闭窗格。只剩一个窗格时改为空占位（id 不变）；否则占比并入前一个兄弟（首个则并入后一个）。
 * 关闭的是焦点时，焦点移到吸收者子树的第一个窗格；它为空占位时取全树第一个有会话的窗格。
 */
export function closeLeaf(layout: PaneLayout, paneId: string): PaneLayout {
  const { root } = layout;
  const leaf = findLeaf(root, paneId);
  if (!leaf) return layout;
  if (root.t === 'leaf') {
    if (leaf.sid === null && leaf.label === undefined && leaf.lost === undefined) return layout;
    return { root: { t: 'leaf', id: leaf.id, sid: null }, focus: layout.focus };
  }
  const path = pathOfPane(root, paneId) as number[];
  const parentPath = path.slice(0, -1);
  const parent = nodeAt(root, parentPath) as PaneSplit;
  const i = path[path.length - 1];
  const children = parent.children.filter((_, k) => k !== i);
  const sizes = parent.sizes.filter((_, k) => k !== i);
  const absorber = i > 0 ? i - 1 : 0;
  sizes[absorber] += parent.sizes[i];
  const absorberFirst = leaves(children[absorber])[0];
  const nextRoot = normalize(replaceAt(root, parentPath, () => ({ ...parent, sizes, children })));
  let focus = layout.focus;
  if (focus === paneId) {
    focus = absorberFirst.id;
    if (absorberFirst.sid === null) {
      const filled = leaves(nextRoot).find(l => l.sid !== null);
      if (filled) focus = filled.id;
    }
  }
  return normalizeLayout({ root: nextRoot, focus });
}

/** 设定窗格会话并清除原会话名；会话已在别的窗格时先关闭那个窗格（即移动） */
export function replaceSession(layout: PaneLayout, paneId: string, sid: string | null): PaneLayout {
  const leaf = findLeaf(layout.root, paneId);
  if (!leaf) return layout;
  if (leaf.sid === sid && (sid !== null || (leaf.lost === undefined && leaf.label === undefined))) return layout;
  let cur = layout;
  if (sid !== null) {
    const other = leafOfSession(cur.root, sid);
    if (other && other.id !== paneId) cur = closeLeaf(cur, other.id);
  }
  const path = pathOfPane(cur.root, paneId);
  if (!path) return layout;
  return { root: replaceAt(cur.root, path, () => ({ t: 'leaf', id: paneId, sid })), focus: cur.focus };
}

/**
 * 把会话放到目标窗格的某个区域：中央为替换（已在布局中则移动），边缘为拆分。
 * 拖到自身所在窗格、满格时拖入新会话到边缘、目标不存在时返回 null。结果焦点为放入会话所在窗格。
 */
export function dropSession(layout: PaneLayout, sid: string, targetPaneId: string, zone: DropZone): PaneLayout | null {
  const target = findLeaf(layout.root, targetPaneId);
  if (!target || target.sid === sid) return null;
  if (zone === 'center') {
    return focusLeaf(replaceSession(layout, targetPaneId, sid), targetPaneId);
  }
  if (!canSplit(layout, sid)) return null;
  let cur = layout;
  const other = leafOfSession(cur.root, sid);
  if (other) cur = closeLeaf(cur, other.id);
  const next = splitLeaf(cur, targetPaneId, zone, sid);
  if (!next) return null;
  const placed = leafOfSession(next.root, sid) as PaneLeaf;
  return { root: next.root, focus: placed.id };
}

/** 不存在的窗格 id 返回原对象 */
export function focusLeaf(layout: PaneLayout, paneId: string): PaneLayout {
  if (layout.focus === paneId || !findLeaf(layout.root, paneId)) return layout;
  return { root: layout.root, focus: paneId };
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function normalizeNode(n: PaneNode): PaneNode | null {
  if (n.t === 'leaf') return n;
  const valid = n.sizes.length === n.children.length && n.sizes.every(x => Number.isFinite(x) && x > 0);
  const base = valid ? n.sizes : n.children.map(() => 1);
  const kids: PaneNode[] = [];
  const raw: number[] = [];
  n.children.forEach((c, i) => {
    const nc = normalizeNode(c);
    if (!nc) return;
    if (nc.t === 'split' && nc.dir === n.dir) {
      nc.children.forEach((g, j) => { kids.push(g); raw.push(base[i] * nc.sizes[j]); });
    } else {
      kids.push(nc);
      raw.push(base[i]);
    }
  });
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  const sum = raw.reduce((a, b) => a + b, 0);
  const sizes = Math.abs(sum - 1) < 1e-9 ? raw : raw.map(x => x / sum);
  if (kids.length === n.children.length && kids.every((k, i) => k === n.children[i]) && sameNumbers(sizes, n.sizes)) {
    return n;
  }
  return { t: 'split', dir: n.dir, sizes, children: kids };
}

/**
 * 规范化（递归、幂等）：删除空拆分、折叠单子节点拆分、同方向嵌套展开进父节点（占比相乘）、
 * 比例非法时等分、否则按和归一。整棵树为空时返回空占位 p1。
 */
export function normalize(root: PaneNode): PaneNode {
  return normalizeNode(root) ?? { t: 'leaf', id: 'p1', sid: null };
}

/** 规范化树并保证焦点指向存在的窗格（不存在时取第一个窗格） */
export function normalizeLayout(layout: PaneLayout): PaneLayout {
  const root = normalize(layout.root);
  const focus = findLeaf(root, layout.focus) ? layout.focus : leaves(root)[0].id;
  if (root === layout.root && focus === layout.focus) return layout;
  return { root, focus };
}

/** 调整拆分节点中第 index 与 index+1 个子节点：两者之和不变，前者占比 fracA（夹到 [0.05, 0.95]） */
export function resizeSplit(root: PaneNode, path: readonly number[], index: number, fracA: number): PaneNode {
  const node = nodeAt(root, path);
  if (!node || node.t !== 'split' || index < 0 || index + 1 >= node.children.length || !Number.isFinite(fracA)) return root;
  const f = Math.min(1 - MIN_SIZE_FRAC, Math.max(MIN_SIZE_FRAC, fracA));
  const total = node.sizes[index] + node.sizes[index + 1];
  const sizes = node.sizes.slice();
  sizes[index] = total * f;
  sizes[index + 1] = total * (1 - f);
  return replaceAt(root, path, () => ({ ...node, sizes }));
}

export function equalizeSplit(root: PaneNode, path: readonly number[]): PaneNode {
  const node = nodeAt(root, path);
  if (!node || node.t !== 'split') return root;
  const n = node.children.length;
  return replaceAt(root, path, () => ({ ...node, sizes: node.children.map(() => 1 / n) }));
}

export function equalizeAll(root: PaneNode): PaneNode {
  if (root.t === 'leaf') return root;
  const n = root.children.length;
  return { ...root, sizes: root.children.map(() => 1 / n), children: root.children.map(equalizeAll) };
}

/** 按叶子逐个改写，没有任何叶子变化时返回原对象 */
function mapLeaves(layout: PaneLayout, fn: (l: PaneLeaf) => PaneLeaf): PaneLayout {
  let changed = false;
  const walk = (n: PaneNode): PaneNode => {
    if (n.t === 'leaf') {
      const r = fn(n);
      if (r !== n) changed = true;
      return r;
    }
    const children = n.children.map(walk);
    return children.every((c, i) => c === n.children[i]) ? n : { ...n, children };
  };
  const root = walk(layout.root);
  return changed ? { root, focus: layout.focus } : layout;
}

/** 刷新叶子记住的会话名；无变化时返回原对象 */
export function withLabels(layout: PaneLayout, labelOf: (sid: string) => string | undefined): PaneLayout {
  return mapLeaves(layout, l => {
    if (l.sid === null) return l;
    const label = labelOf(l.sid);
    if (label === undefined || label === l.label) return l;
    return { ...l, label: label.slice(0, MAX_TEXT) };
  });
}

/** 启动对账：会话已不存在的窗格变为空占位并记住原会话名 */
export function reconcileMissing(layout: PaneLayout, alive: ReadonlySet<string>): PaneLayout {
  return mapLeaves(layout, l => {
    if (l.sid === null || alive.has(l.sid)) return l;
    return { t: 'leaf', id: l.id, sid: null, lost: l.label ?? '未知会话' };
  });
}

/** 运行期会话被移除：多窗格时关闭其窗格，单窗格时变为空占位 */
export function removeSessions(layout: PaneLayout, gone: ReadonlySet<string>): PaneLayout {
  let cur = layout;
  for (const l of leaves(layout.root)) {
    if (l.sid !== null && gone.has(l.sid)) cur = closeLeaf(cur, l.id);
  }
  return cur;
}

function cleanNode(n: PaneNode): PaneNode {
  if (n.t === 'leaf') {
    const leaf: PaneLeaf = { t: 'leaf', id: n.id, sid: n.sid };
    if (n.label !== undefined) leaf.label = n.label;
    if (n.lost !== undefined) leaf.lost = n.lost;
    return leaf;
  }
  return { t: 'split', dir: n.dir, sizes: n.sizes.slice(), children: n.children.map(cleanNode) };
}

/** 单窗格只写空占位：单窗格下切换会话不产生写入 */
export function serializeLayout(layout: PaneLayout): string {
  const { root } = layout;
  if (root.t === 'leaf') {
    return JSON.stringify({ v: LAYOUT_VERSION, focus: root.id, root: { t: 'leaf', id: root.id, sid: null } });
  }
  return JSON.stringify({ v: LAYOUT_VERSION, focus: layout.focus, root: cleanNode(root) });
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function optText(x: unknown): x is string | undefined {
  return x === undefined || (typeof x === 'string' && x.length <= MAX_TEXT);
}

function parseNode(x: unknown, depth: number): PaneNode | null {
  if (depth > MAX_DEPTH || !isObj(x)) return null;
  if (x.t === 'leaf') {
    const { id, sid, label, lost } = x;
    if (typeof id !== 'string' || !PANE_ID_RE.test(id)) return null;
    if (sid !== null && !(typeof sid === 'string' && sid.length >= 1 && sid.length <= MAX_TEXT)) return null;
    if (!optText(label) || !optText(lost)) return null;
    const leaf: PaneLeaf = { t: 'leaf', id, sid };
    if (label !== undefined) leaf.label = label;
    if (lost !== undefined) leaf.lost = lost;
    return leaf;
  }
  if (x.t !== 'split') return null;
  const { dir, sizes, children } = x;
  if (dir !== 'row' && dir !== 'col') return null;
  if (!Array.isArray(children) || children.length === 0 || children.length > MAX_PANES) return null;
  if (!Array.isArray(sizes) || sizes.length !== children.length) return null;
  if (!sizes.every(s => typeof s === 'number' && Number.isFinite(s))) return null;
  const kids: PaneNode[] = [];
  for (const c of children) {
    const k = parseNode(c, depth + 1);
    if (!k) return null;
    kids.push(k);
  }
  return { t: 'split', dir, sizes: sizes.slice() as number[], children: kids };
}

/** 校验持久化数据，任何不合规返回 null；通过后规范化，焦点不存在时取第一个窗格 */
export function parseLayout(raw: unknown): PaneLayout | null {
  if (!isObj(raw) || raw.v !== LAYOUT_VERSION) return null;
  const root = parseNode(raw.root, 1);
  if (!root) return null;
  const all = leaves(root);
  if (all.length < 1 || all.length > MAX_PANES) return null;
  if (new Set(all.map(l => l.id)).size !== all.length) return null;
  const sids = all.map(l => l.sid).filter((s): s is string => s !== null);
  if (new Set(sids).size !== sids.length) return null;
  return normalizeLayout({ root, focus: typeof raw.focus === 'string' ? raw.focus : '' });
}

export function layoutOrDefault(raw: unknown): PaneLayout {
  return parseLayout(raw) ?? singleLayout(null);
}
