import { describe, expect, it } from 'vitest';
import {
  MAX_INTRALINE, intraline, mergeSegments, pairChanges, splitWords, type Range,
} from '../src/shared/word-diff';
import type { DiffLine } from '../src/shared/types';

const L = (kind: DiffLine['kind'], text = kind): DiffLine => ({ kind, text });
const slices = (text: string, rs: Range[]): string[] => rs.map(r => text.slice(r.s, r.e));

describe('pairChanges 修改块配对', () => {
  it('删多增少：多出的删除行不配对', () => {
    const lines = [L('ctx'), L('del'), L('del'), L('del'), L('add'), L('ctx')];
    expect(pairChanges(lines)).toEqual([{ del: 1, add: 4 }]);
  });

  it('增多删少：多出的新增行不配对', () => {
    const lines = [L('del'), L('add'), L('add'), L('add')];
    expect(pairChanges(lines)).toEqual([{ del: 0, add: 1 }]);
  });

  it('中间夹上下文时分成两个修改块', () => {
    const lines = [L('del'), L('del'), L('add'), L('ctx'), L('del'), L('add'), L('add')];
    expect(pairChanges(lines)).toEqual([{ del: 0, add: 2 }, { del: 4, add: 5 }]);
  });

  it('纯新增、纯删除不配对；元信息行跳过', () => {
    expect(pairChanges([L('add'), L('add'), L('ctx')])).toEqual([]);
    expect(pairChanges([L('ctx'), L('del'), L('ctx')])).toEqual([]);
    expect(pairChanges([L('del'), L('meta'), L('add'), L('meta')])).toEqual([{ del: 0, add: 2 }]);
  });
});

describe('intraline 词级差异', () => {
  it('只改一个标识符时变化区间只覆盖该标识符', () => {
    const a = 'const cache = new Map();';
    const b = 'const cache = new LruCache();';
    const r = intraline(a, b);
    expect(r).not.toBeNull();
    expect(slices(a, r!.del)).toEqual(['Map']);
    expect(slices(b, r!.add)).toEqual(['LruCache']);
  });

  it('多处变化分别给出区间，相邻的变化词合并', () => {
    const a = 'call(alpha, beta)';
    const b = 'call(alpha, gamma.delta)';
    const r = intraline(a, b)!;
    expect(slices(a, r.del)).toEqual(['beta']);
    expect(slices(b, r.add)).toEqual(['gamma.delta']);
    const r2 = intraline('foo(x) + 1', 'bar(x) + 2')!;
    expect(slices('foo(x) + 1', r2.del)).toEqual(['foo', '1']);
  });

  it('中日韩文字按单字切分', () => {
    expect(splitWords('改动面板abc好')).toEqual(['改', '动', '面', '板', 'abc', '好']);
    const a = '会话标签已更新';
    const b = '会话名称已更新';
    const r = intraline(a, b)!;
    expect(slices(a, r.del)).toEqual(['标签']);
    expect(slices(b, r.add)).toEqual(['名称']);
  });

  it('相似度低于阈值时返回 null（整行重写）', () => {
    expect(intraline('return repo.findAll();', 'throw new Error("x")')).toBeNull();
  });

  it('超过长度上限返回 null', () => {
    const a = 'x '.repeat(MAX_INTRALINE / 2 + 1);
    expect(intraline(a, a + 'y')).toBeNull();
    expect(intraline('a b', 'a c', 2)).toBeNull();
  });

  it('编辑距离超过上限放弃', () => {
    const words = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join(' ');
    // 隔一个词改一个：相似度仍高，但 300 个词有 150 处替换，编辑距离 300 超过上限
    const a = words(300, i => `a${i}`);
    const b = words(300, i => (i % 2 ? `a${i}` : `b${i}`));
    expect(intraline(a, b, 10_000)).toBeNull();
    // 同样的改法在 60 个词内，编辑距离 60，可以给出区间
    expect(intraline(words(60, i => `a${i}`), words(60, i => (i % 2 ? `a${i}` : `b${i}`)), 10_000)).not.toBeNull();
  });

  it('完全相同返回空区间；一侧为空时整行变化', () => {
    expect(intraline('same', 'same')).toEqual({ del: [], add: [] });
    expect(intraline('', 'abc')).toBeNull();
  });

  it('代理对字符不被切断', () => {
    const a = 'ok 😀 done';
    const b = 'ok 😎 done';
    const r = intraline(a, b)!;
    expect(slices(a, r.del)).toEqual(['😀']);
    expect(slices(b, r.add)).toEqual(['😎']);
  });
});

describe('mergeSegments 区间合并', () => {
  it('语法区间与变化区间交叠时切成连续片段', () => {
    const segs = mergeSegments(10, [{ s: 0, e: 5, k: 'kw' }], [{ s: 3, e: 8 }]);
    expect(segs).toEqual([
      { s: 0, e: 3, k: 'kw' },
      { s: 3, e: 5, k: 'kw', mark: true },
      { s: 5, e: 8, mark: true },
      { s: 8, e: 10 },
    ]);
  });

  it('没有区间时整行一个片段；空行没有片段', () => {
    expect(mergeSegments(4, [], [])).toEqual([{ s: 0, e: 4 }]);
    expect(mergeSegments(0, [{ s: 0, e: 1, k: 'str' }], [])).toEqual([]);
  });

  it('越界区间被截断，片段首尾相接覆盖整行', () => {
    const segs = mergeSegments(6, [{ s: 2, e: 4, k: 'num' }, { s: 4, e: 20, k: 'com' }], [{ s: 5, e: 9 }]);
    expect(segs[0].s).toBe(0);
    expect(segs[segs.length - 1].e).toBe(6);
    for (let i = 1; i < segs.length; i++) expect(segs[i].s).toBe(segs[i - 1].e);
    expect(segs).toEqual([
      { s: 0, e: 2 }, { s: 2, e: 4, k: 'num' }, { s: 4, e: 5, k: 'com' }, { s: 5, e: 6, k: 'com', mark: true },
    ]);
  });

  it('属性相同的相邻片段合并', () => {
    const segs = mergeSegments(6, [{ s: 0, e: 2, k: 'str' }, { s: 2, e: 4, k: 'str' }], [{ s: 0, e: 2 }, { s: 2, e: 3 }]);
    expect(segs).toEqual([{ s: 0, e: 3, k: 'str', mark: true }, { s: 3, e: 4, k: 'str' }, { s: 4, e: 6 }]);
  });
});
