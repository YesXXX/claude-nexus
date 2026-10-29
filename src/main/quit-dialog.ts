import { BrowserWindow, dialog, MessageBoxOptions, MessageBoxSyncOptions } from 'electron';

/** 退出确认的结果：保留会话、结束会话、取消退出 */
export type QuitChoice = 'keep' | 'end' | 'cancel';

const BUTTONS = ['保留会话并退出', '结束会话并退出', '取消'];
const CHOICES: QuitChoice[] = ['keep', 'end', 'cancel'];

function baseOptions(count: number, title: string): MessageBoxSyncOptions {
  return {
    type: 'question',
    title,
    message: `有 ${count} 个会话仍在运行。`,
    detail: '保留会话：下次打开面板可以续接对话。\n结束会话：会话进入历史，之后仍可从历史续接。',
    buttons: BUTTONS,
    // 默认按钮是保留；Esc 等同取消
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
}

function usableWindow(win: BrowserWindow | null): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

/** 退出入口用的异步确认框，带「记住我的选择」勾选框 */
export async function askQuitChoice(win: BrowserWindow | null, count: number): Promise<{ choice: QuitChoice; remember: boolean }> {
  const opts: MessageBoxOptions = {
    ...baseOptions(count, '退出 Claude Nexus'),
    checkboxLabel: '记住我的选择（可在命令面板中修改）',
    checkboxChecked: false,
  };
  const w = usableWindow(win);
  const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
  const choice = CHOICES[r.response] ?? 'cancel';
  return { choice, remember: choice !== 'cancel' && r.checkboxChecked };
}

/** 安装更新路径用的同步确认框：调用方要求同步返回，没有勾选框 */
export function askQuitChoiceSync(win: BrowserWindow | null, count: number): QuitChoice {
  const opts = baseOptions(count, '安装更新');
  const w = usableWindow(win);
  const r = w ? dialog.showMessageBoxSync(w, opts) : dialog.showMessageBoxSync(opts);
  return CHOICES[r] ?? 'cancel';
}
