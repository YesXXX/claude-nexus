import { describe, it, expect } from 'vitest';
import {
  type PaneLayout, type PaneLeaf, type PaneNode, type PaneSplit,
  singleLayout, leaves, leafCount, findLeaf, leafOfSession, nextPaneId, nodeAt, pathOfPane,
  structureKey, canSplit, splitLeaf, closeLeaf, replaceSession, dropSession, focusLeaf,
  normalize, normalizeLayout, resizeSplit, equalizeSplit, equalizeAll, withLabels,
  reconcileMissing, removeSessions, serializeLayout, parseLayout, layoutOrDefault,
} from '../src/shared/pane-layout';

const leaf = (id: string, sid: string | null, extra: Partial<PaneLeaf> = {}): PaneLeaf => ({ t: 'leaf', id, sid, ...extra });
const split = (dir: 'row' | 'col', sizes: number[], children: PaneNode[]): PaneSplit => ({ t: 'split', dir, sizes, children });
const lay = (root: PaneNode, focus = leaves(root)[0].id): PaneLayout => ({ root, focus });
const ids = (l: PaneLayout): string[] => leaves(l.root).map(x => x.id);
const sids = (l: PaneLayout): Array<string | null> => leaves(l.root).map(x => x.sid);
const near = (a: number[], b: number[]): void => {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9));
};

/** row[col[B,C], col[A,D]] */
function grid(): PaneLayout {
  return lay(split('row', [0.5, 0.5], [
    split('col', [0.5, 0.5], [leaf('p1', 'B'), leaf('p2', 'C')]),
    split('col', [0.5, 0.5], [leaf('p3', 'A'), leaf('p4', 'D')]),
  ]));
}

describe('基础查询', () => {
  it('singleLayout 结构', () => {
    expect(singleLayout('a')).toEqual({ root: { t: 'leaf', id: 'p1', sid: 'a' }, focus: 'p1' });
  });

  it('leaves 文档顺序；leafCount、findLeaf、leafOfSession', () => {
    const g = grid();
    expect(sids(g)).toEqual(['B', 'C', 'A', 'D']);
    expect(leafCount(g.root)).toBe(4);
    expect(findLeaf(g.root, 'p3')?.sid).toBe('A');
    expect(leafOfSession(g.root, 'D')?.id).toBe('p4');
    expect(findLeaf(g.root, 'p9')).toBeUndefined();
  });

  it('nextPaneId 取最大编号 + 1', () => {
    expect(nextPaneId(split('row', [0.5, 0.5], [leaf('p1', 'a'), leaf('p3', 'b')]))).toBe('p4');
    expect(nextPaneId(leaf('p1', null))).toBe('p2');
  });

  it('nodeAt 与 pathOfPane', () => {
    const g = grid();
    expect(pathOfPane(g.root, 'p4')).toEqual([1, 1]);
    expect(nodeAt(g.root, [1, 1])).toBe(findLeaf(g.root, 'p4'));
    expect(nodeAt(g.root, [5])).toBeUndefined();
    expect(pathOfPane(g.root, 'p9')).toBeNull();
  });
});

describe('splitLeaf', () => {
  it('单窗格四个方向：方向、子节点顺序与对半比例，焦点不变', () => {
    const base = singleLayout('a');
    const cases: Array<['left' | 'right' | 'top' | 'bottom', 'row' | 'col', Array<string | null>]> = [
      ['right', 'row', ['a', 'b']], ['left', 'row', ['b', 'a']],
      ['bottom', 'col', ['a', 'b']], ['top', 'col', ['b', 'a']],
    ];
    for (const [edge, dir, order] of cases) {
      const r = splitLeaf(base, 'p1', edge, 'b') as PaneLayout;
      const root = r.root as PaneSplit;
      expect(root.dir).toBe(dir);
      expect(root.sizes).toEqual([0.5, 0.5]);
      expect(sids(r)).toEqual(order);
      expect(leafOfSession(r.root, 'b')?.id).toBe('p2');
      expect(r.focus).toBe('p1');
    }
  });

  it('同方向父节点插入兄弟，只对半分目标占比', () => {
    const l = lay(split('row', [0.6, 0.4], [leaf('p1', 'a'), leaf('p2', 'b')]));
    const r = splitLeaf(l, 'p2', 'right', 'c') as PaneLayout;
    const root = r.root as PaneSplit;
    near(root.sizes, [0.6, 0.2, 0.2]);
    expect(sids(r)).toEqual(['a', 'b', 'c']);
  });

  it('异方向父节点把目标包成新拆分节点', () => {
    const l = lay(split('row', [0.5, 0.5], [leaf('p1', 'a'), leaf('p2', 'b')]));
    const r = splitLeaf(l, 'p2', 'bottom', 'c') as PaneLayout;
    const root = r.root as PaneSplit;
    expect(root.sizes).toEqual([0.5, 0.5]);
    const right = root.children[1] as PaneSplit;
    expect(right.dir).toBe('col');
    expect(right.children.map(c => (c as PaneLeaf).sid)).toEqual(['b', 'c']);
  });

  it('满 4 格、窗格不存在、会话已在布局时返回 null', () => {
    expect(splitLeaf(grid(), 'p1', 'right', 'E')).toBeNull();
    expect(splitLeaf(singleLayout('a'), 'p9', 'right', 'b')).toBeNull();
    expect(splitLeaf(singleLayout('a'), 'p1', 'right', 'a')).toBeNull();
  });

  it('新开空占位', () => {
    const r = splitLeaf(singleLayout('a'), 'p1', 'right', null) as PaneLayout;
    expect(sids(r)).toEqual(['a', null]);
  });
});

describe('closeLeaf', () => {
  it('两格关闭一个回到单窗格', () => {
    const l = lay(split('row', [0.5, 0.5], [leaf('p1', 'a'), leaf('p2', 'b')]));
    const r = closeLeaf(l, 'p2');
    expect(r.root).toEqual(leaf('p1', 'a'));
    expect(r.focus).toBe('p1');
  });

  it('三格关闭中间一个，占比并入前一个；关闭首个并入后一个', () => {
    const l = lay(split('row', [0.5, 0.3, 0.2], [leaf('p1', 'a'), leaf('p2', 'b'), leaf('p3', 'c')]));
    const mid = closeLeaf(l, 'p2').root as PaneSplit;
    near(mid.sizes, [0.8, 0.2]);
    expect(mid.children.map(c => (c as PaneLeaf).id)).toEqual(['p1', 'p3']);
    const first = closeLeaf(l, 'p1').root as PaneSplit;
    near(first.sizes, [0.8, 0.2]);
    expect(first.children.map(c => (c as PaneLeaf).id)).toEqual(['p2', 'p3']);
  });

  it('嵌套关闭后单子节点折叠，且同方向展开', () => {
    const r = closeLeaf(grid(), 'p2');
    const root = r.root as PaneSplit;
    expect(root.dir).toBe('row');
    expect(root.children[0]).toEqual(leaf('p1', 'B'));
    expect(leafCount(r.root)).toBe(3);
  });

  it('关闭焦点：焦点移到吸收者子树的第一个窗格', () => {
    const g = { ...grid(), focus: 'p3' };
    expect(closeLeaf(g, 'p3').focus).toBe('p4');
    const g2 = { ...grid(), focus: 'p4' };
    expect(closeLeaf(g2, 'p4').focus).toBe('p3');
  });

  it('关闭焦点时吸收者为空占位，改取第一个有会话的窗格', () => {
    const l = lay(split('row', [0.4, 0.3, 0.3], [leaf('p1', 'a'), leaf('p2', null), leaf('p3', 'c')]), 'p3');
    expect(closeLeaf(l, 'p3').focus).toBe('p1');
  });

  it('只剩一个窗格：会话置空、id 不变', () => {
    const r = closeLeaf(lay(leaf('p2', 'a', { label: 'A' })), 'p2');
    expect(r.root).toEqual(leaf('p2', null));
    const empty = lay(leaf('p1', null));
    expect(closeLeaf(empty, 'p1')).toBe(empty);
  });
});

describe('replaceSession / dropSession / focusLeaf', () => {
  it('replaceSession 设会话并清原会话名；同会话返回同一对象', () => {
    const l = lay(split('row', [0.5, 0.5], [leaf('p1', 'a'), leaf('p2', null, { lost: 'X' })]));
    const r = replaceSession(l, 'p2', 'b');
    expect(findLeaf(r.root, 'p2')).toEqual(leaf('p2', 'b'));
    expect(replaceSession(r, 'p2', 'b')).toBe(r);
  });

  it('replaceSession 会话已在别的窗格时关闭那个窗格', () => {
    const l = lay(split('row', [0.5, 0.25, 0.25], [leaf('p1', 'a'), leaf('p2', 'b'), leaf('p3', 'c')]));
    const r = replaceSession(l, 'p3', 'a');
    expect(ids(r)).toEqual(['p2', 'p3']);
    expect(sids(r)).toEqual(['b', 'a']);
  });

  it('dropSession 中央：新会话替换，布局内会话移动', () => {
    const l = lay(split('row', [0.5, 0.5], [leaf('p1', 'a'), leaf('p2', 'b')]));
    const rep = dropSession(l, 'x', 'p2', 'center') as PaneLayout;
    expect(sids(rep)).toEqual(['a', 'x']);
    expect(rep.focus).toBe('p2');
    const mv = dropSession(l, 'a', 'p2', 'center') as PaneLayout;
    expect(sids(mv)).toEqual(['a']);
    expect(mv.root).toEqual(leaf('p2', 'a'));
    expect(mv.focus).toBe('p2');
  });

  it('dropSession 边缘：新会话拆分，焦点为放入的窗格', () => {
    const r = dropSession(singleLayout('a'), 'b', 'p1', 'right') as PaneLayout;
    expect(sids(r)).toEqual(['a', 'b']);
    expect(r.focus).toBe(leafOfSession(r.root, 'b')?.id);
  });

  it('dropSession 满 4 格：边缘拖入布局内会话允许，拖入新会话为 null', () => {
    const moved = dropSession(grid(), 'D', 'p1', 'left') as PaneLayout;
    expect(moved).not.toBeNull();
    expect(leafCount(moved.root)).toBe(4);
    expect(sids(moved)[0]).toBe('D');
    expect(moved.focus).toBe(leafOfSession(moved.root, 'D')?.id);
    expect(dropSession(grid(), 'E', 'p1', 'left')).toBeNull();
  });

  it('dropSession 拖到自身所在窗格或不存在的窗格为 null', () => {
    expect(dropSession(grid(), 'B', 'p1', 'right')).toBeNull();
    expect(dropSession(grid(), 'B', 'p1', 'center')).toBeNull();
    expect(dropSession(grid(), 'E', 'p9', 'center')).toBeNull();
  });

  it('canSplit 计入移动', () => {
    expect(canSplit(grid(), 'E')).toBe(false);
    expect(canSplit(grid(), 'A')).toBe(true);
    expect(canSplit(grid(), null)).toBe(false);
    expect(canSplit(singleLayout('a'), null)).toBe(true);
  });

  it('focusLeaf：不存在或已是焦点返回原对象', () => {
    const g = grid();
    expect(focusLeaf(g, 'p9')).toBe(g);
    expect(focusLeaf(g, 'p1')).toBe(g);
    expect(focusLeaf(g, 'p3').focus).toBe('p3');
  });
});

describe('normalize', () => {
  it('单子节点折叠', () => {
    expect(normalize(split('row', [1], [leaf('p1', 'a')]))).toEqual(leaf('p1', 'a'));
  });

  it('同方向嵌套展开且占比相乘', () => {
    const n = normalize(split('row', [0.5, 0.5], [leaf('p1', 'a'), split('row', [0.4, 0.6], [leaf('p2', 'b'), leaf('p3', 'c')])])) as PaneSplit;
    expect(n.children.length).toBe(3);
    near(n.sizes, [0.5, 0.2, 0.3]);
  });

  it('sizes 归一；含 0、负数、长度不符时等分', () => {
    near((normalize(split('row', [2, 6], [leaf('p1', 'a'), leaf('p2', 'b')])) as PaneSplit).sizes, [0.25, 0.75]);
    near((normalize(split('row', [0, 1], [leaf('p1', 'a'), leaf('p2', 'b')])) as PaneSplit).sizes, [0.5, 0.5]);
    near((normalize(split('row', [-1, 1], [leaf('p1', 'a'), leaf('p2', 'b')])) as PaneSplit).sizes, [0.5, 0.5]);
    near((normalize(split('row', [1], [leaf('p1', 'a'), leaf('p2', 'b')])) as PaneSplit).sizes, [0.5, 0.5]);
  });

  it('幂等，已规范的树返回同一对象', () => {
    const once = normalize(split('row', [3, 1], [split('row', [1, 1], [leaf('p1', 'a'), leaf('p2', 'b')]), leaf('p3', 'c')]));
    expect(normalize(once)).toEqual(once);
    expect(normalize(once)).toBe(once);
    const g = grid();
    expect(normalize(g.root)).toBe(g.root);
  });

  it('normalizeLayout 修正不存在的焦点', () => {
    expect(normalizeLayout(lay(leaf('p1', 'a'), 'p7')).focus).toBe('p1');
  });
});

describe('比例调整', () => {
  const two = (): PaneNode => split('row', [0.5, 0.5], [leaf('p1', 'a'), leaf('p2', 'b')]);

  it('resizeSplit 保持两者之和并按比例设置，夹到 [0.05, 0.95]', () => {
    near((resizeSplit(two(), [], 0, 0.62) as PaneSplit).sizes, [0.62, 0.38]);
    near((resizeSplit(two(), [], 0, 0.99) as PaneSplit).sizes, [0.95, 0.05]);
    near((resizeSplit(two(), [], 0, 0) as PaneSplit).sizes, [0.05, 0.95]);
    const three = split('row', [0.5, 0.3, 0.2], [leaf('p1', 'a'), leaf('p2', 'b'), leaf('p3', 'c')]);
    near((resizeSplit(three, [], 1, 0.5) as PaneSplit).sizes, [0.5, 0.25, 0.25]);
  });

  it('resizeSplit 无效路径或下标原样返回', () => {
    const t = two();
    expect(resizeSplit(t, [3], 0, 0.5)).toBe(t);
    expect(resizeSplit(t, [], 1, 0.5)).toBe(t);
    expect(resizeSplit(t, [0], 0, 0.5)).toBe(t);
  });

  it('equalizeSplit 与 equalizeAll', () => {
    const g = lay(split('row', [0.7, 0.3], [leaf('p1', 'a'), split('col', [0.9, 0.1], [leaf('p2', 'b'), leaf('p3', 'c')])]));
    const one = equalizeSplit(g.root, []) as PaneSplit;
    near(one.sizes, [0.5, 0.5]);
    near((one.children[1] as PaneSplit).sizes, [0.9, 0.1]);
    const all = equalizeAll(g.root) as PaneSplit;
    near((all.children[1] as PaneSplit).sizes, [0.5, 0.5]);
  });
});

describe('会话名与对账', () => {
  it('withLabels 更新会话名；无变化返回同一对象', () => {
    const g = grid();
    const names: Record<string, string> = { A: '跑全量 e2e 回归', B: '实现会话预设' };
    const r = withLabels(g, sid => names[sid]);
    expect(findLeaf(r.root, 'p3')?.label).toBe('跑全量 e2e 回归');
    expect(findLeaf(r.root, 'p2')?.label).toBeUndefined();
    expect(withLabels(r, sid => names[sid])).toBe(r);
  });

  it('reconcileMissing：缺失会话变空占位并记住原会话名', () => {
    const l = lay(split('row', [0.5, 0.25, 0.25], [
      leaf('p1', 'a', { label: '甲' }), leaf('p2', 'b', { label: '重构日志模块' }), leaf('p3', 'c'),
    ]));
    const r = reconcileMissing(l, new Set(['a']));
    expect(findLeaf(r.root, 'p1')).toEqual(leaf('p1', 'a', { label: '甲' }));
    expect(findLeaf(r.root, 'p2')).toEqual(leaf('p2', null, { lost: '重构日志模块' }));
    expect(findLeaf(r.root, 'p3')).toEqual(leaf('p3', null, { lost: '未知会话' }));
    expect(reconcileMissing(l, new Set(['a', 'b', 'c']))).toBe(l);
  });

  it('removeSessions：多格关闭、单格置空、焦点转移', () => {
    const g = { ...grid(), focus: 'p3' };
    const r = removeSessions(g, new Set(['A']));
    expect(leafCount(r.root)).toBe(3);
    expect(r.focus).toBe('p4');
    const one = removeSessions(singleLayout('a'), new Set(['a']));
    expect(one.root).toEqual(leaf('p1', null));
    const all = removeSessions(grid(), new Set(['A', 'B', 'C', 'D']));
    expect(leafCount(all.root)).toBe(1);
    expect(sids(all)).toEqual([null]);
  });
});

describe('序列化与校验', () => {
  it('往返深相等', () => {
    const g = withLabels({ ...grid(), focus: 'p3' }, sid => `名${sid}`);
    expect(parseLayout(JSON.parse(serializeLayout(g)))).toEqual(g);
  });

  it('单窗格序列化只写空占位', () => {
    const s = serializeLayout(withLabels(singleLayout('abc'), () => '某会话'));
    expect(s).toBe('{"v":1,"focus":"p1","root":{"t":"leaf","id":"p1","sid":null}}');
  });

  it('parseLayout 拒绝各类坏数据', () => {
    const ok = JSON.parse(serializeLayout(grid())) as Record<string, unknown>;
    const withRoot = (root: unknown): unknown => ({ v: 1, focus: 'p1', root });
    const deep = (d: number): unknown => {
      let n: unknown = { t: 'leaf', id: 'p1', sid: 'a' };
      for (let i = 0; i < d; i++) n = { t: 'split', dir: 'row', sizes: [1], children: [n] };
      return n;
    };
    const five = { t: 'split', dir: 'row', sizes: [1, 1, 1, 1, 1], children: ['p1', 'p2', 'p3', 'p4', 'p5'].map((id, i) => ({ t: 'leaf', id, sid: `s${i}` })) };
    const bad: unknown[] = [
      null, [], 'x', 42, { ...ok, v: 2 },
      withRoot({ t: 'box', id: 'p1', sid: null }),
      withRoot({ t: 'split', dir: 'diag', sizes: [1, 1], children: [leaf('p1', 'a'), leaf('p2', 'b')] }),
      withRoot({ t: 'split', dir: 'row', sizes: [], children: [] }),
      withRoot(five),
      withRoot({ t: 'split', dir: 'row', sizes: [1], children: [leaf('p1', 'a'), leaf('p2', 'b')] }),
      withRoot({ t: 'split', dir: 'row', sizes: [NaN, 1], children: [leaf('p1', 'a'), leaf('p2', 'b')] }),
      withRoot(deep(7)),
      withRoot({ t: 'split', dir: 'row', sizes: [1, 1], children: [
        { t: 'split', dir: 'col', sizes: [1, 1, 1], children: [leaf('p1', 'a'), leaf('p2', 'b'), leaf('p3', 'c')] },
        { t: 'split', dir: 'col', sizes: [1, 1], children: [leaf('p4', 'd'), leaf('p5', 'e')] },
      ] }),
      withRoot({ t: 'split', dir: 'row', sizes: [1, 1], children: [leaf('p1', 'a'), leaf('p1', 'b')] }),
      withRoot({ t: 'leaf', id: 'pane1', sid: 'a' }),
      withRoot({ t: 'leaf', id: 'p0', sid: 'a' }),
      withRoot({ t: 'split', dir: 'row', sizes: [1, 1], children: [leaf('p1', 'a'), leaf('p2', 'a')] }),
      withRoot({ t: 'leaf', id: 'p1', sid: 'x'.repeat(201) }),
      withRoot({ t: 'leaf', id: 'p1', sid: '' }),
      withRoot({ t: 'leaf', id: 'p1', sid: 'a', label: 5 }),
      withRoot({ t: 'leaf', id: 'p1', sid: 'a', lost: 'x'.repeat(201) }),
    ];
    for (const b of bad) expect(parseLayout(b)).toBeNull();
    expect(parseLayout(withRoot(deep(5)))).not.toBeNull();
  });

  it('parseLayout 宽容：焦点不存在取第一个、单子节点折叠、比例含 0 等分', () => {
    expect(parseLayout({ v: 1, focus: 'p9', root: leaf('p2', 'a') })?.focus).toBe('p2');
    expect(parseLayout({ v: 1, root: leaf('p2', 'a') })?.focus).toBe('p2');
    expect(parseLayout({ v: 1, focus: 'p1', root: split('row', [1], [leaf('p1', 'a')]) })?.root).toEqual(leaf('p1', 'a'));
    const z = parseLayout({ v: 1, focus: 'p1', root: split('row', [0, 1], [leaf('p1', 'a'), leaf('p2', 'b')]) });
    near((z?.root as PaneSplit).sizes, [0.5, 0.5]);
  });

  it('layoutOrDefault 对坏数据返回单窗格空占位', () => {
    expect(layoutOrDefault(null)).toEqual(singleLayout(null));
    expect(layoutOrDefault({ v: 3 })).toEqual(singleLayout(null));
  });
});

describe('structureKey', () => {
  it('比例与会话不同而形状与 id 相同时相等，形状不同时不等', () => {
    const a = split('row', [0.5, 0.5], [leaf('p1', 'a'), leaf('p2', 'b')]);
    const b = split('row', [0.7, 0.3], [leaf('p1', 'x'), leaf('p2', null)]);
    const c = split('col', [0.5, 0.5], [leaf('p1', 'a'), leaf('p2', 'b')]);
    expect(structureKey(a)).toBe(structureKey(b));
    expect(structureKey(a)).not.toBe(structureKey(c));
    expect(structureKey(leaf('p1', 'a'))).not.toBe(structureKey(leaf('p2', 'a')));
  });
});
