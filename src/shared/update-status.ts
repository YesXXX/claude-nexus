/**
 * 更新检查结果与推送载荷类型：主进程与渲染层共用，状态文案也集中在这里，
 * 托盘「检查更新」的系统通知与面板内的检查按钮显示同一套说法。
 */

export type UpdateCheckStatus =
  | 'disabled'          // 开发态不做自动检查
  | 'cooldown'          // 窗口重显的检查在冷却期内，或已有检查在途
  | 'not-configured'    // 未设置更新目录
  | 'no-manifest'       // 更新目录中没有可用的 latest.json
  | 'up-to-date'
  | 'check-failed'
  | 'update-available';

export interface UpdateCheckResult {
  status: UpdateCheckStatus;
  currentVersion: string;
  availableVersion?: string;
  error?: string;
}

/** update:available 推送给渲染层的内容（不含共享目录路径等内部细节） */
export interface UpdateAvailablePayload {
  version: string;
  currentVersion: string;
  notes: string;
  fileName: string;
  fileSize: number;
}

export interface UpdateProgress {
  received: number;
  total: number;
  percent: number;
}

export interface UpdateConfig {
  dir: string | null;
  currentVersion: string;
}

/** 选择或保存更新目录的结果：取消选择时为 null */
export type UpdateDirResult = { ok: true; dir: string } | { ok: false; error: string } | null;

/** 开始安装的结果：started=false 且无 error 表示用户在退出确认里取消了 */
export interface UpdateInstallStart {
  started: boolean;
  error?: string;
}

/** 检查结果的用户可读文案 */
export function describeCheckResult(r: UpdateCheckResult): string {
  switch (r.status) {
    case 'update-available': return `发现新版本 v${r.availableVersion}`;
    case 'up-to-date': return `已是最新版本 v${r.currentVersion}`;
    case 'not-configured': return '尚未设置更新目录';
    case 'no-manifest': return '更新目录中没有可用的 latest.json';
    case 'cooldown': return '正在检查更新，请稍候';
    case 'disabled': return '开发态不自动检查更新';
    default: return r.error || '检查更新失败';
  }
}
