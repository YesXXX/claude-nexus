import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadWindowState, saveBounds, intersectsWorkArea, isOnscreen, WindowBounds } from '../src/main/window-state';

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-ws-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('loadWindowState', () => {
  it('文件缺失 → 默认 1200x780、x/y=-1（系统居中）', () => {
    const st = loadWindowState(path.join(dir, 'nope.json'));
    expect(st).toEqual({ width: 1200, height: 780, x: -1, y: -1, maximized: false });
  });
  it('损坏 JSON → 默认，不抛错', () => {
    const f = path.join(dir, 'bad.json');
    fs.writeFileSync(f, '{oops');
    expect(loadWindowState(f).width).toBe(1200);
  });
  it('尺寸过小（<400x300）→ 默认', () => {
    const f = path.join(dir, 'tiny.json');
    fs.writeFileSync(f, JSON.stringify({ width: 100, height: 780, maximized: false }));
    expect(loadWindowState(f).width).toBe(1200);
  });
  it('1e999（Infinity）宽度 → 默认（Number.isFinite 拦截）', () => {
    const f = path.join(dir, 'inf.json');
    // 注意：JSON.stringify(1e999) 会序列化成 null，必须手写字面 JSON 才能真正喂进 Infinity
    fs.writeFileSync(f, '{"width":1e999,"height":780,"maximized":false}');
    expect(loadWindowState(f).width).toBe(1200);
  });
  it('正常往返 save → load', () => {
    const f = path.join(dir, 'ok.json');
    saveBounds(f, { x: 10, y: 20, width: 900, height: 600, maximized: true });
    expect(loadWindowState(f)).toEqual({ x: 10, y: 20, width: 900, height: 600, maximized: true });
  });
});

describe('intersectsWorkArea（越界检测）', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const b = (o: Partial<WindowBounds>): WindowBounds => ({ x: 0, y: 0, width: 800, height: 600, maximized: false, ...o });
  it('完全在屏内 → true', () => {
    expect(intersectsWorkArea(b({ x: 100, y: 100 }), wa)).toBe(true);
  });
  it('部分在屏内 → true（半跨显示器仍可见）', () => {
    expect(intersectsWorkArea(b({ x: 1500, y: 100 }), wa)).toBe(true);
  });
  it('完全在屏外（显示器已拔）→ false', () => {
    expect(intersectsWorkArea(b({ x: 3000, y: 2000 }), wa)).toBe(false);
  });
  it('边缘贴合（零重叠）→ false（严格不等式，防 <= 回归）', () => {
    expect(intersectsWorkArea(b({ x: 1920, y: 0 }), wa)).toBe(false);
  });
  it('单轴越界（x 在屏内、y 屏外）→ false', () => {
    expect(intersectsWorkArea(b({ x: 100, y: 2000 }), wa)).toBe(false);
  });
});

describe('isOnscreen（负坐标修复 M1）', () => {
  // 主屏 1920x1040 在原点，副屏在左侧：workArea x=-1920
  const displays = [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: -1920, y: 0, width: 1920, height: 1040 },
  ];
  const b = (o: Partial<WindowBounds>): WindowBounds => ({ x: 0, y: 0, width: 800, height: 600, maximized: false, ...o });
  it('负坐标落在左侧副屏 → true（本修复的主场景）', () => {
    expect(isOnscreen(b({ x: -1500, y: 100 }), displays)).toBe(true);
  });
  it('负坐标但与任何显示器不相交 → false（副屏已拔）', () => {
    expect(isOnscreen(b({ x: -3000, y: 2000 }), displays)).toBe(false);
  });
  it('x/y = -1 是「未记录位置」哨兵 → false（交系统居中）', () => {
    expect(isOnscreen(b({ x: -1, y: -1 }), displays)).toBe(false);
  });
  it('正坐标在主屏内 → true（回归）', () => {
    expect(isOnscreen(b({ x: 100, y: 100 }), displays)).toBe(true);
  });
  it('单轴哨兵：x 合法但 y=-1 → false（loadWindowState 用 -1,-1 表示未记录，任一轴为 -1 都按哨兵处理）', () => {
    expect(isOnscreen(b({ x: 500, y: -1 }), displays)).toBe(false);
    expect(isOnscreen(b({ x: -1, y: 500 }), displays)).toBe(false);
  });
  it('纵向隔离：x 落在副屏横向范围内但 y 完全出界 → false（证明 false 来自纵向不相交而非 x 判负）', () => {
    expect(isOnscreen(b({ x: -1500, y: 5000 }), displays)).toBe(false);
  });
});
