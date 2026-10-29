import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiffHunk } from '../src/shared/types';
import { buildHunks } from '../src/renderer/features/changes/diff-render';

/**
 * diff 渲染的行定位属性：用最小的假 document 承接元素，断言每行的 data-h / data-i / data-o / data-n，
 * 以及文件内容只经 textContent 写入（假元素没有 innerHTML，一旦被写入会留下记录）。
 */

class FakeEl {
  className = '';
  dataset: Record<string, string> = {};
  children: FakeEl[] = [];
  innerHTMLWrites = 0;
  style = { setProperty: (_k: string, _v: string): void => undefined };
  private ownText = '';
  constructor(readonly tagName: string) {}
  set textContent(v: string) { this.ownText = v; this.children = []; }
  get textContent(): string { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set innerHTML(_v: string) { this.innerHTMLWrites++; }
  append(...cs: FakeEl[]): void {
    for (const c of cs) {
      if (c.tagName === '#fragment') this.children.push(...c.children);
      else this.children.push(c);
    }
  }
  appendChild(c: FakeEl): FakeEl { this.append(c); return c; }
}

const g = globalThis as { document?: unknown };
let saved: unknown;
beforeAll(() => {
  saved = g.document;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createDocumentFragment: () => new FakeEl('#fragment'),
  };
});
afterAll(() => { g.document = saved; });

const hunks: DiffHunk[] = [
  {
    header: '@@ -1,2 +1,2 @@',
    lines: [
      { kind: 'ctx', text: 'a', oldNo: 1, newNo: 1 },
      { kind: 'del', text: '<b>old</b>', oldNo: 2 },
      { kind: 'add', text: '<script>x</script>', newNo: 2 },
    ],
  } as DiffHunk,
  {
    header: '@@ -10 +10 @@',
    lines: [
      { kind: 'add', text: 'z\r', newNo: 10 },
      { kind: 'meta', text: 'No newline at end of file' },
    ],
  } as DiffHunk,
];

describe('diff 渲染的行定位属性', () => {
  it('分块标题带 data-h，每行带分块序号、行序号与旧新行号', () => {
    const code = buildHunks(hunks) as unknown as FakeEl;
    const rows = code.children;
    const heads = rows.filter(r => r.className === 'chg-hunk');
    expect(heads.map(h => h.dataset.h)).toEqual(['0', '1']);
    const lines = rows.filter(r => r.className.startsWith('chg-ln'));
    expect(lines.map(r => [r.dataset.h, r.dataset.i])).toEqual([['0', '0'], ['0', '1'], ['0', '2'], ['1', '0'], ['1', '1']]);
    expect(lines[0].dataset).toMatchObject({ o: '1', n: '1' });
    expect(lines[1].dataset.o).toBe('2');
    expect(lines[1].dataset.n).toBeUndefined();
    expect(lines[2].dataset.n).toBe('2');
    expect(lines[2].dataset.o).toBeUndefined();
    expect(lines[4].className).toBe('chg-ln meta');
    expect(lines[4].dataset.o).toBeUndefined();
  });

  it('文件内容按原文写入文本，不经 innerHTML；行尾 CR 去掉', () => {
    const code = buildHunks(hunks) as unknown as FakeEl;
    const all: FakeEl[] = [];
    const walk = (n: FakeEl): void => { all.push(n); n.children.forEach(walk); };
    walk(code);
    expect(all.every(n => n.innerHTMLWrites === 0)).toBe(true);
    const lines = code.children.filter(r => r.className.startsWith('chg-ln'));
    expect(lines[1].children[3].textContent).toBe('<b>old</b>');
    expect(lines[2].children[3].textContent).toBe('<script>x</script>');
    expect(lines[3].children[3].textContent).toBe('z');
  });
});
