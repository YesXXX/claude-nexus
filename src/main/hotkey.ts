/** 全局热键候选链：首选保留用户肌肉记忆；其余全部避开 Alt+Shift 系——
    Alt+Shift 本身是 Windows 输入法/键盘布局切换键，疑似本机占用源。 */
export const HOTKEY_CANDIDATES: readonly string[] = ['Alt+Shift+C', 'Ctrl+Alt+C', 'Ctrl+Alt+;'];

/** 逐个尝试注册，返回首个成功的热键；全失败返回 null（调用方负责兜底提示与可见性）。
    tryRegister 注入使本函数不依赖 Electron，可单测。 */
export function pickHotkey(candidates: readonly string[], tryRegister: (accel: string) => boolean): string | null {
  for (const accel of candidates) {
    if (tryRegister(accel)) return accel;
  }
  return null;
}
