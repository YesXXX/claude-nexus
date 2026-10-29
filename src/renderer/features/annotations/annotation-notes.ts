import type { Annotation, AnnotationList } from '../../../shared/review-types';
import type { ChangedFile, DiffMode } from '../../../shared/types';
import { el } from '../../core/dom.js';
import { annotationTag, checkOf, currentRange, itemsForFile, locationText } from './annotation-cache.js';

/**
 * 在 diff 区画出某文件已有的批注：所在行的行号栏加圆点，结束行下方插入批注摘要；
 * 整个文件的批注、以及按行号找不到所在行的批注（已失效、旧侧口径不同等）放在 diff 顶部的区域。
 * 批注正文只用 textContent 写入。
 */

export interface NoteActions {
  edit(a: Annotation): void;
  remove(a: Annotation): void;
}

const NOTE_SEL = '.ann-note, .ann-file-zone';

export function clearNotes(scroll: HTMLElement): void {
  for (const n of scroll.querySelectorAll(NOTE_SEL)) n.remove();
  for (const n of scroll.querySelectorAll('.ann-has')) {
    n.classList.remove('ann-has');
    const no = n.querySelectorAll<HTMLElement>('.chg-no')[1];
    if (no) no.title = '';
  }
}

/** diff 顶部的批注区，不存在时按需创建 */
export function fileZone(scroll: HTMLElement, create: boolean): HTMLElement | null {
  let zone = scroll.querySelector<HTMLElement>(':scope > .ann-file-zone');
  if (!zone && create) {
    zone = el('div', 'ann-file-zone');
    scroll.prepend(zone);
  }
  return zone;
}

const rowBy = (scroll: HTMLElement, attr: 'n' | 'o', no: number, cls = ''): HTMLElement | null =>
  scroll.querySelector<HTMLElement>(`.chg-ln${cls}[data-${attr}="${no}"]`);

/** 批注在当前 diff 中覆盖的行（按结束行在后排列），找不到结束行时返回空数组 */
export function rowsOf(scroll: HTMLElement, a: Annotation, list: AnnotationList | undefined, mode: DiffMode): HTMLElement[] {
  if (a.side === 'file') return [];
  const c = checkOf(list, a.id);
  if (a.side === 'new') {
    if (c?.validity === 'stale') return [];
    const r = currentRange(a, c);
    const out: HTMLElement[] = [];
    for (let n = r.start; n <= r.end; n++) {
      const row = rowBy(scroll, 'n', n);
      if (row) out.push(row);
    }
    return rowBy(scroll, 'n', r.end) ? out : [];
  }
  // 只选了删除行：旧文件行号只在同一口径下有意义
  if (a.mode !== mode) return [];
  const out: HTMLElement[] = [];
  for (let o = a.start; o <= a.end; o++) {
    const row = rowBy(scroll, 'o', o, '.del') ?? rowBy(scroll, 'o', o);
    if (row) out.push(row);
  }
  return out.length && out[out.length - 1].dataset.o === String(a.end) ? out : [];
}

function buildNote(a: Annotation, list: AnnotationList | undefined, act: NoteActions, showLoc: boolean): HTMLElement {
  const c = checkOf(list, a.id);
  const note = el('div', `ann-note st-${a.status}`);
  note.dataset.ann = a.id;
  const head = el('div', 'ann-note-head');
  head.append(el('span', 'ann-note-mark', '◆'));
  if (showLoc) {
    const r = currentRange(a, c);
    head.append(el('span', 'ann-note-loc', locationText(a.path, a.side, r.start, r.end)));
  }
  const tag = annotationTag(a, c);
  if (tag && tag.text) {
    const t = el('span', `ann-tag ${tag.cls}`, tag.text);
    t.title = tag.title;
    head.append(t);
  }
  head.append(el('span', 'chg-sp'));
  const editBtn = el('button', 'ann-link', '编辑');
  const delBtn = el('button', 'ann-link', '删');
  editBtn.type = 'button';
  delBtn.type = 'button';
  const locked = a.status === 'queued';
  editBtn.disabled = locked;
  delBtn.disabled = locked;
  if (locked) {
    editBtn.title = '排队中的批注不能修改，先取消排队';
    delBtn.title = editBtn.title;
  }
  editBtn.addEventListener('click', e => { e.stopPropagation(); act.edit(a); });
  delBtn.addEventListener('click', e => { e.stopPropagation(); act.remove(a); });
  head.append(editBtn, delBtn);
  const body = el('div', 'ann-note-body', a.comment);
  body.title = locked ? '' : '点击编辑';
  note.append(head, body);
  note.addEventListener('mousedown', e => e.stopPropagation());
  note.addEventListener('click', () => { if (!locked) act.edit(a); });
  return note;
}

/** 重画某文件的批注装饰；返回各批注对应的摘要元素，供定位与编辑时替换 */
export function drawNotes(
  scroll: HTMLElement, list: AnnotationList | undefined, f: ChangedFile, mode: DiffMode, act: NoteActions,
): Map<string, HTMLElement> {
  clearNotes(scroll);
  const notes = new Map<string, HTMLElement>();
  const items = itemsForFile(list, f.path, f.oldPath);
  const lastAfter = new Map<HTMLElement, HTMLElement>();
  const loose: Annotation[] = [];
  for (const a of items) {
    const rows = rowsOf(scroll, a, list, mode);
    if (!rows.length) { loose.push(a); continue; }
    for (const row of rows) {
      row.classList.add('ann-has');
      const no = row.querySelectorAll<HTMLElement>('.chg-no')[1];
      if (no) no.title = a.comment;
    }
    const end = rows[rows.length - 1];
    const note = buildNote(a, list, act, false);
    (lastAfter.get(end) ?? end).after(note);
    lastAfter.set(end, note);
    notes.set(a.id, note);
  }
  if (loose.length) {
    const zone = fileZone(scroll, true)!;
    for (const a of loose) {
      const note = buildNote(a, list, act, true);
      zone.append(note);
      notes.set(a.id, note);
    }
  }
  return notes;
}
