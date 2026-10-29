import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SKINS, DEFAULT_SKIN, isSkinId, skinOf } from '../src/shared/skins';

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

/** 解析顶层「:root」与「:root[data-skin="id"]」块的变量声明，键为 ':root' 或皮肤 id */
function parseBlocks(css: string): Map<string, Map<string, string>> {
  const text = css.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map<string, Map<string, string>>();
  for (const m of text.matchAll(/(^|\n)(:root(?:\[data-skin="([\w-]+)"\])?)\s*\{([\s\S]*?)\n\}/g)) {
    const key = m[3] ?? ':root';
    const vars = new Map<string, string>();
    for (const d of m[4].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(d[1], d[2].trim());
    out.set(key, vars);
  }
  return out;
}

const rootCss = parseBlocks(fs.readFileSync(path.join(RENDERER, 'renderer.css'), 'utf8'));
const skinCss = parseBlocks(fs.readFileSync(path.join(RENDERER, 'skins.css'), 'utf8'));
const root = rootCss.get(':root')!;

/** :root 里写着颜色字面量的变量：换肤时每套皮肤都必须覆盖 */
const colorVars = [...root].filter(([k, v]) =>
  k.endsWith('-rgb') || /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/.test(v)).map(([k]) => k);

/** 某皮肤下变量的最终取值（皮肤块覆盖，否则继承 :root） */
function valueOf(id: string, name: string): string | undefined {
  return skinCss.get(id)?.get(name) ?? root.get(name);
}

function hexToTriple(hex: string): string {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).join(' ');
}

describe('皮肤清单', () => {
  it('默认皮肤是石墨且在清单首位，id 唯一', () => {
    expect(DEFAULT_SKIN).toBe('graphite');
    expect(SKINS[0].id).toBe(DEFAULT_SKIN);
    expect(new Set(SKINS.map(s => s.id)).size).toBe(SKINS.length);
  });

  it('isSkinId 只认清单里的 id，skinOf 对未知值回退默认', () => {
    expect(isSkinId('midnight')).toBe(true);
    expect(isSkinId('light')).toBe(false);
    expect(isSkinId(undefined)).toBe(false);
    expect(skinOf('warm').id).toBe('warm');
    expect(skinOf('nope').id).toBe(DEFAULT_SKIN);
    expect(skinOf(42).id).toBe(DEFAULT_SKIN);
  });
});

describe('skins.css 与清单一致', () => {
  it('解析到 :root 里足够多的颜色变量（防止解析规则失效后断言空转）', () => {
    expect(colorVars.length).toBeGreaterThan(60);
    expect(colorVars).toContain('--chrome');
    expect(colorVars).toContain('--term-bright-white');
  });

  it('除石墨外每套皮肤都有块，且没有清单之外的块', () => {
    const want = SKINS.filter(s => s.id !== DEFAULT_SKIN).map(s => s.id).sort();
    expect([...skinCss.keys()].sort()).toEqual(want);
  });

  it.each(SKINS.filter(s => s.id !== DEFAULT_SKIN).map(s => [s.id]))('%s 覆盖了全部颜色变量，且不引入 :root 没有的变量', id => {
    const block = skinCss.get(id)!;
    expect(colorVars.filter(k => !block.has(k))).toEqual([]);
    expect([...block.keys()].filter(k => !root.has(k))).toEqual([]);
  });

  it.each(SKINS.map(s => [s.id, s]))('%s 的标题栏底色与预览色和 CSS 一致', (id, s) => {
    expect(valueOf(id, '--chrome')).toBe(s.chrome);
    expect(s.preview.chrome).toBe(s.chrome);
    expect(valueOf(id, '--panel')).toBe(s.preview.panel);
    expect(valueOf(id, '--term-bg')).toBe(s.preview.term);
    expect(valueOf(id, '--btn-pri-bg')).toBe(s.preview.accent);
    expect(s.symbol).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(SKINS.map(s => [s.id]))('%s 的 -rgb 三元组与同名颜色一致，终端底色与 --term-bg 一致', id => {
    for (const k of colorVars.filter(n => n.endsWith('-rgb'))) {
      const base = valueOf(id, k.slice(0, -4));
      if (base === undefined) continue;   // --fg-rgb / --shade-rgb 没有同名颜色
      expect(`${k} ${valueOf(id, k)}`).toBe(`${k} ${hexToTriple(base)}`);
    }
    expect(valueOf(id, '--term-background')).toBe(valueOf(id, '--term-bg'));
  });

  it.each(SKINS.map(s => [s.id]))('%s 的搜索高亮色是 #RRGGBB（xterm 装饰只接受这种格式）', id => {
    for (const k of ['--search-match-bg', '--search-match-ruler', '--search-active-bg', '--search-active-border']) {
      expect(valueOf(id, k)).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});
