import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { actionButton, numberField, settingRow, toggle } from '../../ui/settings-kit.js';
import type { VerifyGlobal } from '../../../shared/verify-types.js';
import { VERIFY_CONCURRENCY_MAX, VERIFY_CONCURRENCY_MIN } from '../../../shared/verify-types.js';

/**
 * 设置页「每轮自动验证」分节：全局并发上限与失败通知开关，改完即保存。
 * 验证命令按仓库配置，需要选中会话后在配置对话框里改；对话框也能改全局项，保存后这里重新读取。
 */
export function installVerifySettings(ctx: AppContext, configure: (onSaved: () => void) => void): void {
  ctx.registry.registerSettingsSection({
    id: 'verify.settings', order: 530, title: '每轮自动验证',
    render: () => renderSection(ctx, configure),
  });
}

function renderSection(ctx: AppContext, configure: (onSaved: () => void) => void): HTMLElement {
  const body = el('div');
  const save = async (patch: Partial<VerifyGlobal>, text: string): Promise<boolean> => {
    try {
      await ctx.api.verify.setGlobal(patch);
      ctx.toast(text, 'success');
      return true;
    } catch (err) {
      ctx.toast(`保存设置失败：${ipcErrorText(err)}`, 'error');
      return false;
    }
  };
  const conc = numberField(0, [VERIFY_CONCURRENCY_MIN, VERIFY_CONCURRENCY_MAX],
    v => save({ maxConcurrent: v }, `同时验证上限已设为 ${v}`),
    { unit: '个', onInvalid: (min, max) => ctx.toast(`并发数需在 ${min}～${max} 之间的整数`, 'warning') });
  conc.input.id = 'settings-verify-concurrency';
  const notify = toggle(false, on => save({ notifyOnFail: on }, on ? '验证未通过时会发系统通知' : '已关闭验证失败通知'));
  notify.input.id = 'settings-verify-notify';
  conc.input.disabled = true;
  notify.input.disabled = true;

  const load = (): void => {
    void ctx.api.verify.getGlobal().then(g => {
      conc.set(g.maxConcurrent);
      notify.input.checked = g.notifyOnFail;
      conc.input.disabled = false;
      notify.input.disabled = false;
    }).catch(err => ctx.toast(`读取验证设置失败：${ipcErrorText(err)}`, 'error'));
  };

  body.append(
    settingRow('同时验证上限', '多个会话同时结束一轮时，超出上限的排队等待', conc.el),
    settingRow('失败时通知', '验证未通过、超时或无法启动时发系统通知', notify.el),
    settingRow('验证命令', '按仓库配置，同一仓库的会话共用；先选中会话，再配置它所在仓库的命令（命令面板「配置验证命令」同效）',
      actionButton('配置当前仓库…', () => configure(load), 'settings-verify-config')),
  );
  load();
  return body;
}
