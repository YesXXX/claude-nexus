import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { actionButton, numberField, settingRow } from '../../ui/settings-kit.js';
import { COUNT_RANGE, DAYS_RANGE } from './footer.js';

/**
 * 设置页「会话历史」分节：保留条数与天数上限，以及打开历史面板的入口。
 * 改小上限会让主进程立即清理超出的记录，因此改小时先确认；固定的记录不受限制。
 */
export function installHistorySettings(ctx: AppContext, openHistory: () => void): void {
  ctx.registry.registerSettingsSection({
    id: 'history.settings', order: 510, title: '会话历史',
    render: () => renderSection(ctx, openHistory),
  });
}

function renderSection(ctx: AppContext, openHistory: () => void): HTMLElement {
  const body = el('div');
  const invalid = (what: string) => (min: number, max: number): void =>
    ctx.toast(`${what}需在 ${min}～${max} 之间的整数`, 'warning');

  const save = async (patch: { historyMaxCount?: number; historyMaxDays?: number }, shrink: boolean): Promise<boolean> => {
    if (shrink) {
      const ok = await ctx.confirm({
        title: '收紧保留策略',
        message: '超出新上限的已结束会话记录会立即删除，不可撤销；固定的记录不受影响。',
        okText: '保存并清理',
        danger: true,
      });
      if (!ok) return false;
    }
    try {
      await ctx.api.resumeSettingsSet(patch);
      ctx.toast('已更新保留策略', 'success');
      return true;
    } catch (err) {
      ctx.toast(ipcErrorText(err), 'error');
      return false;
    }
  };

  let count = 0;
  let days = 0;
  const countField = numberField(0, COUNT_RANGE, async v => {
    const ok = await save({ historyMaxCount: v }, v < count);
    if (ok) count = v;
    return ok;
  }, { unit: '条', onInvalid: invalid('条数') });
  const daysField = numberField(0, DAYS_RANGE, async v => {
    const ok = await save({ historyMaxDays: v }, v < days);
    if (ok) days = v;
    return ok;
  }, { unit: '天', onInvalid: invalid('天数') });
  countField.input.id = 'settings-history-count';
  daysField.input.id = 'settings-history-days';
  countField.input.disabled = true;
  daysField.input.disabled = true;

  body.append(
    settingRow('最多保留', '已结束会话的记录条数上限', countField.el),
    settingRow('保留天数', '结束超过这么多天的记录自动清理', daysField.el),
    settingRow('会话历史', '搜索、续接、固定或删除已结束的会话（Ctrl+Shift+H）',
      actionButton('打开会话历史', openHistory, 'settings-open-history')),
  );

  void ctx.api.resumeSettingsGet().then(s => {
    count = s.historyMaxCount;
    days = s.historyMaxDays;
    countField.set(count);
    daysField.set(days);
    countField.input.disabled = false;
    daysField.input.disabled = false;
  }).catch(err => ctx.toast(`读取保留策略失败：${ipcErrorText(err)}`, 'error'));
  return body;
}
