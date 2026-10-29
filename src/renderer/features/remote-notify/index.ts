import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { actionButton, settingRow } from '../../ui/settings-kit.js';
import type { WebhookConfigView } from '../../../shared/webhook-types.js';
import { bindRemoteNotifyDialog, openRemoteNotify } from './settings-dialog.js';

/**
 * 远程通知：把需要关注的通知推送到企业微信 / 钉钉 / 飞书群机器人。
 * 投递在主进程完成，这里只提供设置弹窗、设置页「远程通知」摘要分节与命令面板入口。
 */
export function install(ctx: AppContext): void {
  // 设置页打开期间在弹窗里保存，分节摘要跟着刷新
  let paintSummary: ((v: WebhookConfigView) => void) | null = null;
  bindRemoteNotifyDialog(ctx, v => paintSummary?.(v));
  ctx.registry.registerCommands({
    id: 'remote-notify.palette', order: 530,
    items: () => [{
      section: '命令', icon: '↗', title: '远程通知设置', sub: '推送到企业微信 / 钉钉 / 飞书群机器人',
      keywords: 'yuancheng tongzhi webhook qiye weixin dingding feishu wecom dingtalk feishu remote notify',
      run: () => { void openRemoteNotify(); },
    }],
  });

  ctx.registry.registerSettingsSection({
    id: 'remote-notify.settings', order: 550, title: '远程通知',
    render: () => {
      const body = el('div');
      const state = el('span', 'set-value', '读取中…');
      state.id = 'settings-webhook-state';
      const paint = (v: WebhookConfigView): void => {
        const on = v.targets.filter(t => t.enabled).length;
        if (v.targets.length === 0) state.textContent = '未添加目标';
        else if (!v.enabled) state.textContent = `已关闭（${v.targets.length} 个目标）`;
        else state.textContent = `已开启，${on} / ${v.targets.length} 个目标启用`;
      };
      paintSummary = paint;
      void ctx.api.webhook.getConfig().then(paint).catch(err => {
        state.textContent = `读取失败：${ipcErrorText(err)}`;
      });
      body.append(
        settingRow('推送状态', '需要关注的通知（等待批准或输入、本轮结束、出错、上下文告警等）推送到企业微信 / 钉钉 / 飞书群机器人', state),
        settingRow('修改远程通知', '目标地址、推送事件、离开判定、免打扰时段与节流在弹窗里编辑，可先发测试消息',
          actionButton('打开设置…', () => { void openRemoteNotify(); }, 'settings-webhook-edit')),
      );
      return body;
    },
  });
}
