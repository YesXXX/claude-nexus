import type { Annotation } from '../../../shared/review-types';
import type { ChangedFile, DiffMode } from '../../../shared/types';
import { rangeFromHunk } from '../../../shared/annotation-anchor.js';
import type { AnnotationsBridge } from '../../core/api.js';
import type { ChangesHost } from '../../core/changes-ext.js';
import type { ConfirmOptions, ToastLevel } from '../../core/dialog-types.js';
import { ipcErrorText } from '../../core/dom.js';
import { annotationLocation, type AnnotationCache, locationText } from './annotation-cache.js';
import { buildEditor, type Editor } from './annotation-editor.js';
import { drawNotes, fileZone } from './annotation-notes.js';

/**
 * diff 区的批注交互：在行号栏点击或拖动选择行范围（Shift 点击扩展），松开后在结束行下方打开编辑卡片；
 * 已有批注画成行下摘要，点击可编辑。选择不能跨越分块，越界时收在起始分块内。
 * 卡片打开期间 diff 静默刷新时卡片原样保留；所选分块的标题变了说明内容已变化，保存会被拦下。
 */

export interface AnnotatorDeps {
  api: AnnotationsBridge;
  cache: AnnotationCache;
  toast(text: string, level?: ToastLevel): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
}

export interface DiffAnnotator {
  /** diff 渲染完成或批注缓存变化后重画装饰 */
  redraw(): void;
  /** 给整个文件写批注 */
  annotateFile(f: ChangedFile): void;
  edit(annId: string): void;
  /** 确认后删除一条批注 */
  remove(annId: string): void;
  /** 滚动到某条批注并短暂高亮 */
  reveal(annId: string): void;
  /** 换会话或视图隐藏：丢弃选择与卡片 */
  reset(): void;
}

interface Selection { h: number; anchor: number; from: number; to: number }

type Target =
  | { kind: 'range'; h: number; from: number; to: number; header: string }
  | { kind: 'file' }
  | { kind: 'edit'; ann: Annotation };

const GUTTER_TIP = '点击添加批注，Shift 点击选择范围';
const CROSS_HUNK = '批注范围不能跨越分块';

export function createDiffAnnotator(host: ChangesHost, deps: AnnotatorDeps): DiffAnnotator {
  const scroll = host.diffScroll;
  let sel: Selection | null = null;
  let dragging = false;
  let warnedCross = false;
  let open: { target: Target; editor: Editor; path: string } | null = null;
  let notes = new Map<string, HTMLElement>();

  const sid = (): string | undefined => host.session()?.id;
  const mode = (): DiffMode => host.mode() ?? 'working';
  // 分栏视图里删增配对的一行同时承载两个行序号：新侧在 data-i，旧侧在 data-il
  const rowAt = (h: number, i: number): HTMLElement | null =>
    scroll.querySelector<HTMLElement>(`.chg-ln[data-h="${h}"][data-i="${i}"], .chg-ln[data-h="${h}"][data-il="${i}"]`);
  const lastIndex = (h: number): number => (host.diff()?.hunks[h]?.lines.length ?? 1) - 1;
  /** 指针所在行的行序号：分栏时按点中的那一侧（半栏的 data-ci），否则取整行的 data-i */
  const indexAt = (t: EventTarget | null, row: HTMLElement): number =>
    Number((t as HTMLElement | null)?.closest?.<HTMLElement>('.chg-half')?.dataset.ci ?? row.dataset.i);

  const paint = (): void => {
    for (const r of scroll.querySelectorAll('.ann-sel')) r.classList.remove('ann-sel');
    if (!sel) return;
    for (let i = sel.from; i <= sel.to; i++) rowAt(sel.h, i)?.classList.add('ann-sel');
  };

  /** 把选择延伸到 (h, i)；跨分块时收在起始分块边界 */
  const extendTo = (h: number, i: number): void => {
    if (!sel) return;
    let target = i;
    if (h !== sel.h) {
      target = h > sel.h ? lastIndex(sel.h) : 0;
      if (!warnedCross) { deps.toast(CROSS_HUNK, 'warning'); warnedCross = true; }
    }
    sel.from = Math.min(sel.anchor, target);
    sel.to = Math.max(sel.anchor, target);
    paint();
  };

  const closeEditor = (): void => {
    open?.editor.el.remove();
    open = null;
  };

  const dirty = (): boolean => {
    if (!open) return false;
    const v = open.editor.value().trim();
    const initial = open.target.kind === 'edit' ? open.target.ann.comment : '';
    return v !== '' && v !== initial;
  };

  /** 已有卡片且写了内容时不替换，提示先处理 */
  const guard = (): boolean => {
    if (!dirty()) { closeEditor(); return true; }
    deps.toast('先保存或取消正在编辑的批注', 'warning');
    open?.editor.focus();
    return false;
  };

  const reload = (): void => { const id = sid(); if (id) void deps.cache.load(id); };

  /** 把卡片放到目标位置：行范围放在结束行下方，整个文件放在顶部区域，编辑放在原摘要处 */
  const placeEditor = (): boolean => {
    if (!open) return false;
    const t = open.target;
    const card = open.editor.el;
    if (t.kind === 'range') {
      const end = rowAt(t.h, t.to);
      if (!end) return false;
      end.after(card);
      const head = scroll.querySelector<HTMLElement>(`.chg-hunk[data-h="${t.h}"]`);
      if (head?.textContent !== t.header) open.editor.block('所选行已变化，请取消后重新选择');
      return true;
    }
    if (t.kind === 'edit') {
      const note = notes.get(t.ann.id);
      if (note) { note.after(card); note.hidden = true; return true; }
    }
    fileZone(scroll, true)!.append(card);
    return true;
  };

  const startEditor = (target: Target, title: string, initial: string, save: (c: string) => Promise<string | null>): void => {
    const f = host.selected();
    if (!f) return;
    const editor = buildEditor({
      title,
      initial,
      onSave: async (comment) => {
        const err = await save(comment);
        if (!err) { closeEditor(); sel = null; paint(); reload(); }
        return err;
      },
      onCancel: () => { closeEditor(); sel = null; paint(); redraw(); },
    });
    open = { target, editor, path: f.path };
    placeEditor();
    editor.el.scrollIntoView({ block: 'nearest' });
    editor.focus();
  };

  const openRange = (): void => {
    const f = host.selected();
    const d = host.diff();
    const id = sid();
    if (!sel || !f || !d || !id) return;
    const hunk = d.hunks[sel.h];
    const r = hunk ? rangeFromHunk(hunk, sel.from, sel.to) : { error: '分块不存在' };
    if ('error' in r) {
      deps.toast(r.error, 'warning');
      sel = null;
      paint();
      return;
    }
    const { h, from, to } = sel;
    const target: Target = { kind: 'range', h, from, to, header: hunk.header };
    startEditor(target, `批注 ${locationText(f.path, r.side, r.start, r.end)}`, '', async (comment) => {
      try {
        const res = await deps.api.add(id, { path: f.path, side: 'new', hunkIndex: h, fromLine: from, toLine: to, comment, mode: host.mode() });
        return 'error' in res ? res.error : null;
      } catch (err) { return ipcErrorText(err); }
    });
  };

  const removeAnn = async (a: Annotation): Promise<void> => {
    const id = sid();
    if (!id) return;
    const ok = await deps.confirm({ title: '删除批注', message: `删除 ${annotationLocation(a)} 上的批注？`, okText: '删除', danger: true });
    if (!ok) return;
    try {
      if (!(await deps.api.remove(id, a.id))) deps.toast('删除失败：批注可能已被删除或正在排队', 'warning');
    } catch (err) { deps.toast(ipcErrorText(err), 'error'); }
    reload();
  };

  const editAnn = (a: Annotation): void => {
    const id = sid();
    if (!id || a.status === 'queued') return;
    if (open?.target.kind === 'edit' && open.target.ann.id === a.id) { open.editor.focus(); return; }
    if (!guard()) return;
    startEditor({ kind: 'edit', ann: a }, `编辑批注 ${annotationLocation(a)}`, a.comment, async (comment) => {
      try {
        return (await deps.api.update(id, a.id, comment)) ? null : '保存失败：批注可能已被删除或正在排队';
      } catch (err) { return ipcErrorText(err); }
    });
  };

  function redraw(): void {
    const f = host.selected();
    const d = host.diff();
    // 批注按仓库相对路径记录，只在仓库视角下绘制与新增
    if (!f || !d || host.scope() !== 'repo') { notes = new Map(); return; }
    if (open && open.path !== f.path) closeEditor();
    notes = drawNotes(scroll, deps.cache.get(sid()), f, mode(), { edit: editAnn, remove: a => void removeAnn(a) });
    if (open && !open.editor.el.isConnected) placeEditor();
    if (open?.target.kind === 'edit') notes.get(open.target.ann.id)?.toggleAttribute('hidden', true);
    paint();
  }

  // ---- 行号栏选择 ----

  const gutterRow = (t: EventTarget | null): HTMLElement | null => {
    if (host.scope() !== 'repo') return null;
    const no = (t as HTMLElement | null)?.closest?.('.chg-no');
    const row = no?.closest<HTMLElement>('.chg-ln:not(.meta)');
    return row && scroll.contains(row) ? row : null;
  };

  scroll.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const row = gutterRow(e.target);
    if (!row) return;
    e.preventDefault();
    const h = Number(row.dataset.h);
    const i = indexAt(e.target, row);
    warnedCross = false;
    if (open && !guard()) return;
    if (e.shiftKey && sel) {
      extendTo(h, i);
    } else {
      sel = { h, anchor: i, from: i, to: i };
      paint();
    }
    dragging = true;
  });

  scroll.addEventListener('mouseover', (e) => {
    if (host.scope() !== 'repo') return;
    const row = gutterRow(e.target) ?? (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.chg-ln:not(.meta)');
    if (!row) return;
    const no = (e.target as HTMLElement).closest?.<HTMLElement>('.chg-no');
    if (no && !no.title) no.title = GUTTER_TIP;
    if (dragging && sel) extendTo(Number(row.dataset.h), indexAt(e.target, row));
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    if (sel && !open) openRange();
  });

  return {
    redraw,
    annotateFile(f: ChangedFile): void {
      const id = sid();
      if (!id || host.selected()?.path !== f.path) return;
      if (open?.target.kind === 'file') { open.editor.focus(); return; }
      if (!guard()) return;
      sel = null;
      paint();
      startEditor({ kind: 'file' }, `批注 ${locationText(f.path, 'file', 0, 0)}`, '', async (comment) => {
        try {
          const res = await deps.api.add(id, { path: f.path, side: 'file', comment, mode: host.mode() });
          return 'error' in res ? res.error : null;
        } catch (err) { return ipcErrorText(err); }
      });
    },
    edit(annId: string): void {
      const a = deps.cache.get(sid())?.items.find(x => x.id === annId);
      if (a) editAnn(a);
    },
    remove(annId: string): void {
      const a = deps.cache.get(sid())?.items.find(x => x.id === annId);
      if (a) void removeAnn(a);
    },
    reveal(annId: string): void {
      const note = notes.get(annId);
      if (!note) return;
      note.scrollIntoView({ block: 'center' });
      note.classList.remove('flash');
      void note.offsetWidth;
      note.classList.add('flash');
    },
    reset(): void {
      closeEditor();
      sel = null;
      dragging = false;
      notes = new Map();
    },
  };
}
