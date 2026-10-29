import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { SKINS, isSkinId, skinOf, type SkinId } from '../../../shared/skins.js';

/**
 * 外观：设置页「外观」分节（皮肤缩略卡片）与命令面板「切换皮肤」条目。
 * 换肤即时生效：改 html 的 data-skin（样式表按皮肤块取值）→ 刷新已打开终端的配色 → 主进程落盘并改标题栏颜色。
 * 启动时的皮肤由 preload 按主进程给的参数提前设好，这里只读不写初始值。
 */

function currentSkin(): SkinId {
  const v = document.documentElement.dataset.skin;
  return isSkinId(v) ? v : SKINS[0].id;
}

/** 卡片高亮跟随当前皮肤：设置页开着时从命令面板切换也要同步 */
function markCard(card: HTMLElement, cur: SkinId): void {
  const on = card.dataset.skin === cur;
  card.classList.toggle('on', on);
  card.setAttribute('aria-checked', String(on));
}

function syncCards(): void {
  const cur = currentSkin();
  for (const card of document.querySelectorAll<HTMLElement>('.skin-card')) markCard(card, cur);
}

async function switchSkin(ctx: AppContext, id: SkinId): Promise<void> {
  const prev = currentSkin();
  if (id === prev) return;
  const apply = (s: SkinId): void => {
    document.documentElement.dataset.skin = s;
    ctx.terminals.refreshTheme();
    syncCards();
  };
  // 先改界面再落盘，点击后立刻看到效果；落盘失败时退回原皮肤，界面与偏好文件保持一致
  apply(id);
  try {
    const r = await ctx.api.appearance.set(id);
    if (!r.ok) throw new Error('主进程不认识这个皮肤');
  } catch (err) {
    apply(prev);
    ctx.toast(`切换皮肤失败：${ipcErrorText(err)}`, 'error');
  }
}

/** 一张缩略卡片：外框色条 + 列表块 + 终端块 + 强调色，下方名称与说明 */
function skinCard(ctx: AppContext, id: SkinId): HTMLElement {
  const s = skinOf(id);
  const card = el('button', 'skin-card');
  card.type = 'button';
  card.dataset.skin = id;
  card.setAttribute('role', 'radio');
  card.title = s.hint;
  // 预览色来自皮肤清单，是数据而非界面样式，所以用内联 style 而不是变量
  const pv = el('span', 'skin-pv');
  pv.style.background = s.preview.chrome;
  const panel = el('span', 'skin-pv-panel');
  panel.style.background = s.preview.panel;
  const term = el('span', 'skin-pv-term');
  term.style.background = s.preview.term;
  const accent = el('span', 'skin-pv-accent');
  accent.style.background = s.preview.accent;
  term.appendChild(accent);
  pv.append(panel, term);
  const name = el('span', 'skin-name', s.name);
  const hint = el('span', 'skin-hint', s.hint);
  card.append(pv, name, hint);
  markCard(card, currentSkin());
  card.addEventListener('click', () => void switchSkin(ctx, id));
  return card;
}

function renderAppearance(ctx: AppContext): HTMLElement {
  const body = el('div');
  const grid = el('div', 'skin-grid');
  grid.id = 'settings-skins';
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-label', '皮肤');
  for (const s of SKINS) grid.appendChild(skinCard(ctx, s.id));
  body.appendChild(grid);
  return body;
}

export function install(ctx: AppContext): void {
  ctx.registry.registerSettingsSection({
    id: 'appearance.skins', order: 400, title: '外观',
    render: () => renderAppearance(ctx),
  });

  ctx.registry.registerCommands({
    id: 'appearance.palette', order: 580,
    items: () => {
      const cur = currentSkin();
      return SKINS.map(s => ({
        section: '命令' as const, icon: '◐', title: `切换皮肤：${s.name}`,
        hint: s.id === cur ? '当前' : undefined,
        disabled: s.id === cur,
        keywords: `pifu huanfu skin theme zhuti waiguan ${s.id}`,
        run: () => void switchSkin(ctx, s.id),
      }));
    },
  });
}
