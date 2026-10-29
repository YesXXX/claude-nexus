import * as fs from 'fs';

/** 窗口状态快照；x/y = -1 表示未记录位置（交给系统居中） */
export interface WindowBounds {
  x: number; y: number; width: number; height: number; maximized: boolean;
}

export const DEFAULT_BOUNDS: WindowBounds = { width: 1200, height: 780, x: -1, y: -1, maximized: false };

/** Number.isFinite 不自带类型收窄，包一层守卫供下方校验使用（同时挡 NaN/Infinity 与非数字） */
function isFiniteNumber(v: unknown): v is number {
  return Number.isFinite(v);
}

/** 读取窗口状态；文件缺失/损坏/字段非法一律静默回退默认（不 fatal） */
export function loadWindowState(file: string): WindowBounds {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WindowBounds>;
    if (
      isFiniteNumber(raw.width) && raw.width >= 400 &&
      isFiniteNumber(raw.height) && raw.height >= 300 &&
      typeof raw.maximized === 'boolean'
    ) {
      return {
        width: raw.width, height: raw.height, maximized: raw.maximized,
        x: isFiniteNumber(raw.x) ? raw.x : -1,
        y: isFiniteNumber(raw.y) ? raw.y : -1,
      };
    }
  } catch { /* 缺失/损坏 → 默认 */ }
  return { ...DEFAULT_BOUNDS };
}

/** 落盘（写入失败会抛出，由调用方 try/catch；bounds 由调用方从 BrowserWindow 提取，保持本模块无 Electron 依赖） */
export function saveBounds(file: string, b: WindowBounds): void {
  fs.writeFileSync(file, JSON.stringify(b, null, 2));
}

/** 纯几何矩形（显示器 workArea 等）；WindowBounds 在其上加 maximized 快照位 */
type Rect = { x: number; y: number; width: number; height: number };

/** 窗口矩形与工作区是否相交（任一显示器相交即视为可见；全不相交 = 显示器已拔，回退默认） */
export function intersectsWorkArea(
  b: WindowBounds,
  workArea: Rect,
): boolean {
  return b.x < workArea.x + workArea.width && b.x + b.width > workArea.x &&
    b.y < workArea.y + workArea.height && b.y + b.height > workArea.y;
}

/** 窗口是否仍落在任一显示器上（供 createWindow 判定复用记录的位置）。
    x/y = -1 是 loadWindowState 的「未记录」哨兵，直接判不在屏（交系统居中）；
    注意不得要求 x/y >= 0——副显示器在主屏左侧/上方时合法坐标为负（M1）。
    权衡：x/y 任一为 -1 即按哨兵判不在屏——牺牲了恰好在 -1 像素的合法位置（1px 窄条，可接受）换取与 loadWindowState 哨兵语义一致。 */
export function isOnscreen(
  b: WindowBounds,
  workAreas: Array<Rect>,
): boolean {
  if (b.x === -1 || b.y === -1) return false;
  return workAreas.some(wa => intersectsWorkArea(b, wa));
}
