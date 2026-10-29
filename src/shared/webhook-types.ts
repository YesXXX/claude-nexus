import type { NotifyKind } from './types';

/**
 * 远程通知（群机器人 webhook）的配置与 IPC 数据结构，主进程、preload 与渲染层共用。
 * 渲染层只拿到脱敏视图：URL 打码、secret 只给是否已设置。
 */

export type WebhookPlatform = 'wecom' | 'dingtalk' | 'feishu';

export const WEBHOOK_PLATFORMS: readonly WebhookPlatform[] = ['wecom', 'dingtalk', 'feishu'];

export const WEBHOOK_PLATFORM_TEXT: Record<WebhookPlatform, string> = {
  wecom: '企业微信', dingtalk: '钉钉', feishu: '飞书',
};

export const WEBHOOK_MAX_TARGETS = 5;

export interface WebhookTarget {
  id: string;
  name: string;
  platform: WebhookPlatform;
  enabled: boolean;
  url: string;
  /** 钉钉 / 飞书加签密钥，可选 */
  secret?: string;
}

export interface WebhookQuiet {
  enabled: boolean;
  /** HH:mm，可跨零点 */
  start: string;
  end: string;
}

export interface WebhookConfig {
  version: 1;
  enabled: boolean;
  targets: WebhookTarget[];
  events: Record<NotifyKind, boolean>;
  when: 'away' | 'always';
  awayMinutes: number;
  quiet: WebhookQuiet;
  throttleSec: number;
  includeSummary: boolean;
}

/** 给渲染层的目标视图：URL 脱敏，secret 只给是否已设置 */
export interface WebhookTargetView extends Omit<WebhookTarget, 'url' | 'secret'> {
  urlMasked: string;
  hasSecret: boolean;
}

export interface WebhookSendResult {
  targetId: string;
  ok: boolean;
  status?: number;
  error?: string;
  ms: number;
  at: number;
}

export interface WebhookConfigView extends Omit<WebhookConfig, 'targets'> {
  targets: WebhookTargetView[];
  /** 系统加密是否可用；不可用时 URL 与 secret 以明文保存 */
  encryptionAvailable: boolean;
  /** 各目标最近一次投递或测试的结果 */
  lastResults: Record<string, WebhookSendResult>;
  /** 处于熔断中的目标与恢复时间 */
  circuitOpenUntil: Record<string, number>;
}

/**
 * 渲染层提交的目标：url 为空或等于脱敏值表示沿用已保存的值；secret 为空表示沿用，
 * clearSecret 为真时删除已保存的 secret。新目标不带 id 或带渲染层生成的临时 id。
 */
export interface WebhookTargetDraft {
  id?: string;
  name: string;
  platform: WebhookPlatform;
  enabled: boolean;
  url: string;
  secret?: string;
  clearSecret?: boolean;
}

export interface WebhookConfigDraft extends Omit<WebhookConfig, 'version' | 'targets'> {
  targets: WebhookTargetDraft[];
}

/** 保存结果：errors 的键为字段路径，如 targets.0.url、quiet.start */
export type WebhookSaveResult = { ok: true; config: WebhookConfigView } | { ok: false; errors: Record<string, string> };

/** 测试消息：onlyTargetId 为空时发给所有启用的目标 */
export interface WebhookTestInput {
  draft: WebhookConfigDraft;
  onlyTargetId?: string;
}

export type WebhookTestResult = { ok: true; results: WebhookSendResult[] } | { ok: false; errors: Record<string, string> };

/** 设置界面上的事件勾选项与对应的通知种类 */
export const WEBHOOK_EVENT_GROUPS: ReadonlyArray<{ key: string; text: string; kinds: NotifyKind[] }> = [
  { key: 'permission', text: '等待批准', kinds: ['permission'] },
  { key: 'input', text: '等待输入', kinds: ['input'] },
  { key: 'turn', text: '本轮结束', kinds: ['turn', 'ended'] },
  { key: 'error', text: '出错 / 失联', kinds: ['error', 'lost'] },
  { key: 'budget', text: '上下文告警', kinds: ['budget'] },
  { key: 'overdue', text: '等待超时', kinds: ['overdue'] },
];
