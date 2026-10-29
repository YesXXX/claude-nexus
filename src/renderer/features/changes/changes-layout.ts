import { el, ICON_PATHS, lineIcon } from '../../core/dom.js';
import { MODE_TIPS, SCOPE_TIPS } from './changes-format.js';

/**
 * 改动视图的静态骨架：工具栏、共享目录横幅、状态占位、文件列表、分隔条与 diff 区，只建 DOM 不挂行为。
 * diff 标题固定一行：目录前段省略、文件名始终完整，次要操作收成图标按钮，完整地址在悬停提示里。
 */

export interface ChangesLayout {
  toolbar: HTMLElement;
  scopeSession: HTMLButtonElement;
  scopeRepo: HTMLButtonElement;
  summaryEl: HTMLElement;
  /** 口径切换（相对基线 / 仅未提交），仅工作区会话的仓库视角显示 */
  seg: HTMLElement;
  segBase: HTMLButtonElement;
  segWorking: HTMLButtonElement;
  wrapBtn: HTMLButtonElement;
  /** 忽略空白差异（重新拉取 diff，不只是重绘） */
  wsBtn: HTMLButtonElement;
  /** 清空本会话全部改动记录（仅本会话视角且有记录时显示） */
  clearBtn: HTMLButtonElement;
  refreshBtn: HTMLButtonElement;
  focusBtn: HTMLButtonElement;
  focusText: HTMLElement;
  banner: HTMLElement;
  /** 状态占位（加载中 / 暂无改动 / 出错），与 body 二选一显示 */
  stateEl: HTMLElement;
  body: HTMLElement;
  /** 文件列表所在的整列：搜索行加列表本体，宽度拖动与整列收起都作用在列上 */
  listCol: HTMLElement;
  /** 列表顶部的搜索行：过滤文件名 / 路径 */
  searchInput: HTMLInputElement;
  /** 搜索生效时的匹配计数（如 3 / 12），平时为空 */
  searchInfo: HTMLElement;
  list: HTMLElement;
  splitter: HTMLElement;
  diffPane: HTMLElement;
  diffHead: HTMLElement;
  listToggle: HTMLButtonElement;
  /** 文件地址：点击复制完整地址 */
  diffPath: HTMLElement;
  headStat: HTMLElement;
  headTags: HTMLElement;
  prevBtn: HTMLButtonElement;
  posEl: HTMLElement;
  nextBtn: HTMLButtonElement;
  headExtra: HTMLElement;
  copyBtn: HTMLButtonElement;
  openBtn: HTMLButtonElement;
  revealBtn: HTMLButtonElement;
  diffScroll: HTMLElement;
}

function button(text: string, cls: string, tip: string): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.title = tip;
  return b;
}

/** 图标按钮；label 给读屏用，悬停提示另写 */
function iconButton(icon: SVGSVGElement, cls: string, tip: string): HTMLButtonElement {
  const b = button('', cls, tip);
  b.setAttribute('aria-label', tip);
  b.append(icon);
  return b;
}

/** 建好骨架并挂到 host 下；初始全部隐藏，等 show() 加载后再显示 */
export function buildChangesLayout(host: HTMLElement): ChangesLayout {
  host.classList.add('chg-root');

  const toolbar = el('div', 'chg-toolbar');
  const scopeSeg = el('div', 'chg-seg chg-scope');
  const scopeSession = button('本会话改动', 'chg-seg-btn', SCOPE_TIPS.session);
  const scopeRepo = button('仓库视角', 'chg-seg-btn', SCOPE_TIPS.repo);
  scopeSession.dataset.scope = 'session';
  scopeRepo.dataset.scope = 'repo';
  scopeSeg.append(scopeSession, scopeRepo);
  const summaryEl = el('div', 'chg-summary');
  const seg = el('div', 'chg-seg');
  const segBase = button('相对基线', 'chg-seg-btn', MODE_TIPS.base);
  const segWorking = button('仅未提交', 'chg-seg-btn', MODE_TIPS.working);
  seg.append(segBase, segWorking);
  // 换行与忽略空白只用图标开关，名称与按键在悬停提示里；打开时按钮点亮
  const wrapBtn = iconButton(lineIcon(ICON_PATHS.wrap, 14, 1.5), 'chg-tool chg-wrap-btn', '自动换行：统一视图下长行折行显示（W）');
  const wsBtn = iconButton(lineIcon(ICON_PATHS.ignoreWs, 14, 1.5), 'chg-tool chg-ws-btn', '忽略空白差异（I）：只看内容变化，相当于 git diff -w');
  const clearBtn = iconButton(
    lineIcon(ICON_PATHS.trash, 14, 1.5), 'chg-tool chg-clear-btn',
    '清除记录：删除本会话全部改动记录与改前快照，之后不能再撤销到改前',
  );
  const refreshBtn = iconButton(lineIcon(ICON_PATHS.refresh, 14, 1.5), 'chg-icon-btn', '刷新改动');
  const focusBtn = button('', 'chg-tool chg-focus-btn', '专注审阅：收起会话列表与属性面板（F，Esc 退出）');
  const focusText = el('span', 'chg-focus-text', '专注审阅');
  focusBtn.append(lineIcon(ICON_PATHS.focus, 14, 1.5), focusText);
  toolbar.append(
    scopeSeg, summaryEl, el('div', 'chg-sp'), seg, wrapBtn, wsBtn, el('span', 'chg-vsep'), clearBtn, refreshBtn, focusBtn,
  );

  const banner = el('div', 'chg-banner');
  const stateEl = el('div', 'chg-state');

  const body = el('div', 'chg-body');
  const listCol = el('div', 'chg-list-col');
  const searchRow = el('div', 'chg-search-row');
  const searchInput = el('input', 'chg-search');
  searchInput.type = 'search';
  searchInput.placeholder = '搜索文件（/）';
  searchInput.setAttribute('aria-label', '搜索改动文件');
  const searchInfo = el('span', 'chg-search-info');
  searchRow.append(searchInput, searchInfo);
  const list = el('div', 'chg-list');
  list.tabIndex = 0;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', '改动文件');
  listCol.append(searchRow, list);
  const splitter = el('div', 'chg-splitter');
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-orientation', 'vertical');
  splitter.title = '拖动调整文件列表宽度，双击恢复默认';

  const diffPane = el('div', 'chg-diff');
  const diffHead = el('div', 'chg-diff-head');
  const listToggle = iconButton(lineIcon(ICON_PATHS.list, 15), 'chg-ib chg-list-toggle', '收起 / 展开文件列表（B）');
  const diffPath = el('div', 'chg-diff-path');
  const headStat = el('span', 'chg-head-stat');
  const headTags = el('span', 'chg-head-tags');
  const nav = el('span', 'chg-nav');
  const prevBtn = iconButton(lineIcon(ICON_PATHS.prev, 12, 1.6), 'chg-ib chg-prev', '上一个文件（K）');
  const posEl = el('span', 'chg-pos');
  const nextBtn = iconButton(lineIcon(ICON_PATHS.next, 12, 1.6), 'chg-ib chg-next', '下一个文件（J）');
  nav.append(prevBtn, posEl, nextBtn);
  const headExtra = el('span', 'chg-head-extra');
  const copyBtn = iconButton(lineIcon(ICON_PATHS.copy), 'chg-ib chg-copy-path', '复制该文件的完整地址');
  const openBtn = iconButton(lineIcon(ICON_PATHS.open), 'chg-ib chg-open', '用默认程序打开该文件');
  const revealBtn = iconButton(lineIcon(ICON_PATHS.reveal), 'chg-ib chg-reveal', '在资源管理器中定位该文件');
  diffHead.append(
    listToggle, diffPath, headStat, headTags, el('span', 'chg-sp'), nav, el('span', 'chg-vsep'),
    headExtra, copyBtn, openBtn, revealBtn,
  );
  const diffScroll = el('div', 'chg-diff-scroll');
  // diff 区可获得焦点，点进正文后 V 等改动视图快捷键照样生效
  diffScroll.tabIndex = -1;
  diffPane.append(diffHead, diffScroll);
  body.append(listCol, splitter, diffPane);

  host.replaceChildren(toolbar, banner, stateEl, body);
  for (const x of [stateEl, body, banner, seg, diffHead, clearBtn]) x.hidden = true;

  return {
    toolbar, scopeSession, scopeRepo, summaryEl, seg, segBase, segWorking, wrapBtn, wsBtn, clearBtn, refreshBtn,
    focusBtn, focusText, banner, stateEl, body, listCol, searchInput, searchInfo, list, splitter, diffPane, diffHead,
    listToggle, diffPath, headStat, headTags, prevBtn, posEl, nextBtn, headExtra, copyBtn, openBtn, revealBtn, diffScroll,
  };
}
