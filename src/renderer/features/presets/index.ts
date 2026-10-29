import type { PresetInput, SessionPreset } from '../../../shared/preset';
import { presetSummary, sortPresets } from '../../../shared/preset.js';
import type { AppContext } from '../../core/context.js';
import type { CreateSessionOptions } from '../../core/api.js';
import { el, ipcErrorText } from '../../core/dom.js';
import type { PaletteItem } from '../../core/registry.js';
import { openSettings } from '../settings/page.js';
import { bindPresetDialog, openPresetDialog } from './preset-dialog.js';
import { renderPresetSection } from './preset-settings.js';

/**
 * 会话预设：新建会话表单的组合（工作目录、独立工作区选项、首条提示词）的可复用保存。
 * 入口：首页新建表单「预设 ▾」（打开预设分组：选择预设一键创建，或把当前表单存为预设）、
 * 命令面板「用预设新建：XXX」、设置页「会话预设」分节（改名 / 删除）。
 * 预设列表在打开命令面板、进入设置分节与点开表单按钮时刷新缓存。
 */

export function install(ctx: AppContext): void {
  bindPresetDialog(ctx);

  let cache: SessionPreset[] = [];
  let cacheKey = '';
  const keyOf = (list: SessionPreset[]) => list.map(p => `${p.id}:${p.updatedAt}:${p.useCount}:${p.lastUsedAt ?? 0}`).join('|');
  const applyList = (list: SessionPreset[]): void => {
    cache = sortPresets(list);
    cacheKey = keyOf(cache);
  };
  const reload = async (): Promise<SessionPreset[]> => {
    const list = await ctx.api.presets.list();
    applyList(list);
    return list;
  };
  void reload().catch(err => console.error('[presets] 读取预设失败：', err));

  let creating = false;
  const usePreset = async (p: SessionPreset): Promise<void> => {
    if (creating) return;
    creating = true;
    try {
      // 先记一次使用（最近使用的排在命令面板前面），失败不拦创建
      const next = await ctx.api.presets.touch(p.id).catch(() => null);
      if (next) applyList(cache.map(x => (x.id === next.id ? next : x)));
      const opts: CreateSessionOptions = {};
      if (p.worktree) {
        opts.worktree = true;
        if (p.branch) opts.branch = p.branch;
        if (p.baseRef) opts.baseRef = p.baseRef;
      }
      if (p.initialPrompt) opts.initialPrompt = p.initialPrompt;
      await ctx.actions.createSessionAndSelect(p.name, p.cwd, opts);
      ctx.toast(`已用预设「${p.name}」创建会话`, 'success');
    } catch (err) {
      // 工作目录不存在、独立工作区创建失败等在这里明确提示，不静默失败
      ctx.toast(ipcErrorText(err), 'error');
    } finally {
      creating = false;
    }
  };

  // 命令面板关闭后再执行创建，选中态切换才不会打断面板收起
  const later = (fn: () => void) => () => requestAnimationFrame(fn);

  ctx.registry.registerCommands({
    id: 'presets.palette',
    order: 570,
    items: (c): PaletteItem[] => {
      const items: PaletteItem[] = cache.map(p => ({
        section: '预设', icon: '⌁', title: `用预设新建：${p.name}`, sub: presetSummary(p),
        keywords: `yuzhi preset xinjian ${p.cwd}${p.worktree ? ' worktree duli gongzuqu' : ''}`,
        run: later(() => { void usePreset(p); }),
      }));
      // 停在首页时可把当前表单存为预设
      if (!c.session && !c.subagent) {
        items.push({
          section: '预设', icon: '⇩', title: '把当前表单存为预设', sub: '工作目录、独立工作区选项与首条提示词',
          keywords: 'cunwei yuzhi preset save form', run: later(() => saveFormAsPreset()),
        });
      }
      items.push({
        section: '预设', icon: '✎', title: '管理会话预设', sub: cache.length > 0 ? `${cache.length} 个预设` : undefined,
        keywords: 'yuzhi preset guanli manage', run: later(() => openSettings('presets-settings')),
      });
      return items;
    },
    refresh: async () => {
      const prev = cacheKey;
      try { await reload(); } catch { return false; }
      return cacheKey !== prev;
    },
  });

  ctx.registry.registerSettingsSection({
    id: 'presets.settings', order: 515, title: '会话预设',
    render: () => renderPresetSection({ ctx, reload }),
  });

  const field = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
  const saveFormAsPreset = (): void => {
    const cwd = field<HTMLInputElement>('form-cwd')?.value.trim() ?? '';
    if (!cwd) { ctx.toast('工作目录为空，无法保存预设', 'warning'); return; }
    const name = field<HTMLInputElement>('form-label')?.value.trim() ?? '';
    const prompt = field<HTMLTextAreaElement>('form-prompt')?.value ?? '';
    const worktree = field<HTMLInputElement>('wt-on')?.checked === true;
    const input: PresetInput = { name, cwd, worktree };
    if (prompt.trim()) input.initialPrompt = prompt;
    if (worktree) {
      const branch = field<HTMLInputElement>('wt-branch')?.value.trim() ?? '';
      const base = field<HTMLInputElement>('wt-base')?.value.trim() ?? '';
      if (branch) input.branch = branch;
      if (base) input.baseRef = base;
    }
    openPresetDialog({ input, onSaved: () => { void reload().catch(() => undefined); } });
  };

  const tools = document.getElementById('form-prompt-tools');
  if (tools) {
    const pick = el('button', 'btn sm tpl-form-btn', '预设 ▾');
    pick.type = 'button';
    pick.id = 'form-preset';
    pick.title = '用预设一键创建会话，或把当前表单存为预设';
    pick.addEventListener('click', () => {
      void reload().catch(() => undefined).then(() => ctx.actions.openPalette({ section: '预设' }));
    });
    tools.appendChild(pick);
  }
}
