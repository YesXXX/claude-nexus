import { ipcMain, type BrowserWindow } from 'electron';
import type { AppearanceStore } from './appearance-store';
import { skinOf, type SkinId } from '../shared/skins';

/** 标题栏与窗口底色按皮肤取值：系统按钮区由系统绘制，CSS 管不到，换肤时要单独设 */
export function chromeOptions(skin: SkinId): { color: string; symbolColor: string } {
  const s = skinOf(skin);
  return { color: s.chrome, symbolColor: s.symbol };
}

/** 外观偏好的读写 IPC：设置成功后立即改窗口底色与系统按钮颜色，返回生效后的皮肤 */
export function registerAppearanceIpc(deps: { store: AppearanceStore; window: () => BrowserWindow | null }): void {
  const { store } = deps;
  ipcMain.handle('appearance:get', (): { skin: SkinId } => ({ skin: store.skin() }));
  ipcMain.handle('appearance:set', (_e, v: unknown): { ok: boolean; skin: SkinId } => {
    const ok = store.set(v);
    const win = deps.window();
    if (ok && win && !win.isDestroyed()) {
      const c = chromeOptions(store.skin());
      win.setBackgroundColor(c.color);
      win.setTitleBarOverlay(c);
    }
    return { ok, skin: store.skin() };
  });
}
