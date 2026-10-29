import type { AppContext } from '../../core/context.js';
import { el } from '../../core/dom.js';
import { actionButton, settingRow } from '../../ui/settings-kit.js';
import { installUsageSection } from './inspector-section.js';
import { bindSettingsDialog, openUsageSettings, reloadUsageSettings, usageSettings } from './settings-dialog.js';

/**
 * 上下文：属性面板的「上下文」节、上下文设置弹窗、设置页「上下文」分节与命令面板入口。
 * 数据全部来自主进程：各会话的上下文摘要随会话列表推送，设置走 usage IPC。
 */
export function install(ctx: AppContext): void {
  // 设置页打开期间用弹窗改了设置，分节里的摘要跟着刷新
  let paintSummary: (() => void) | null = null;
  bindSettingsDialog(ctx, () => {
    paintSummary?.();
    ctx.requestRender();
  });
  installUsageSection(ctx);
  ctx.registry.registerCommands({
    id: 'usage.palette', order: 520,
    items: () => [{
      section: '命令', icon: '◔', title: '上下文设置', sub: '告警阈值与上下文窗口覆盖',
      keywords: 'shangxiawen shezhi context window gaojing usage',
      run: () => { void openUsageSettings(); },
    }],
  });

  ctx.registry.registerSettingsSection({
    id: 'usage.settings', order: 540, title: '上下文',
    render: () => {
      const body = el('div');
      const ctxPct = el('span', 'set-value');
      ctxPct.id = 'settings-usage-context';
      const overrides = el('span', 'set-value');
      const paint = (): void => {
        const s = usageSettings();
        ctxPct.textContent = `${s.contextWarnPct}% 黄 / ${s.contextDangerPct}% 红`;
        const nw = Object.keys(s.windows).length;
        overrides.textContent = nw === 0 ? '无' : `${nw} 条`;
      };
      paintSummary = paint;
      paint();
      void reloadUsageSettings().then(paint);
      body.append(
        settingRow('上下文告警', '会话上下文占用达到黄档、红档时各提醒一次', ctxPct),
        settingRow('窗口覆盖', '按模型前缀指定上下文窗口，优先于自动推断', overrides),
        settingRow('修改上下文设置', '告警阈值与窗口覆盖在弹窗里编辑',
          actionButton('编辑…', () => { void openUsageSettings(); }, 'settings-usage-edit')),
      );
      return body;
    },
  });
}
