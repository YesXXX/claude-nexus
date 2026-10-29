import { net, powerMonitor, safeStorage, type BrowserWindow } from 'electron';
import * as os from 'os';
import { isIsolatedInstance, panelHome } from './panel-home';
import { log } from './logger';
import type { NotificationService } from './notification-service';
import { WebhookConfigStore, type SecretCipher } from './webhook-config';
import { WebhookNotifier, type WebhookTransport } from './webhook-notifier';

/**
 * 远程通知接线：配置存储用 safeStorage 加密，传输层用 Electron net.fetch（走系统代理与 PAC），
 * 离开判定用系统空闲时间与锁屏状态，订阅通知服务的出口。
 * 自测相关：CLAUDE_PANEL_WEBHOOK_LOOPBACK_ONLY=1 时拒绝一切非回环目标；隔离实例可用
 * CLAUDE_PANEL_WEBHOOK_AWAY=1 / 0 固定离开判定结果。
 */

export interface WebhookWiringDeps {
  notifications: NotificationService;
  getWindow(): BrowserWindow | null;
  isQuitting(): boolean;
  env?: NodeJS.ProcessEnv;
}

export interface WebhookWiring {
  store: WebhookConfigStore;
  notifier: WebhookNotifier;
}

export const safeStorageCipher: SecretCipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: plain => safeStorage.encryptString(plain).toString('base64'),
  decrypt: b64 => safeStorage.decryptString(Buffer.from(b64, 'base64')),
};

export const netTransport: WebhookTransport = async (url, body, timeoutMs) => {
  const r = await net.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: r.status, text: await r.text() };
};

/** 面板窗口在前台且有焦点时视为在场；否则系统空闲不少于 minutes 分钟或已锁屏视为离开 */
function makeIsAway(getWindow: () => BrowserWindow | null, env: NodeJS.ProcessEnv): (minutes: number) => boolean {
  const forced = isIsolatedInstance() ? env.CLAUDE_PANEL_WEBHOOK_AWAY : undefined;
  if (forced === '1' || forced === '0') {
    log('webhook', `离开判定固定为${forced === '1' ? '离开' : '在场'}（隔离实例）`);
    return () => forced === '1';
  }
  return minutes => {
    const w = getWindow();
    if (w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused()) return false;
    const sec = Math.max(1, Math.round(minutes * 60));
    try {
      return powerMonitor.getSystemIdleState(sec) === 'locked' || powerMonitor.getSystemIdleTime() >= sec;
    } catch (err) {
      log('webhook', `读取系统空闲状态失败，按在场处理：${String(err)}`);
      return false;
    }
  };
}

export function createWebhookWiring(deps: WebhookWiringDeps): WebhookWiring {
  const env = deps.env ?? process.env;
  const store = new WebhookConfigStore(WebhookConfigStore.fileIn(panelHome()), safeStorageCipher);
  const loopbackOnly = env.CLAUDE_PANEL_WEBHOOK_LOOPBACK_ONLY === '1';
  if (loopbackOnly) log('webhook', '只允许回环目标（CLAUDE_PANEL_WEBHOOK_LOOPBACK_ONLY=1）');
  const notifier = new WebhookNotifier({
    config: () => store.get(),
    transport: netTransport,
    isAway: makeIsAway(deps.getWindow, env),
    isQuitting: deps.isQuitting,
    loopbackOnly,
    hostname: os.hostname(),
    log: msg => log('webhook', msg),
  });
  deps.notifications.subscribe(n => {
    notifier.onNotification(n).catch(err => log('webhook', `投递异常：${String(err)}`));
  });
  return { store, notifier };
}
