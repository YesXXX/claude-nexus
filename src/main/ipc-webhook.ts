import { ipcMain } from 'electron';
import type {
  WebhookConfigDraft, WebhookConfigView, WebhookSaveResult, WebhookTestInput, WebhookTestResult,
} from '../shared/webhook-types';
import { mergeDraft, type WebhookConfigStore } from './webhook-config';
import type { WebhookNotifier } from './webhook-notifier';

/**
 * 远程通知设置的 IPC：读取脱敏配置、校验保存、用表单当前值发送测试消息。
 * 校验规则只在主进程一处（mergeDraft），渲染层按返回的逐字段错误显示。
 */

export interface WebhookIpcDeps {
  store: WebhookConfigStore;
  notifier: WebhookNotifier;
}

export function webhookView(deps: WebhookIpcDeps): WebhookConfigView {
  const { targets: _targets, ...rest } = deps.store.get();
  return {
    ...rest,
    targets: deps.store.views(),
    encryptionAvailable: deps.store.encryptionAvailable(),
    lastResults: deps.notifier.lastResults(),
    circuitOpenUntil: deps.notifier.circuitOpenUntil(),
  };
}

export function saveWebhookConfig(deps: WebhookIpcDeps, draft: WebhookConfigDraft): WebhookSaveResult {
  const r = deps.store.save(draft);
  if (!r.ok) return r;
  deps.notifier.forget(deps.store.get().targets.map(t => t.id));
  return { ok: true, config: webhookView(deps) };
}

/**
 * 测试消息只关心目标本身：取要测的目标（指定的一个，或全部启用的），其余字段用已保存值补齐后
 * 走同一套合并校验，secret 留空时沿用已保存值。错误键里的目标下标换回表单中的原始下标。
 */
export async function testWebhook(deps: WebhookIpcDeps, input: WebhookTestInput): Promise<WebhookTestResult> {
  const draft = input?.draft;
  if (!draft || !Array.isArray(draft.targets)) return { ok: false, errors: { form: '提交的内容无效' } };
  const picked: number[] = [];
  draft.targets.forEach((t, i) => {
    if (input.onlyTargetId ? t.id === input.onlyTargetId : t.enabled !== false) picked.push(i);
  });
  if (picked.length === 0) {
    return { ok: false, errors: { form: input.onlyTargetId ? '找不到要测试的目标' : '没有启用的目标' } };
  }
  const current = deps.store.get();
  const r = mergeDraft(current, {
    enabled: current.enabled, events: current.events, when: current.when, awayMinutes: current.awayMinutes,
    quiet: current.quiet, throttleSec: current.throttleSec, includeSummary: current.includeSummary,
    targets: picked.map(i => draft.targets[i]),
  });
  if (!r.ok) {
    const errors: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.errors)) {
      const m = /^targets\.(\d+)\.(.+)$/.exec(k);
      errors[m ? `targets.${picked[Number(m[1])]}.${m[2]}` : k] = v;
    }
    return { ok: false, errors };
  }
  return { ok: true, results: await deps.notifier.test(r.config.targets) };
}

export function registerWebhookIpc(deps: WebhookIpcDeps): void {
  ipcMain.handle('webhook:get-config', () => webhookView(deps));
  ipcMain.handle('webhook:set-config', (_e, draft: WebhookConfigDraft) => saveWebhookConfig(deps, draft));
  ipcMain.handle('webhook:test', (_e, input: WebhookTestInput) => testWebhook(deps, input));
}
