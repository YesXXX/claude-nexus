import type { DropZone, Edge } from '../../shared/pane-layout.js';
import { findLeaf } from '../../shared/pane-layout.js';
import type { SplitCheck } from '../../shared/pane-geometry.js';
import { dropZoneAt } from '../../shared/pane-geometry.js';
import { byId, el, statusIcon } from '../core/dom.js';
import { paneLayout, setDragSession } from '../core/panes.js';
import { render } from '../core/render.js';
import { findSession } from '../core/state.js';
import { dropOnPane } from '../actions/layout-actions.js';
import { paneTargets, splitCheck } from './pane-grid.js';

/**
 * 从侧栏拖会话行到窗格：四边按方向拆分，中央替换（已在布局中的会话为移动）。
 * 侧栏每轮渲染会重建行元素，所以按下时只记起点，后续移动与松开都挂在 window 上；
 * 移动超过阈值才进入拖动，松开后短时间内吞掉列表上的点击，避免误选行。
 */

const THRESHOLD = 6;
/** 拖动标签相对指针的偏移，与系统拖放图标的位置习惯一致 */
const GHOST_DX = 14;
const GHOST_DY = 16;
const EDGES: Edge[] = ['top', 'bottom', 'left', 'right'];
const EDGE_TEXT: Record<Edge, string> = { top: '向上拆分', bottom: '向下拆分', left: '向左拆分', right: '向右拆分' };

interface Hit { paneId: string; zone: DropZone; ok: boolean }

let sid: string | null = null;
let startX = 0;
let startY = 0;
let dragging = false;
let ghost: HTMLElement | null = null;
let overlay: { paneId: string; el: HTMLElement; host: HTMLElement; checks: Record<Edge, SplitCheck> } | null = null;
let hit: Hit | null = null;
let swallowUntil = 0;

function label(id: string): string {
  return findSession(id)?.label ?? '';
}

function zoneEl(zone: DropZone): HTMLElement {
  const z = el('div', `mp-zone z-${zone}`);
  z.dataset.zone = zone;
  return z;
}

function zoneText(z: HTMLElement, title: string, sub = ''): void {
  const t = el('div', 'mp-zl');
  t.append(el('b', '', title));
  if (sub) t.append(sub);
  z.replaceChildren(t);
}

/** 命中窗格变化时重建落点层：不可行的边为斜纹禁用区，并写明原因 */
function buildOverlay(paneId: string, host: HTMLElement): void {
  clearOverlay();
  const moving = sid as string;
  const layer = el('div', 'mp-drop');
  const target = findLeaf(paneLayout().root, paneId);
  const self = target?.sid === moving;
  const checks = {} as Record<Edge, SplitCheck>;
  let fullNoted = false;
  for (const edge of EDGES) {
    const z = zoneEl(edge);
    const chk = self ? { ok: false as const, reason: 'self' as const } : splitCheck(paneId, edge, moving);
    checks[edge] = chk;
    if (chk.ok) {
      zoneText(z, EDGE_TEXT[edge]);
    } else {
      z.classList.add('dis');
      if (chk.reason === 'full' && !fullNoted) {
        zoneText(z, '⊘ 已达 4 个窗格上限，只能替换');
        fullNoted = true;
      } else if (chk.reason === 'small') {
        zoneText(z, `⊘ 窗格太小（拆分后约 ${chk.cols} 列 × ${chk.rows} 行），只能替换`);
      } else {
        zoneText(z, '⊘');
      }
    }
    layer.appendChild(z);
  }
  const center = zoneEl('center');
  if (self) {
    center.classList.add('dis');
    zoneText(center, '已在此窗格');
  } else if (target?.sid && findSession(target.sid)) {
    zoneText(center, `替换为「${label(moving)}」`, `「${label(target.sid)}」回到侧栏`);
  } else {
    zoneText(center, `放入「${label(moving)}」`);
  }
  layer.appendChild(center);
  host.appendChild(layer);
  overlay = { paneId, el: layer, host, checks };
}

function clearOverlay(): void {
  overlay?.el.remove();
  overlay = null;
  hit = null;
}

function updateHit(x: number, y: number): void {
  const targets = paneTargets();
  const found = targets.find(t => {
    const r = t.el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
  if (!found) {
    clearOverlay();
    return;
  }
  if (!overlay || overlay.paneId !== found.paneId || overlay.host !== found.el) buildOverlay(found.paneId, found.el);
  const r = found.el.getBoundingClientRect();
  const zone = dropZoneAt({ x: r.left, y: r.top, w: r.width, h: r.height }, x, y);
  const o = overlay as NonNullable<typeof overlay>;
  const ok = !!zone && (zone === 'center' ? findLeaf(paneLayout().root, o.paneId)?.sid !== sid : o.checks[zone].ok);
  hit = zone ? { paneId: o.paneId, zone, ok } : null;
  for (const z of o.el.querySelectorAll<HTMLElement>('.mp-zone')) {
    const on = !!hit && hit.ok && z.dataset.zone === hit.zone;
    z.classList.toggle('hot', on);
    z.classList.toggle('rep', on && hit!.zone === 'center');
    if (on && hit!.zone !== 'center') zoneText(z, EDGE_TEXT[hit!.zone as Edge], `松开后「${label(sid as string)}」进入新窗格`);
    else if (!z.classList.contains('dis') && z.dataset.zone !== 'center') zoneText(z, EDGE_TEXT[z.dataset.zone as Edge]);
  }
}

/** 标签放在指针右下方，避开投放区中央的说明文字；靠近窗口右缘或底缘时翻到另一侧 */
function moveGhost(x: number, y: number): void {
  if (!ghost) return;
  const w = ghost.offsetWidth;
  const h = ghost.offsetHeight;
  const left = x + GHOST_DX + w > window.innerWidth ? x - GHOST_DX - w : x + GHOST_DX;
  const top = y + GHOST_DY + h > window.innerHeight ? y - GHOST_DY - h : y + GHOST_DY;
  ghost.style.left = `${Math.max(0, left)}px`;
  ghost.style.top = `${Math.max(0, top)}px`;
}

function begin(x: number, y: number): void {
  const s = findSession(sid as string);
  if (!s) return;
  dragging = true;
  setDragSession(s.id);
  document.body.classList.add('mp-dragging');
  ghost = el('div', 'mp-ghost');
  ghost.append(statusIcon(s.status), s.label);
  document.body.appendChild(ghost);
  moveGhost(x, y);
  render();
}

function end(drop: boolean): void {
  window.removeEventListener('pointermove', onMove, true);
  window.removeEventListener('pointerup', onUp, true);
  window.removeEventListener('pointercancel', onCancel, true);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', onCancel);
  const was = dragging;
  const target = drop && hit?.ok ? hit : null;
  const moving = sid;
  clearOverlay();
  ghost?.remove();
  ghost = null;
  dragging = false;
  sid = null;
  document.body.classList.remove('mp-dragging');
  if (!was) return;
  swallowUntil = Date.now() + 300;
  setDragSession(null);
  if (target && moving && dropOnPane(moving, target.paneId, target.zone)) return;
  render();
}

function onMove(e: PointerEvent): void {
  if (!dragging) {
    if (Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) return;
    begin(e.clientX, e.clientY);
    if (!dragging) return;
  }
  moveGhost(e.clientX, e.clientY);
  updateHit(e.clientX, e.clientY);
}

function onUp(): void { end(true); }
function onCancel(): void { end(false); }
function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !dragging) return;
  e.preventDefault();
  e.stopPropagation();
  end(false);
}

/** 在侧栏会话列表上委托拖动；启动时调用一次 */
export function initPaneDrag(): void {
  const list = byId('session-list');
  list.addEventListener('pointerdown', e => {
    if (e.button !== 0 || sid) return;
    const t = e.target as HTMLElement | null;
    const row = t?.closest<HTMLElement>('[data-role="parent"]');
    if (!row || t?.closest('.chev') || !row.dataset.sessionId) return;
    sid = row.dataset.sessionId;
    startX = e.clientX;
    startY = e.clientY;
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onCancel);
  });
  list.addEventListener('click', e => {
    if (Date.now() < swallowUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}
