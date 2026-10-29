import type { ExportFormat, Session } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import { ipcErrorText } from '../../core/dom.js';
import type { PaletteItem } from '../../core/registry.js';

/**
 * 导出终端输出：详情页头「⋯」菜单与命令面板入口。先选格式，再由主进程弹保存对话框并写文件，
 * 成功后提示导出路径，点击提示在资源管理器中定位文件。
 */

const FORMAT_CHOICES: Array<{ value: ExportFormat; text: string; style?: 'primary' }> = [
  { value: 'rendered', text: '纯文本（按屏幕重放，推荐）', style: 'primary' },
  { value: 'plain', text: '纯文本（直接去除控制符）' },
  { value: 'ansi', text: '原始 ANSI' },
];

export function install(ctx: AppContext): void {
  let busy = false;

  const exportFlow = async (s: Session): Promise<void> => {
    if (busy) return;
    const format = await ctx.choice<ExportFormat>({
      title: '导出终端输出',
      message: `导出「${s.label}」的终端输出。按屏幕重放与界面所见一致；中途改过窗口宽度或清过屏时，可改用直接去除控制符，内容更完整；原始 ANSI 保留颜色，可在终端里 cat 查看。`,
      choices: FORMAT_CHOICES,
      defaultValue: 'rendered',
    });
    if (!format) return;
    busy = true;
    try {
      const r = await ctx.api.exportOutput(s.id, format);
      if (r.canceled) return;
      if (!r.ok || !r.path) {
        ctx.toast(r.error ?? '导出失败', r.error === '无可导出的输出' ? 'info' : 'error');
        return;
      }
      const notes: string[] = [];
      if (r.truncated) notes.push(`较早的 ${r.dropped ?? 0} 个字符已超出缓冲上限，未包含在内`);
      if (r.fallback) notes.push('按屏幕重放失败，已改用直接去除控制符');
      const file = r.path;
      ctx.toast(`已导出到 ${file}（点击打开所在目录）${notes.length > 0 ? '；' + notes.join('；') : ''}`,
        notes.length > 0 ? 'warning' : 'success', () => {
          void ctx.api.revealExport(file).then(err => { if (err) ctx.toast(err, 'error'); });
        });
    } catch (err) {
      ctx.toast(`导出失败：${ipcErrorText(err)}`, 'error');
    } finally {
      busy = false;
    }
  };

  ctx.registry.registerPaneMenuItem({
    id: 'term-export.menu', order: 100,
    item: s => ({ label: '导出终端输出', role: 'export-output', title: '导出终端输出为文本文件', run: () => { void exportFlow(s); } }),
  });

  ctx.registry.registerCommands({
    id: 'term-export.palette',
    order: 530,
    items: (c): PaletteItem[] => {
      const s = c.session;
      if (!s) return [];
      return [{
        section: '命令', icon: '⇩', title: '导出终端输出', sub: s.label,
        keywords: 'daochu zhongduan shuchu export output log save',
        // 命令面板关闭后再弹格式选择，焦点才能落到对话框上
        run: () => requestAnimationFrame(() => { void exportFlow(s); }),
      }];
    },
  });
}
