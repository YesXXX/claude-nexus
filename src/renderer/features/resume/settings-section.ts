import type { ResumeSettings } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { segmented, settingRow } from '../../ui/settings-kit.js';
import { QUIT_OPTS, STARTUP_OPTS } from './restore-ui.js';

/** 设置页「会话续接」分节：退出面板时与下次启动时如何处理未结束的会话，选中即保存 */
export function installResumeSettings(ctx: AppContext): void {
  ctx.registry.registerSettingsSection({
    id: 'resume.settings', order: 500, title: '会话续接',
    render: () => renderSection(ctx),
  });
}

function renderSection(ctx: AppContext): HTMLElement {
  const body = el('div');
  const save = async (patch: Partial<ResumeSettings>, text: string): Promise<boolean> => {
    try {
      await ctx.api.resumeSettingsSet(patch);
      ctx.toast(text, 'success');
      return true;
    } catch (err) {
      ctx.toast(`保存设置失败：${ipcErrorText(err)}`, 'error');
      return false;
    }
  };
  const quit = segmented(QUIT_OPTS.map(([v, t]) => [v, t]), null,
    v => save({ onQuit: v }, `退出时已设为「${QUIT_OPTS.find(o => o[0] === v)?.[1]}」`));
  const startup = segmented(STARTUP_OPTS.map(([v, t]) => [v, t]), null,
    v => save({ onStartup: v }, `启动时恢复已设为「${STARTUP_OPTS.find(o => o[0] === v)?.[1]}」`));
  quit.el.id = 'settings-on-quit';
  startup.el.id = 'settings-on-startup';
  quit.setDisabled(true);
  startup.setDisabled(true);
  body.append(
    settingRow('退出面板时', '询问：有运行中的会话时弹窗选择；保留：下次启动出现在「待续接」分组；结束：直接结束全部会话', quit.el),
    settingRow('启动时恢复', '上次保留或异常退出留下的会话，启动后自动续接、询问后续接或不处理', startup.el),
  );
  void ctx.api.resumeSettingsGet().then(s => {
    quit.set(s.onQuit);
    startup.set(s.onStartup);
    quit.setDisabled(false);
    startup.setDisabled(false);
  }).catch(err => ctx.toast(`读取续接设置失败：${ipcErrorText(err)}`, 'error'));
  return body;
}
