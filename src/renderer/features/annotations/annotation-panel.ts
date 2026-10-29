import type { Annotation, AnnotationList } from '../../../shared/review-types';
import type { ChangedFile, Session } from '../../../shared/types';
import type { ChangesHost } from '../../core/changes-ext.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { annotationTag, checkOf, currentRange, itemsForFile, locationText, pendingCount } from './annotation-cache.js';
import type { DiffAnnotator } from './diff-annotator.js';
import { cancelQueued, copyAnnotations, sendAnnotations, type SendDeps } from './send-flow.js';

/**
 * 改动视图里的批注入口：工具栏下方的批注横条（待发送条数、发送、排队状态），
 * diff 区右侧的批注抽屉（全部批注与已发送记录），文件列表行尾的批注标记与 diff 头部的「批注文件」。
 */

export interface PanelDeps extends SendDeps {
  get(id: string | undefined): AnnotationList | undefined;
}

export interface AnnotationPanel {
  bar: HTMLElement;
  drawer: HTMLElement;
  render(): void;
  openDrawer(): void;
  closeDrawer(): void;
  rowMark(f: ChangedFile): Node | null;
  headAction(f: ChangedFile): Node | null;
}

const READ_ONLY = '此会话由其他面板实例运行，只能查看，不能执行写操作';
const EXITED = '会话进程已退出';

/** 不能发送的原因；可以发送时为空 */
export function sendBlockReason(s: Session | undefined): string {
  if (!s) return '';
  if (s.readOnly) return READ_ONLY;
  if (s.status === 'suspended' || s.status === 'disconnected' || s.exitCode !== undefined || s.dormant) return EXITED;
  return '';
}

function btn(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return b;
}

export function createAnnotationPanel(host: ChangesHost, annotator: DiffAnnotator, deps: PanelDeps): AnnotationPanel {
  const bar = el('div', 'ann-bar');
  const drawer = el('div', 'ann-drawer');
  bar.hidden = true;
  drawer.hidden = true;
  let drawerOpen = false;

  const sid = (): string | undefined => host.session()?.id;
  const list = (): AnnotationList | undefined => deps.get(sid());

  /** 先选中批注所在文件并等待 diff 渲染，再交给 diff 区处理；批注按仓库相对路径记录，需要时先切到仓库视角 */
  const goto = async (a: Annotation, then: (id: string) => void): Promise<void> => {
    if (host.scope() !== 'repo') await host.setScope('repo');
    const ok = await host.selectPath(a.path) || (!!a.oldPath && await host.selectPath(a.oldPath));
    if (!ok) { deps.toast('该文件已不在改动列表中', 'warning'); return; }
    then(a.id);
  };

  const renderBar = (): void => {
    const s = host.session();
    const l = list();
    const items = l?.items ?? [];
    const pending = pendingCount(items);
    const queued = items.filter(a => a.status === 'queued').length;
    const sent = items.filter(a => a.status === 'sent').length;
    bar.replaceChildren();
    bar.hidden = items.length === 0;
    if (bar.hidden || !s) return;
    const id = s.id;
    bar.append(el('span', 'ann-bar-mark', '◆'));
    if (queued) {
      bar.append(el('span', 'ann-bar-text', `批注 ${queued} 条 · 本轮结束后发送`));
      bar.append(btn('取消排队', 'chg-btn', () => void cancelQueued(id, deps)));
    } else if (pending) {
      bar.append(el('span', 'ann-bar-text', `批注 ${pending} 条待发送`));
    } else {
      bar.append(el('span', 'ann-bar-text dim', `批注 ${sent} 条已发送`));
    }
    if (queued && pending) bar.append(el('span', 'ann-bar-sub', `另有 ${pending} 条待发送`));
    bar.append(el('span', 'chg-sp'));
    bar.append(btn(drawerOpen ? '收起' : '查看', 'chg-btn ann-view', () => (drawerOpen ? closeDrawer() : openDrawer())));
    if (pending && !queued) {
      const send = btn('发送给 Claude', 'chg-btn primary ann-send', () => void sendAnnotations(id, deps));
      const why = sendBlockReason(s);
      if (why) { send.disabled = true; send.title = why; }
      bar.append(send);
    }
  };

  const itemRow = (a: Annotation, l: AnnotationList | undefined): HTMLElement => {
    const c = checkOf(l, a.id);
    const r = currentRange(a, c);
    const row = el('div', `ann-item st-${a.status}`);
    row.dataset.ann = a.id;
    const head = el('div', 'ann-item-head');
    const loc = el('span', 'ann-item-loc', locationText(a.path, a.side, r.start, r.end));
    loc.title = loc.textContent ?? '';
    head.append(loc);
    const tag = annotationTag(a, c);
    if (tag?.text) {
      const t = el('span', `ann-tag ${tag.cls}`, tag.text);
      t.title = tag.title;
      head.append(t);
    }
    head.append(el('span', 'chg-sp'));
    const locked = a.status === 'queued';
    if (a.status !== 'sent') {
      const e = btn('编辑', 'ann-link', () => void goto(a, x => annotator.edit(x)));
      e.disabled = locked;
      head.append(e);
    }
    const d = btn('删', 'ann-link', () => annotator.remove(a.id));
    d.disabled = locked;
    if (locked) d.title = '排队中的批注不能修改，先取消排队';
    head.append(d);
    row.append(head, el('div', 'ann-item-body', a.comment));
    row.addEventListener('click', () => void goto(a, x => annotator.reveal(x)));
    return row;
  };

  const renderDrawer = (): void => {
    drawer.hidden = !drawerOpen;
    if (!drawerOpen) return;
    const l = list();
    const items = l?.items ?? [];
    const live = items.filter(a => a.status !== 'sent');
    const sent = items.filter(a => a.status === 'sent');
    const id = sid();
    const head = el('div', 'ann-drawer-head');
    head.append(el('span', 'ann-drawer-title', `批注（${live.length}）`), el('span', 'chg-sp'));
    if (id) {
      head.append(btn('复制为文本', 'ann-link', () => void copyAnnotations(id, deps)));
      if (sent.length) {
        head.append(btn('清除已发送', 'ann-link', () => void (async () => {
          try { await deps.api.remove(id, 'all-sent'); } catch (err) { deps.toast(ipcErrorText(err), 'error'); }
          deps.reload(id);
        })()));
      }
    }
    const close = btn('✕', 'chg-icon-btn ann-drawer-close', closeDrawer);
    close.title = '关闭';
    head.append(close);
    const body = el('div', 'ann-drawer-body');
    if (!live.length) body.append(el('div', 'ann-empty', '没有待发送的批注。在 diff 行号栏点击或拖动即可添加。'));
    for (const a of live) body.append(itemRow(a, l));
    if (sent.length) {
      body.append(el('div', 'ann-sent-sep', `已发送（${sent.length}）`));
      for (const a of sent) body.append(itemRow(a, l));
    }
    drawer.replaceChildren(head, body);
  };

  function openDrawer(): void {
    drawerOpen = true;
    renderDrawer();
    renderBar();
  }

  function closeDrawer(): void {
    drawerOpen = false;
    renderDrawer();
    renderBar();
  }

  return {
    bar,
    drawer,
    render(): void { renderBar(); renderDrawer(); },
    openDrawer,
    closeDrawer,
    rowMark(f: ChangedFile): Node | null {
      const items = itemsForFile(list(), f.path, f.oldPath).filter(a => a.status !== 'sent');
      if (!items.length) return null;
      const m = el('span', 'ann-row-mark', `◆${items.length}`);
      m.title = `${items.length} 条批注未发送`;
      return m;
    },
    headAction(f: ChangedFile): Node | null {
      if (!sid()) return null;
      const b = btn('批注文件', 'chg-btn ann-file-btn', () => annotator.annotateFile(f));
      b.title = '给整个文件写一条批注';
      return b;
    },
  };
}
