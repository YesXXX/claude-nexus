import type { AppContext } from '../../core/context.js';
import type { PaletteItem } from '../../core/registry.js';
import { isVerifyFinal } from '../../../shared/verify-types.js';
import { verifyFixable } from '../../../shared/verify-view.js';
import { sessionIdle } from './badge.js';
import { openConfigDialog } from './config-dialog.js';
import { openOutputDialog } from './output-dialog.js';
import { installVerifySection, invalidateVerifyConfigs } from './section.js';
import { installVerifySettings } from './settings-section.js';

/**
 * 每轮自动验证的界面：会话行徽标（点击看输出）、属性面板「自动验证」节、
 * 配置对话框、输出弹窗、设置页分节与命令面板入口。执行、排队与取消全在主进程，这里只展示与发起操作。
 */
export function install(ctx: AppContext): void {
  const open = (id: string): void => openOutputDialog(ctx, id);
  installVerifySection(ctx);
  const configure = (onSaved?: () => void): void => {
    const id = ctx.state.selectedId;
    if (id) {
      void openConfigDialog(ctx, id, () => {
        invalidateVerifyConfigs();
        onSaved?.();
      });
    } else {
      ctx.toast('先选中一个会话，再配置它所在仓库的验证命令', 'warning');
    }
  };
  ctx.registry.registerOpener({ id: 'verify.config', order: 530, open: () => configure() });
  installVerifySettings(ctx, configure);
  ctx.registry.registerCommands({
    id: 'verify.palette', order: 530,
    items: c => {
      const s = c.session;
      if (!s || s.readOnly) return [];
      const items: PaletteItem[] = [{
        section: '命令', icon: '✓', title: '配置验证命令', sub: '每轮结束后在会话目录运行测试或构建',
        keywords: 'yanzheng peizhi verify test ceshi zidong',
        run: () => { void openConfigDialog(ctx, s.id, invalidateVerifyConfigs); },
      }];
      const running = !!s.verify && !isVerifyFinal(s.verify.status);
      if (running) {
        items.push({
          section: '命令', icon: '✓', title: '取消验证', sub: s.verify?.command ?? '',
          keywords: 'yanzheng quxiao verify cancel', run: () => { void ctx.api.verify.cancel(s.id); },
        });
      } else if (sessionIdle(s)) {
        items.push({
          section: '命令', icon: '✓', title: '运行验证', sub: '立即运行，忽略自动开关与无改动跳过',
          keywords: 'yanzheng yunxing verify run',
          run: () => {
            void ctx.api.verify.run(s.id).then(r => { if (!r.ok) ctx.toast(r.reason ?? '无法运行', 'warning'); });
          },
        });
      }
      if (s.verify) {
        items.push({
          section: '命令', icon: '✓', title: '查看验证输出', sub: s.verify.command,
          keywords: 'yanzheng shuchu verify output', run: () => open(s.id),
        });
      }
      if (verifyFixable(s.verify) && sessionIdle(s)) {
        items.push({
          section: '命令', icon: '✓', title: '把验证失败发给 Claude 修复', sub: '命令、退出码与输出末尾',
          keywords: 'yanzheng xiufu verify fix claude',
          run: () => {
            void ctx.api.verify.sendToClaude(s.id).then(r => {
              if (r.ok) ctx.toast('已把失败输出发给 Claude');
              else ctx.toast(r.reason ?? '发送失败', 'warning');
            });
          },
        });
      }
      return items;
    },
  });
}
