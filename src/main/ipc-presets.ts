import { ipcMain } from 'electron';
import type { PresetStore } from './preset-store';
import type { PresetSaveResult, SessionPreset } from '../shared/preset';

/** 会话预设 IPC：列表、保存（新建 / 改名 / 更新内容）、删除与使用计数 */
export function registerPresetIpc(deps: { store: PresetStore }): void {
  const { store } = deps;
  ipcMain.handle('presets:list', (): SessionPreset[] => store.list());
  ipcMain.handle('presets:save', (_e, input: unknown): PresetSaveResult => store.save(input));
  ipcMain.handle('presets:remove', (_e, id: unknown): boolean => (typeof id === 'string' ? store.remove(id) : false));
  ipcMain.handle('presets:touch', (_e, id: unknown): SessionPreset | null =>
    (typeof id === 'string' ? store.touch(id) : undefined) ?? null);
}
