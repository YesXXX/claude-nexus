import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { findOpener, hotkeyHelpRows } from '../../core/registry.js';
import { actionButton, settingNote, settingRow } from '../../ui/settings-kit.js';
import { closeSettings, initSettingsPage, isSettingsOpen, openSettings, toggleSettings } from './page.js';

/**
 * 设置页入口：导航轨齿轮按钮、Ctrl+, 与命令面板「打开设置」。
 * 各功能的设置分节由功能自己注册（registerSettingsSection，order 从 500 起），
 * 这里只注册排在最后的「快捷键」与「版本与更新」两节。
 */

/** 其他功能打开设置页的入口 id */
export const SETTINGS_OPENER = 'settings.page';
/** 打开更新设置弹窗的入口 id，由内置命令注册 */
const UPDATE_OPENER = 'update.settings';

const ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/>'
  + '<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1'
  + 'a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1'
  + 'a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1'
  + 'a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1'
  + 'a1.7 1.7 0 0 0-1.5 1Z"/></svg>';

export function install(ctx: AppContext): void {
  initSettingsPage(mountRailButton());

  ctx.registry.registerOpener({ id: SETTINGS_OPENER, order: 590, open: () => openSettings() });

  ctx.registry.registerHotkey({
    id: 'settings.toggle', keys: 'Ctrl ,', label: '设置', phase: 'always', order: 590, helpOrder: 38,
    match: e => e.ctrlKey && !e.altKey && !e.shiftKey && e.key === ',',
    run: e => {
      e.preventDefault();
      e.stopPropagation();
      ctx.actions.closePalette(false);
      toggleSettings();
    },
  });

  ctx.registry.registerCommands({
    id: 'settings.palette', order: 590,
    items: () => [{
      section: '命令', icon: '⚙', title: isSettingsOpen() ? '关闭设置' : '打开设置', keys: 'Ctrl ,',
      keywords: 'shezhi settings preferences options xuanxiang kuaijiejian shortcuts',
      run: () => toggleSettings(),
    }],
  });

  ctx.registry.registerSettingsSection({ id: 'settings.shortcuts', order: 900, title: '快捷键', render: renderShortcuts });
  ctx.registry.registerSettingsSection({
    id: 'settings.version', order: 950, title: '版本与更新',
    render: () => renderVersion(ctx),
  });
}

/** 齿轮按钮放在「属性面板」开关之前 */
function mountRailButton(): HTMLButtonElement | null {
  const anchor = document.getElementById('btn-inspector');
  if (!anchor) return null;
  const b = el('button', 'ri');
  b.type = 'button';
  b.id = 'rail-settings';
  b.title = '设置（Ctrl+,）';
  b.innerHTML = ICON;
  b.addEventListener('click', () => toggleSettings());
  anchor.before(b);
  return b;
}

/** 由热键注册表生成，功能模块新注册的热键自动出现在这里 */
function renderShortcuts(): HTMLElement {
  const body = el('div');
  const table = el('div', 'set-keys');
  table.id = 'settings-keys';
  for (const [what, how] of hotkeyHelpRows()) {
    const row = el('div', 'set-key-row');
    row.dataset.keys = how;
    row.appendChild(el('span', 'set-key-label', what));
    const keys = el('span', 'set-key-keys');
    for (const k of how.split(' ').filter(Boolean)) keys.appendChild(el('kbd', '', k));
    row.appendChild(keys);
    table.appendChild(row);
  }
  body.appendChild(table);
  body.appendChild(settingNote('全局唤起热键优先使用 Alt ⇧ C，被其他程序占用时自动换用备选组合，实际组合见托盘图标的悬停提示。'
    + '单键热键（Y N A、J K、V）只在焦点不在终端与输入框时生效。'));
  return body;
}

function renderVersion(ctx: AppContext): HTMLElement {
  const body = el('div');
  const version = el('span', 'set-value', '读取中…');
  version.id = 'settings-version';
  const dir = el('span', 'set-value set-path', '');
  dir.id = 'settings-update-dir';
  body.appendChild(settingRow('当前版本', null, version));
  // 更新目录在更新弹窗里修改，先关掉设置页，免得页面上显示改之前的目录
  const openUpdate = (): void => {
    closeSettings();
    findOpener(UPDATE_OPENER)?.open();
  };
  const row = settingRow('更新目录', '存放新版本安装包与 latest.json 的文件夹，可填局域网共享目录；启动和从托盘唤起时自动检查',
    actionButton('检查更新…', openUpdate, 'settings-check-update'));
  row.querySelector('.set-text')?.appendChild(dir);
  body.appendChild(row);
  void ctx.api.updater.getConfig().then(cfg => {
    version.textContent = `v${cfg.currentVersion}`;
    dir.textContent = cfg.dir || '尚未设置';
    dir.title = cfg.dir ?? '';
  }).catch(err => {
    version.textContent = `读取失败：${ipcErrorText(err)}`;
  });
  return body;
}
