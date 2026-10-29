import type { SessionPreset } from '../../../shared/preset';
import { presetSummary, sortPresets } from '../../../shared/preset.js';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { actionButton, settingNote } from '../../ui/settings-kit.js';
import { openPresetDialog } from './preset-dialog.js';

/** 设置页「会话预设」分节：列出各预设（名称、摘要、使用次数），支持改名与删除 */

export interface PresetSectionDeps {
  ctx: AppContext;
  /** 重新读取列表并刷新命令面板缓存，返回新列表 */
  reload(): Promise<SessionPreset[]>;
}

export function renderPresetSection(deps: PresetSectionDeps): HTMLElement {
  const body = el('div');
  body.appendChild(settingNote(
    '预设保存新建会话表单的组合（工作目录、独立工作区选项、首条提示词），'
    + '可在首页新建表单「预设 ▾」与命令面板中一键创建会话。'));
  const list = el('div', 'preset-list');
  list.id = 'settings-preset-list';
  body.appendChild(list);

  const paint = (presets: SessionPreset[]): void => {
    list.replaceChildren();
    if (presets.length === 0) {
      list.appendChild(el('div', 'preset-empty', '还没有预设；在首页新建表单填好内容后，点「预设 ▾」选择「把当前表单存为预设」。'));
      return;
    }
    for (const p of sortPresets(presets)) {
      const row = el('div', 'preset-row');
      row.dataset.id = p.id;
      const info = el('div', 'preset-info');
      const nameLine = el('div', 'preset-name-line');
      nameLine.append(el('span', 'preset-name', p.name), el('span', 'preset-count', p.useCount > 0 ? `用过 ${p.useCount} 次` : '未用'));
      info.appendChild(nameLine);
      const sum = el('div', 'preset-sum', presetSummary(p, 120));
      sum.title = [
        p.cwd,
        p.worktree ? `独立工作区${p.branch ? `（分支 ${p.branch}）` : ''}${p.baseRef ? `，基线 ${p.baseRef}` : ''}` : '',
        p.initialPrompt ? '带首条提示词' : '',
      ].filter(Boolean).join('\n');
      info.appendChild(sum);

      const ops = el('div', 'preset-ops');
      ops.appendChild(actionButton('改名', () => {
        openPresetDialog({
          input: {
            id: p.id, name: p.name, cwd: p.cwd, worktree: p.worktree,
            ...(p.branch ? { branch: p.branch } : {}),
            ...(p.baseRef ? { baseRef: p.baseRef } : {}),
            ...(p.initialPrompt ? { initialPrompt: p.initialPrompt } : {}),
          },
          onSaved: refresh,
        });
      }));
      ops.appendChild(actionButton('删除', () => { void removePreset(deps, p, refresh); }));
      row.append(info, ops);
      list.appendChild(row);
    }
  };

  const refresh = (): void => {
    void deps.reload().then(paint).catch(err => {
      list.replaceChildren(el('div', 'preset-empty', `读取失败：${ipcErrorText(err)}`));
    });
  };
  refresh();
  return body;
}

async function removePreset(deps: PresetSectionDeps, p: SessionPreset, refresh: () => void): Promise<void> {
  const ok = await deps.ctx.confirm({
    title: '删除预设？',
    message: `预设「${p.name}」将被删除，无法恢复。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await deps.ctx.api.presets.remove(p.id);
  } catch (err) {
    deps.ctx.toast(`删除失败：${ipcErrorText(err)}`, 'error');
    return;
  }
  deps.ctx.toast(`已删除预设「${p.name}」`, 'info');
  refresh();
}
