import { describe, it, expect, vi } from 'vitest';
import { HOTKEY_CANDIDATES, pickHotkey } from '../src/main/hotkey';

describe('pickHotkey（热键降级链）', () => {
  it('首选注册成功 → 返回首选', () => {
    const tryRegister = vi.fn(() => true);
    expect(pickHotkey(HOTKEY_CANDIDATES, tryRegister)).toBe('Alt+Shift+C');
    expect(tryRegister).toHaveBeenCalledTimes(1);
  });
  it('首选被占用 → 降级到下一个成功者', () => {
    const tryRegister = vi.fn((a: string) => a !== 'Alt+Shift+C');
    expect(pickHotkey(HOTKEY_CANDIDATES, tryRegister)).toBe('Ctrl+Alt+C');
    expect(tryRegister).toHaveBeenCalledTimes(2);
  });
  it('全部候选失败 → null', () => {
    expect(pickHotkey(HOTKEY_CANDIDATES, () => false)).toBeNull();
  });
  it('空候选列表 → null（不调用注册）', () => {
    const tryRegister = vi.fn(() => true);
    expect(pickHotkey([], tryRegister)).toBeNull();
    expect(tryRegister).not.toHaveBeenCalled();
  });
  it('候选链除首选外全部避开 Alt+Shift 系（Windows 输入法切换键，疑似占用源）', () => {
    expect(HOTKEY_CANDIDATES.slice(1).every(a => !a.includes('Alt+Shift'))).toBe(true);
  });
  it('候选链无重复项（重复候选浪费重试且无意义）', () => {
    expect(new Set(HOTKEY_CANDIDATES).size).toBe(HOTKEY_CANDIDATES.length);
  });
});
