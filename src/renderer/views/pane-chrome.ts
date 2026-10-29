import type { GridSize } from '../../shared/pane-geometry.js';
import { MIN_COLS, MIN_ROWS } from '../../shared/pane-geometry.js';
import { leaves } from '../../shared/pane-layout.js';
import { byId, el, statusIcon } from '../core/dom.js';
import { paneLayout } from '../core/panes.js';
import { findSession, state } from '../core/state.js';
import { restoreFromChip } from '../actions/layout-actions.js';

/**
 * 多窗格时的提示条与标签行右侧的返回入口。按键只写在悬停提示里，界面上不常驻按键说明。
 * 单窗格时隐藏提示条并清空标签行提示；只在模式签名变化时重建 DOM。
 */

export type ChromeMode =
  | { kind: 'single' } | { kind: 'grid' } | { kind: 'max' }
  | { kind: 'narrow'; worst: GridSize | null }
  | { kind: 'tab'; tab: string; title: string };

let lastSig = '';

/** 改动、收尾等视图占满详情区时，返回窗格网格的按键 */
function backKeys(tab: string): string {
  if (tab === 'changes') return 'Esc 或 Ctrl+Shift+D';
  if (tab === 'finish') return 'Esc 或 Ctrl+Shift+F';
  return 'Esc';
}

/** 焦点以外、放着会话的窗格 */
function otherSessions(): string[] {
  const layout = paneLayout();
  return leaves(layout.root).filter(l => l.id !== layout.focus && l.sid !== null && !!findSession(l.sid)).map(l => l.sid as string);
}

function chip(sid: string): HTMLElement {
  const s = findSession(sid)!;
  const b = el('button', 'mp-chip') as HTMLButtonElement;
  b.type = 'button';
  b.dataset.sessionId = sid;
  b.title = `切到「${s.label}」`;
  b.append(statusIcon(s.status), s.label);
  b.addEventListener('click', () => restoreFromChip(sid));
  return b;
}

function noteText(mode: ChromeMode, total: number): HTMLElement {
  const t = el('span', 'mp-note-t');
  if (mode.kind === 'max') {
    t.append(el('b', '', '已最大化'), ` · 其余 ${total - 1} 个窗格继续运行`);
    t.title = '还原：Ctrl+Shift+M';
  } else if (mode.kind === 'narrow') {
    const w = mode.worst;
    t.append(el('b', '', '窗口太窄，只显示焦点窗格'), ' · 变宽后自动恢复');
    if (w) t.title = `实测最小的窗格只有 ${w.cols} 列 × ${w.rows} 行（不足 ${MIN_COLS} × ${MIN_ROWS}）`;
  } else if (mode.kind === 'tab') {
    t.append(el('b', '', mode.title), ` · ${total} 个窗格在后台运行`);
  }
  return t;
}

/** 标签行右侧的「← 返回 N 个窗格」：点击回到网格并保持当前焦点 */
function backLink(tab: string, total: number): HTMLElement {
  const b = el('button', 'mp-back', `← 返回 ${total} 个窗格`) as HTMLButtonElement;
  b.type = 'button';
  b.title = `返回窗格网格（${backKeys(tab)}）`;
  b.addEventListener('click', () => { if (state.selectedId) restoreFromChip(state.selectedId); });
  return b;
}

function signature(mode: ChromeMode, others: string[], total: number): string {
  const chips = others.map(sid => {
    const s = findSession(sid)!;
    return `${sid}:${s.status}:${s.label}`;
  }).join(',');
  const extra = mode.kind === 'narrow' ? `${mode.worst?.cols}x${mode.worst?.rows}`
    : mode.kind === 'tab' ? `${mode.tab}:${mode.title}` : '';
  return `${mode.kind}|${total}|${extra}|${chips}`;
}

export function syncPaneChrome(mode: ChromeMode): void {
  const hint = byId('pane-tabs-hint');
  const note = byId('pane-note');
  const total = leaves(paneLayout().root).length;
  const others = mode.kind === 'single' ? [] : otherSessions();
  const sig = signature(mode, others, total);
  if (sig === lastSig) return;
  lastSig = sig;
  hint.replaceChildren(...(mode.kind === 'tab' ? [backLink(mode.tab, total)] : []));
  if (mode.kind === 'single' || mode.kind === 'grid') {
    note.hidden = true;
    note.replaceChildren();
    return;
  }
  note.replaceChildren(noteText(mode, total), ...others.map(chip));
  note.hidden = false;
}
