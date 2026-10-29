import type { ChangedFile } from '../../../shared/types';
import type { SessionChangedFile } from '../../../shared/session-change-types';
import { el } from '../../core/dom.js';
import { KIND_BADGE, splitPath } from './changes-format.js';
import { dirLine, sessionTags, statText } from './changes-list.js';

/**
 * diff 标题栏里随文件变化的部分：状态徽标与相对路径（目录前段可省略、文件名完整）、增删统计、说明标签、
 * 「第几个 / 共几个」与上一个、下一个按钮的可用状态。完整地址写在 data-addr 与悬停提示里，点击路径即复制。
 */

export interface DiffHeadParts {
  diffPath: HTMLElement;
  headStat: HTMLElement;
  headTags: HTMLElement;
  posEl: HTMLElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
}

export interface DiffHeadInfo {
  /** 完整地址 */
  addr: string;
  /** 是否本会话视角：路径按分组根目录的相对路径显示，并补上说明标签 */
  session: boolean;
  /** 当前文件在列表中的下标，不在列表里为 -1 */
  index: number;
  total: number;
}

export function clearDiffHead(p: DiffHeadParts): void {
  p.diffPath.replaceChildren();
  p.headStat.replaceChildren();
  p.headTags.replaceChildren();
  delete p.diffPath.dataset.addr;
}

export function fillDiffHead(p: DiffHeadParts, f: ChangedFile, info: DiffHeadInfo): void {
  clearDiffHead(p);
  const { diffPath, headStat, headTags, posEl, prevBtn, nextBtn } = p;
  const badge = KIND_BADGE[f.kind] ?? { letter: '·', title: f.kind };
  const b = el('span', `chg-badge chg-k-${f.kind}`, badge.letter);
  b.title = badge.title;
  const { name, dir } = splitPath(info.session ? (f as SessionChangedFile).rel : f.path);
  diffPath.append(b);
  if (dir) diffPath.append(dirLine(dir, 'chg-head-dir'), el('span', 'chg-head-slash', '/'));
  diffPath.append(el('span', 'chg-head-file', name));
  const renamed = !!f.oldPath && f.oldPath !== f.path;
  diffPath.dataset.addr = info.addr;
  diffPath.title = `${renamed ? `${f.oldPath} → ` : ''}${info.addr}\n点击复制完整地址`;
  headStat.append(statText(f));
  if (renamed) {
    const t = el('span', 'chg-tag', '重命名');
    t.title = `由 ${f.oldPath} 重命名而来`;
    headTags.append(t);
  }
  if (info.session) headTags.append(...sessionTags(f as SessionChangedFile, true));
  posEl.textContent = info.index < 0 ? '' : `${info.index + 1} / ${info.total}`;
  prevBtn.disabled = info.index <= 0;
  nextBtn.disabled = info.index < 0 || info.index >= info.total - 1;
}
