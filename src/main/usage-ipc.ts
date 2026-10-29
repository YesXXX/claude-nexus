import { ipcMain } from 'electron';
import type { UsageTracker } from './usage-tracker';
import type { SetUsageSettingsResult, UsageSettings } from '../shared/usage-types';
import { defaultUsageSettings } from '../shared/usage-format';

/**
 * 上下文设置 IPC：读写告警阈值与窗口覆盖。统计关闭时读到默认值、写入返回错误。
 * 会话的上下文摘要不走这里，随 panel:sessions 推送。
 */
export function registerUsageIpc(tracker: UsageTracker | undefined): void {
  ipcMain.handle('usage:get-settings', (): UsageSettings => tracker?.getSettings() ?? defaultUsageSettings());
  ipcMain.handle('usage:set-settings', (_e, input: unknown): SetUsageSettingsResult =>
    tracker ? tracker.setSettings(input) : { ok: false, error: '上下文统计已关闭（CLAUDE_PANEL_USAGE=0）' });
}
