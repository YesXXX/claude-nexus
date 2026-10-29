import type { ChangedFile, ChangeSummary } from '../../../shared/types';
import type { SessionChangedFile } from '../../../shared/session-change-types';
import { matchesQuery } from '../../../shared/session-view.js';
import { el, ICON_PATHS, lineIcon } from '../../core/dom.js';
import { clock, describeError, KIND_BADGE, splitPath } from './changes-format.js';

/** 改动视图的列表行与工具栏摘要：纯 DOM 构建，文件路径只用 textContent 写入 */

type SummaryLike = Pick<ChangeSummary, 'files' | 'additions' | 'deletions' | 'updatedAt' | 'error'>;

export function statText(f: ChangedFile): HTMLElement {
  const box = el('span', 'chg-stat');
  if (f.binary) {
    box.append(el('span', 'chg-dim', '二进制'));
    return box;
  }
  if (f.additions !== null) box.append(el('span', 'chg-add', `+${f.additions}`));
  if (f.deletions !== null) box.append(el('span', 'chg-del', `−${f.deletions}`));
  return box;
}

/** 目录行：过长时省略前段、保留靠近文件名的部分；bdi 隔开书写方向，路径末尾的分隔符不会被挪到开头 */
export function dirLine(dir: string, cls = 'chg-dir'): HTMLElement {
  const box = el('span', cls);
  const inner = el('bdi', '', dir);
  inner.dir = 'ltr';
  box.append(inner);
  return box;
}

/** 文件列表的一行：状态徽标、文件名与目录（重命名显示新旧路径）、扩展附加元素、增删统计 */
export function buildFileRow(f: ChangedFile, index: number, extras: Node[]): HTMLElement {
  const row = el('div', 'chg-row');
  row.dataset.index = String(index);
  row.setAttribute('role', 'option');
  const badge = KIND_BADGE[f.kind] ?? { letter: '·', title: f.kind };
  const b = el('span', `chg-badge chg-k-${f.kind}`, badge.letter);
  b.title = badge.title;
  const main = el('span', 'chg-row-main');
  const { name, dir } = splitPath(f.path);
  main.append(el('span', 'chg-name', name));
  if (f.oldPath && f.oldPath !== f.path) {
    main.append(dirLine(`${f.oldPath} → ${f.path}`));
  } else if (dir) {
    main.append(dirLine(dir));
  }
  row.title = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
  row.append(b, main, ...extras, statText(f));
  return row;
}

/** 工具栏左侧的「N 个文件 · +a −d」，更新时间写进刷新按钮的悬停提示；roots 大于 1 时补上涉及的目录数 */
export function fillSummary(
  summaryEl: HTMLElement, refreshBtn: HTMLElement, s: SummaryLike | undefined, truncated: boolean, shown: number,
  roots = 0,
): void {
  summaryEl.replaceChildren();
  refreshBtn.title = s ? `刷新改动（更新于 ${clock(s.updatedAt)}）` : '刷新改动';
  if (!s || s.error) return;
  summaryEl.append(
    `${s.files} 个文件 · `,
    el('span', 'chg-add', `+${s.additions}`),
    ' ',
    el('span', 'chg-del', `−${s.deletions}`),
  );
  if (roots > 1) summaryEl.append(el('span', 'chg-dim', ` · 跨 ${roots} 个目录`));
  if (truncated) summaryEl.append(el('span', 'chg-dim', `（仅显示前 ${shown} 个）`));
}

export const DRIFT_TIP = 'Claude 最近一次修改之后，文件又被改过';

/** 本会话改动的说明标签：来源、对比基准、过大；drift 为真时补上「改后又有变化」（列表行改用圆点表示） */
export function sessionTags(f: SessionChangedFile, drift: boolean): HTMLElement[] {
  const tags: HTMLElement[] = [];
  const tag = (text: string, title: string, cls = ''): void => {
    const t = el('span', `chg-tag${cls ? ` ${cls}` : ''}`, text);
    t.title = title;
    tags.push(t);
  };
  if (f.source === 'bash') tag('Bash', '由 Bash 命令改动，按执行前后的文件状态推断');
  if (f.tooLarge) tag('过大', '改前内容超过备份上限，未保存，不能对比与撤销', 'warn');
  else if (f.baseline === 'none') tag('无改前内容', '没有改前内容，只能看当前内容，不能撤销', 'warn');
  else if (f.baseline === 'head') tag('按 HEAD 对比', '改前已有未提交改动，按 HEAD 版本对比，不能撤销');
  if (drift && f.external) tag('改后又有变化', DRIFT_TIP, 'warn');
  return tags;
}

/** 本会话改动的一行：文件名与相对分组目录的位置、说明标签、扩展附加元素、增删统计；悬停显示完整地址 */
export function buildSessionRow(f: SessionChangedFile, index: number, extras: Node[], action?: Node | null): HTMLElement {
  const row = el('div', 'chg-row');
  row.dataset.index = String(index);
  row.setAttribute('role', 'option');
  const badge = KIND_BADGE[f.kind] ?? { letter: '·', title: f.kind };
  const b = el('span', `chg-badge chg-k-${f.kind}`, badge.letter);
  b.title = badge.title;
  const main = el('span', 'chg-row-main');
  const { name, dir } = splitPath(f.rel);
  const line = el('span', 'chg-name-line');
  line.append(el('span', 'chg-name', name));
  if (f.external) {
    const dot = el('span', 'chg-drift');
    dot.title = DRIFT_TIP;
    line.append(dot);
  }
  line.append(...sessionTags(f, false));
  main.append(line);
  if (dir) main.append(dirLine(dir));
  row.title = f.abs;
  row.append(b, main, ...extras, ...(action ? [action] : []), statText(f));
  return row;
}

/** 根目录拆成父路径与目录名，兼容正反斜杠与末尾分隔符 */
function splitRoot(root: string): { parent: string; name: string } {
  const trimmed = root.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (i < 0) return { parent: '', name: trimmed || root };
  return { parent: trimmed.slice(0, i + 1), name: trimmed.slice(i + 1) };
}

/**
 * 本会话改动的分组标题（一行）：折叠箭头、git 仓库 / 普通目录、根目录名、父路径（过长省略前段）、
 * 是否在工作目录外、文件数；点击整行折叠 / 展开，悬停出现「清除该目录记录」按钮。
 * 完整根目录在悬停提示里。
 */
export function buildGroupHead(
  f: SessionChangedFile,
  count: number,
  o: { collapsed: boolean; onToggle(): void; onClear?(): void },
): HTMLElement {
  const head = el('div', 'chg-group');
  head.setAttribute('role', 'presentation');
  head.title = f.root;
  head.dataset.root = f.root;
  const chev = el('span', `chg-chev${o.collapsed ? ' closed' : ''}`);
  chev.append(lineIcon(ICON_PATHS.chevron, 12, 1.6));
  const kind = el('span', `chg-group-kind${f.repo ? ' repo' : ''}`, f.repo ? 'git 仓库' : '普通目录');
  const { parent, name } = splitRoot(f.root);
  head.append(chev, kind, el('span', 'chg-group-name', name));
  head.append(parent ? dirLine(parent, 'chg-group-path') : el('span', 'chg-group-path'));
  if (f.outside) {
    const out = el('span', 'chg-tag warn', '工作目录外');
    out.title = '这些文件不在会话的工作目录之下';
    head.append(out);
  }
  const n = el('span', 'chg-group-count', String(count));
  n.title = `${count} 个文件`;
  head.append(n);
  if (o.onClear) {
    const clear = el('button', 'chg-x chg-group-clear', '✕');
    clear.type = 'button';
    clear.title = '清除该目录的改动记录';
    clear.addEventListener('click', e => { e.stopPropagation(); o.onClear?.(); });
    head.append(clear);
  }
  head.addEventListener('click', () => o.onToggle());
  return head;
}

/** 分组键：根目录加是否在工作目录外，同一根目录的内外两部分分开显示 */
export function groupKey(f: SessionChangedFile): string {
  return `${f.outside ? 1 : 0}|${f.root}`;
}

/** 按搜索词过滤路径（多词同时命中）；折叠分组不在这里处理，列表仍需要它们的组头 */
export function matchFiles(files: ChangedFile[], query: string): ChangedFile[] {
  const q = query.trim();
  return q ? files.filter(f => matchesQuery(q, f.path)) : files;
}

/** 可导航的文件：搜索匹配的文件里再去掉已折叠分组的行（折叠仅本会话视角有），选中与上下切换基于它 */
export function filterShown(
  files: ChangedFile[], session: boolean, query: string, collapsed: ReadonlySet<string>,
): ChangedFile[] {
  const matched = matchFiles(files, query);
  if (!session || collapsed.size === 0) return matched;
  return matched.filter(f => !collapsed.has(groupKey(f as SessionChangedFile)));
}

/** 状态占位里的单行提示 */
export function stateMsg(text: string, cls = ''): HTMLElement {
  return el('div', `chg-state-msg ${cls}`.trim(), text);
}

/** buildFileList 的可选项：分组折叠与行内 / 组头清除入口 */
export interface ListBuildOptions {
  /** 已折叠的分组键；组头仍渲染，组内的行不再生成 */
  collapsed?: ReadonlySet<string>;
  /** 点击组头折叠 / 展开 */
  onToggleGroup?(key: string): void;
  /** 行内附加操作按钮（如清除该文件记录），悬停显示 */
  rowAction?(f: ChangedFile): Node | null;
  /** 组头悬停「清除该目录记录」按钮 */
  onClearGroup?(f: SessionChangedFile, count: number): void;
}

/**
 * 整个文件列表：本会话视角按根目录分组（服务端已排好序，连续的一段就是一组），折叠组只留组头；仓库视角平铺。
 * files 是搜索匹配的全部文件（含折叠组的行，否则折叠后组头无从显示）；行上的 data-index 只给未折叠的行计数，
 * 与「可导航文件」列表（filterShown）的下标一一对应。
 */
export function buildFileList(
  files: ChangedFile[], session: boolean, extras: (f: ChangedFile) => Node[], opts: ListBuildOptions = {},
): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!session) {
    files.forEach((f, i) => frag.append(buildFileRow(f, i, extras(f))));
    return frag;
  }
  const rows = files as SessionChangedFile[];
  let index = 0;
  rows.forEach((f, i) => {
    if (i === 0 || groupKey(rows[i - 1]) !== groupKey(f)) {
      let n = 1;
      while (i + n < rows.length && groupKey(rows[i + n]) === groupKey(f)) n++;
      const key = groupKey(f);
      frag.append(buildGroupHead(f, n, {
        collapsed: opts.collapsed?.has(key) === true,
        onToggle: () => opts.onToggleGroup?.(key),
        onClear: opts.onClearGroup ? () => opts.onClearGroup?.(f, n) : undefined,
      }));
    }
    if (opts.collapsed?.has(groupKey(f))) return;
    frag.append(buildSessionRow(f, index++, extras(f), opts.rowAction?.(f) ?? null));
  });
  return frag;
}

/** 列表键盘导航：返回要选中的下标，不处理的键返回 undefined */
export function navTarget(key: string, cur: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowDown': case 'j': return cur + 1;
    case 'ArrowUp': case 'k': return cur < 0 ? 0 : cur - 1;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return undefined;
  }
}

/** 列表选择与导航控制器：持有选中文件，点击、方向键 / j k / Home End 与 diff 区的 J K 都经 pick 选中 */
export interface ListSelection {
  get(): string | undefined;
  set(path: string | undefined): void;
  /** 当前选中文件在展示列表中的下标，未选中为 -1 */
  index(): number;
  /** 按行上的 data-index 同步选中态；scroll 时滚动到可见 */
  mark(scroll: boolean): void;
  /** 选中展示列表的下标（越界收敛到两端），选中变化时经 onPick 触发 diff 调度 */
  pick(idx: number, fromKey: boolean): void;
}

export function createListSelection(p: {
  list: HTMLElement;
  /** J / K 挂在外层 host 上：焦点在 diff 区或工具栏时也能切换文件 */
  host: HTMLElement;
  /** 展示列表（过滤与折叠后的），选择始终基于它 */
  shown: () => ChangedFile[];
  onPick(path: string, fromKey: boolean): void;
}): ListSelection {
  const { list, host, shown } = p;
  let selected: string | undefined;

  const index = (): number => (selected === undefined ? -1 : shown().findIndex(f => f.path === selected));

  const mark = (scroll: boolean): void => {
    const idx = index();
    for (const row of list.querySelectorAll<HTMLElement>('.chg-row')) {
      const on = Number(row.dataset.index) === idx;
      row.classList.toggle('sel', on);
      row.setAttribute('aria-selected', String(on));
      if (on && scroll) row.scrollIntoView({ block: 'nearest' });
    }
  };

  const pick = (idx: number, fromKey: boolean): void => {
    const files = shown();
    if (files.length === 0) return;
    const i = Math.max(0, Math.min(files.length - 1, idx));
    if (files[i].path === selected) return;
    selected = files[i].path;
    mark(true);
    p.onPick(selected, fromKey);
  };

  list.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.chg-row');
    if (!row || !list.contains(row)) return;
    pick(Number(row.dataset.index), false);
  });

  list.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const next = navTarget(e.key, index(), shown().length);
    if (next === undefined) return;
    e.preventDefault();
    pick(next, true);
  });

  host.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'j' && e.key !== 'k') return;
    const t = e.target as HTMLElement;
    if (list.contains(t) || t.closest('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    pick(index() + (e.key === 'j' ? 1 : -1), true);
  });

  return {
    get: () => selected,
    set(path: string | undefined): void { selected = path; },
    index,
    mark,
    pick,
  };
}

/** 多个会话共用同一目录时的提示横幅文本；没有共用时为空串 */
export function sharedBannerText(sharedWith: number): string {
  return sharedWith > 0
    ? `该仓库还有 ${sharedWith} 个会话在同一目录工作，以下改动可能来自它们。下次新建时可勾选「独立工作区」。`
    : '';
}

/** 出错占位：超时类错误整体是一个重试按钮，普通错误显示原因加「重试」 */
export function buildErrorBox(raw: string, onRetry: () => void): HTMLElement {
  const retryButton = (text: string): HTMLButtonElement => {
    const b = el('button', 'chg-btn', text);
    b.type = 'button';
    b.addEventListener('click', onRetry);
    return b;
  };
  const info = describeError(raw);
  const box = el('div', 'chg-state-box');
  if (info.retry === 'timeout') {
    box.append(retryButton(info.text));
  } else {
    box.append(stateMsg(info.text, info.retry === 'plain' ? 'err' : ''));
    if (info.retry === 'plain') box.append(retryButton('重试'));
  }
  return box;
}
