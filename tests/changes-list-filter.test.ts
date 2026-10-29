import { describe, it, expect } from 'vitest';
import type { ChangedFile } from '../src/shared/types';
import type { SessionChangedFile } from '../src/shared/session-change-types';
import { filterShown, groupKey, matchFiles } from '../src/renderer/features/changes/changes-list';

function sf(abs: string, root: string, outside = false): SessionChangedFile {
  const rel = abs.slice(root.length + 1);
  return {
    path: abs, abs, root, rel, repo: false, outside, source: 'tool', baseline: 'exact', tools: ['Edit'],
    kind: 'modified', additions: 1, deletions: 0, binary: false,
  };
}

const files: ChangedFile[] = [
  sf('D:/p/src/app.ts', 'D:/p'),
  sf('D:/p/src/util/Path.ts', 'D:/p'),
  sf('D:/p/README.md', 'D:/p'),
  sf('E:/other/notes.txt', 'E:/other', true),
];

describe('改动列表过滤', () => {
  it('matchFiles：空词不过滤，多词需同时命中，不区分大小写', () => {
    expect(matchFiles(files, '')).toBe(files);
    expect(matchFiles(files, '   ')).toBe(files);
    expect(matchFiles(files, 'path').map(f => f.path)).toEqual(['D:/p/src/util/Path.ts']);
    expect(matchFiles(files, 'src ts').map(f => f.path)).toEqual(['D:/p/src/app.ts', 'D:/p/src/util/Path.ts']);
    expect(matchFiles(files, 'nothing')).toEqual([]);
  });

  it('filterShown：没有折叠与搜索词时原样返回', () => {
    expect(filterShown(files, true, '', new Set())).toBe(files);
  });

  it('filterShown：折叠分组后该组的行不可导航，其余保留', () => {
    const collapsed = new Set([groupKey(files[0] as SessionChangedFile)]);
    expect(filterShown(files, true, '', collapsed).map(f => f.path)).toEqual(['E:/other/notes.txt']);
  });

  it('filterShown：同一根目录的内外两组分开折叠', () => {
    const inside = sf('D:/p/a.txt', 'D:/p');
    const outside = sf('D:/p/b.txt', 'D:/p', true);
    const collapsed = new Set([groupKey(outside)]);
    expect(filterShown([inside, outside], true, '', collapsed).map(f => f.path)).toEqual(['D:/p/a.txt']);
  });

  it('filterShown：搜索与折叠叠加', () => {
    const collapsed = new Set([groupKey(files[3] as SessionChangedFile)]);
    expect(filterShown(files, true, 'ts', collapsed).map(f => f.path)).toEqual(['D:/p/src/app.ts', 'D:/p/src/util/Path.ts']);
  });

  it('filterShown：仓库视角不应用折叠', () => {
    const collapsed = new Set([groupKey(files[0] as SessionChangedFile)]);
    expect(filterShown(files, false, '', collapsed)).toBe(files);
    expect(filterShown(files, false, 'readme', collapsed).map(f => f.path)).toEqual(['D:/p/README.md']);
  });
});
