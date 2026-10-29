import { ipcMain } from 'electron';
import type { EditorConfigStore } from './editor-config';

/** 外部编辑器命令的读写 IPC：配置存面板数据目录，渲染层跳转与「打开」按钮共用 */
export function registerEditorIpc(deps: { store: EditorConfigStore }): void {
  const { store } = deps;
  ipcMain.handle('editor:get-config', (): { command: string } => ({ command: store.command() }));
  ipcMain.handle('editor:set-config', (
    _e, v: unknown,
  ): { ok: true; command: string } | { ok: false; error: string } => {
    const err = store.set(v);
    return err ? { ok: false, error: err } : { ok: true, command: store.command() };
  });
}
