import { matchesQuery } from '../../shared/session-view.js';
import { byId, el } from '../core/dom.js';
import type { CommandContext, PaletteItem, PaletteSection } from '../core/registry.js';
import { collectCommandItems, refreshCommandProviders } from '../core/registry.js';
import { on } from '../core/events.js';
import { setPickTarget } from '../core/panes.js';
import { selectedSession, state } from '../core/state.js';
import { focusSessionInput } from '../term/terminals.js';

/** 命令面板：条目来自命令注册表，这里只负责弹层、过滤、键盘导航与执行 */

const DEFAULT_PLACEHOLDER = '搜索会话或输入命令…';

let paletteItems: PaletteItem[] = [];
let paletteIndex = 0;
/** 只列某一分组（如 Ctrl+Shift+T 打开的模板）；输入框为空时按退格清除 */
let scope: PaletteSection | null = null;

/** 用当前选中状态生成命令上下文，按注册顺序收集条目 */
function build(): PaletteItem[] {
  const session = selectedSession();
  const sel = state.selectedSubagent;
  const subagent = sel && session && sel.sessionId === session.id
    ? session.subagents?.find(x => x.agentId === sel.agentId)
    : undefined;
  const ctx: CommandContext = { session, subagent, paneTab: state.paneTab };
  const items = collectCommandItems(ctx);
  return scope ? items.filter(it => it.section === scope) : items;
}

function setScope(next: PaletteSection | null): void {
  scope = next;
  const input = byId<HTMLInputElement>('palette-input');
  input.placeholder = next ? `在「${next}」中搜索…（退格回到全部）` : DEFAULT_PLACEHOLDER;
  byId('palette-backdrop').dataset.scope = next ?? '';
}

export function openPalette(opts?: { section?: PaletteSection }): void {
  setScope(opts?.section ?? null);
  paletteItems = build();
  paletteIndex = 0;
  const backdrop = byId('palette-backdrop');
  backdrop.hidden = false;
  const input = byId<HTMLInputElement>('palette-input');
  input.value = '';
  renderPaletteList();
  input.focus();
  // 各 provider 并行刷新缓存；有变化且面板仍打开时重建列表，输入框内容保留
  void refreshCommandProviders().then(changed => {
    if (!changed || byId('palette-backdrop').hidden) return;
    paletteItems = build();
    renderPaletteList();
  }).catch(() => undefined);
}

export function closePalette(refocus = true): void {
  byId('palette-backdrop').hidden = true;
  // 用户取消（Esc、点背景）时作废空占位的拾取目标
  if (refocus) setPickTarget(null);
  if (refocus && state.selectedId && !state.selectedSubagent) focusSessionInput(state.selectedId);
}

function filteredPaletteItems(): PaletteItem[] {
  const q = byId<HTMLInputElement>('palette-input').value;
  const blank = !q.trim();
  return paletteItems.filter(it => {
    if (blank && it.queryOnly && scope !== it.section) return false;
    return matchesQuery(q, it.title, it.sub, it.hint, it.keywords);
  });
}

function renderPaletteList(): void {
  const list = byId('palette-list');
  list.innerHTML = '';
  const items = filteredPaletteItems();
  if (items.length === 0) {
    list.appendChild(el('div', 'pal-none', scope ? `「${scope}」中没有匹配项` : '没有匹配的命令或会话'));
    return;
  }
  if (paletteIndex >= items.length) paletteIndex = items.length - 1;
  if (paletteIndex < 0) paletteIndex = 0;

  let section: string | null = null;
  items.forEach((it, i) => {
    if (it.section !== section) {
      section = it.section;
      list.appendChild(el('div', 'pal-lab', it.section));
    }
    const row = el('div', `pal-i${i === paletteIndex ? ' on' : ''}${it.disabled ? ' off' : ''}`);
    row.setAttribute('role', 'option');
    if (it.disabled) row.setAttribute('aria-disabled', 'true');
    row.appendChild(el('div', 'pi', it.icon));
    row.appendChild(el('div', 'pt', it.title));
    if (it.sub) row.appendChild(el('div', 'ps', it.sub));
    const pr = el('div', 'pr');
    if (it.hint) pr.append(it.hint);
    for (const k of it.keys?.split(' ') ?? []) pr.appendChild(el('kbd', '', k));
    if (pr.childNodes.length > 0) row.appendChild(pr);
    // 用 mousemove 而非 mouseenter：列表重建时静止的指针也会触发 mouseenter，
    // 会把键盘移动的高亮拉回指针所在行；只有指针真正移动时才跟随
    row.addEventListener('mousemove', () => {
      if (paletteIndex === i) return;
      paletteIndex = i;
      highlightPaletteRow(list, i);
    });
    row.addEventListener('click', () => runPaletteItem(it));
    list.appendChild(row);
  });

  const active = list.querySelector<HTMLElement>('.pal-i.on');
  active?.scrollIntoView({ block: 'nearest' });
}

function highlightPaletteRow(list: HTMLElement, index: number): void {
  const rows = list.querySelectorAll<HTMLElement>('.pal-i');
  rows.forEach((row, i) => row.classList.toggle('on', i === index));
}

function runPaletteItem(it: PaletteItem, alt = false): void {
  // 置灰条目只展示原因，不执行也不关闭面板
  if (it.disabled) return;
  closePalette(false);
  if (alt && it.runAlt) it.runAlt();
  else it.run();
}

/** 绑定弹层事件；启动时调用一次 */
export function initPalette(): void {
  const backdrop = byId('palette-backdrop');
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closePalette(); });

  const palInput = byId<HTMLInputElement>('palette-input');
  palInput.addEventListener('input', () => { paletteIndex = 0; renderPaletteList(); });
  palInput.addEventListener('keydown', e => {
    if (e.isComposing) return;                       // 中文组字中的 Enter 不执行
    const items = filteredPaletteItems();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteIndex = Math.min(items.length - 1, paletteIndex + 1);
      renderPaletteList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteIndex = Math.max(0, paletteIndex - 1);
      renderPaletteList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[paletteIndex];
      if (it) runPaletteItem(it, e.shiftKey);
    } else if (e.key === 'Backspace' && scope && palInput.value === '') {
      e.preventDefault();
      setScope(null);
      paletteItems = build();
      paletteIndex = 0;
      renderPaletteList();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  });

  // 选中变化后命令面板静默关闭
  on('selection-changed', () => {
    if (!byId('palette-backdrop').hidden) closePalette(false);
  });
}
