import type { ChangedFile, DiffMode, FileDiff, Session } from '../../../shared/types';
import type { SessionChangedFile } from '../../../shared/session-change-types';
import type { ChangesHost, ChangesScope } from '../../core/changes-ext.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { joinAddress } from './changes-format.js';
import { createClearControls } from './changes-clear.js';
import { buildChangesLayout } from './changes-layout.js';
import {
  buildFileList, createListSelection, filterShown, fillSummary, matchFiles, stateMsg,
} from './changes-list.js';
import { bindSearchBox } from './changes-search.js';
import { createShell } from './changes-state.js';
import { fetchList, type ChangesApi, type ChangesView, type ChangesViewOptions, type ListResult } from './changes-types.js';
import { clearDiffHead, fillDiffHead } from './diff-head.js';
import { ignoreWs, onDiffPrefs } from './diff-prefs.js';
import { createDiffPresenter } from './diff-present.js';
import { createExtRunner } from './ext-runner.js';
import { bindHeadActions } from './head-actions.js';
import { bindFocusButton, bindLayoutControls } from './layout-controls.js';
import { collapsedGroups, toggleCollapsedGroup } from './layout-prefs.js';

export type { ChangesApi, ChangesView, ChangesViewOptions } from './changes-types.js';

/**
 * 会话详情里的「改动」视图：左侧改动文件列表（顶部搜索框），右侧单文件 diff（统一或左右分栏）。
 * 默认按本会话视角列出 Claude 动过的全部文件（跨仓库、非 git 目录也有，按根目录分组，组头可折叠并记忆），
 * 可切到仓库视角查看工作目录所在仓库的 git 改动；diff 标题一行显示相对路径，完整地址在悬停提示里、点击即复制。
 * 本会话视角可清除改动记录（行内、组头、工具栏三个粒度，见 changes-clear）。
 * 文件列表可拖动调宽、可整列收起，统一视图可开自动换行，都给 diff 让出宽度。
 * 所有异步加载都带序号、会话 id 与视角，视图隐藏、会话或视角切换、有更新的请求时丢弃迟到的结果。
 * 文件内容不可信，只用 textContent 写入，不拼 HTML。
 */

/** 键盘连续切换文件时，diff 请求稍作合并，避免按住方向键时排队一串 git diff */
const KEY_DIFF_DELAY_MS = 60;

export function createChangesView(host: HTMLElement, api: ChangesApi, opts: ChangesViewOptions): ChangesView {
  const {
    scopeSession, scopeRepo, summaryEl, seg, segBase, segWorking, wrapBtn, wsBtn, clearBtn, refreshBtn,
    focusBtn, focusText, banner, stateEl, body, listCol, searchInput, searchInfo, list, splitter, diffPane, diffHead,
    listToggle, diffPath, headStat, headTags, prevBtn, posEl, nextBtn, headExtra, copyBtn, openBtn, revealBtn, diffScroll,
  } = buildChangesLayout(host);

  // ---- 状态 ----
  const modes = new Map<string, DiffMode>();
  const scopes = new Map<string, ChangesScope>();
  let sessionId: string | undefined;
  let isWorktree = false;
  let visible = false;
  let loadedOnce = false;          // 当前会话与视角是否已成功拿到过一次列表，决定是否显示「正在统计改动…」
  let listSeq = 0;
  let diffSeq = 0;
  let listLoading = false;
  let lastSeenAt: number | undefined;   // 已处理过的摘要时间戳
  let pendingAt: number | undefined;    // 列表加载中收到的更新时间戳，加载完再比较是否需要补拉
  let files: ChangedFile[] = [];
  let shown: ChangedFile[] = [];        // 可导航的文件：matched 去掉折叠分组的行，选中与上下切换基于它
  let matched: ChangedFile[] = [];      // 搜索匹配的全部文件（含折叠分组的行，列表据此渲染组头）
  const collapsed = collapsedGroups();  // 已折叠的分组键（跨会话记忆）
  let filesScope: ChangesScope = 'session';   // files 所属的视角
  let repoRoot: string | undefined;     // 仓库视角下解析出的仓库根，拼完整地址用
  let shownDiffPath: string | undefined;   // diff 区当前展示内容所属的文件
  let diffTimer: number | undefined;
  let currentSession: Session | undefined;
  let shownDiff: FileDiff | undefined;    // diff 区当前展示的结果，与 shownDiffPath 对应

  const currentScope = (): ChangesScope => (sessionId ? scopes.get(sessionId) ?? 'session' : 'session');

  // 选中态：展示列表上的点击、方向键、J / K 都经它选中，选中变化后调度 diff
  const sel = createListSelection({
    list, host, shown: () => shown,
    onPick: (_path, fromKey) => scheduleDiff(fromKey ? KEY_DIFF_DELAY_MS : 0),
  });
  const selectedIndex = sel.index;
  const markSelected = sel.mark;
  const selectIndex = sel.pick;

  const search = bindSearchBox(searchInput, searchInfo, list, () => applyFilter());
  const clearer = createClearControls({
    api, opts, btn: clearBtn,
    session: () => currentSession, sessionId: () => sessionId, scope: () => filesScope,
    filesCount: () => files.length, refresh: () => view.refresh(),
  });

  const currentMode = (): DiffMode | undefined => {
    if (!isWorktree || !sessionId || currentScope() !== 'repo') return undefined;
    return modes.get(sessionId) ?? 'base';
  };

  const stale = (token: number, seqNow: number, id: string | undefined, sc: ChangesScope): boolean =>
    token !== seqNow || !visible || id !== sessionId || sc !== currentScope();

  const renderMode = (): void => {
    const sc = currentScope();
    scopeSession.classList.toggle('on', sc === 'session');
    scopeRepo.classList.toggle('on', sc === 'repo');
    seg.hidden = !isWorktree || sc !== 'repo';
    const m = currentMode();
    segBase.classList.toggle('on', m === 'base');
    segWorking.classList.toggle('on', m === 'working');
    list.setAttribute('aria-label', sc === 'session' ? '本会话改动的文件' : '仓库改动文件');
    clearer.sync();
  };

  const shell = createShell({ stateEl, body, banner, refreshBtn });
  const { showState, renderBanner, setBusy } = shell;
  const showError = (raw: string): void => shell.showError(raw, () => view.refresh());

  /** 文件的完整地址：本会话视角自带，仓库视角由仓库根与相对路径拼出（根未知时退回相对路径） */
  const addressOf = (f: ChangedFile): string => {
    if (filesScope === 'session') return (f as SessionChangedFile).abs;
    return repoRoot ? joinAddress(repoRoot, f.path) : f.path;
  };

  /** 重算列表：matched 为搜索匹配的全部文件（折叠组的组头靠它渲染），shown 再去掉折叠组的行，选中与导航基于 shown */
  const computeShown = (): void => {
    const session = filesScope === 'session';
    matched = matchFiles(files, search.query());
    shown = filterShown(files, session, search.query(), collapsed);
    search.sync(matched.length, files.length);
  };

  /** 清掉选中与 diff 区（选中文件被过滤掉或记录被清除时） */
  const clearSelection = (): void => {
    sel.set(undefined);
    shownDiffPath = undefined;
    shownDiff = undefined;
    diffSeq++;
    renderDiffHead(undefined);
    presenter.clear();
  };

  const runner = createExtRunner();
  const { each, collect } = runner;
  // 偏好变化原地重绘、大 diff 分批补齐后，让扩展按新内容重画装饰
  const presenter = createDiffPresenter(diffScroll, () => {
    const f = shown.find(x => x.path === shownDiffPath);
    const d = shownDiff;
    if (f && d && shownDiffPath === sel.get()) each(x => x.diffRendered?.(f, d));
  });
  // 「统一 / 分栏」放在口径切换右侧，没有口径按钮时它仍显示
  seg.after(presenter.control);

  // ---- 文件列表 ----

  const renderList = (): void => {
    const top = list.scrollTop;
    const session = filesScope === 'session';
    // 搜索没有匹配时列表列里给占位，搜索框仍在原位可继续修改
    if (matched.length === 0) {
      list.replaceChildren(stateMsg('没有匹配的文件', 'dim'));
      return;
    }
    list.replaceChildren(buildFileList(matched, session, f => collect(x => x.rowExtras?.(f)), {
      collapsed: session ? collapsed : undefined,
      onToggleGroup: key => { toggleCollapsedGroup(key); applyFilter(); },
      rowAction: f => clearer.rowAction(f),
      onClearGroup: (f, n) => { void clearer.clearGroup(f, n); },
    }));
    list.scrollTop = top;
  };

  /** 搜索词或分组折叠变化后：重算并重绘，选中的文件仍可导航则保持，否则选第一个可导航的；没有可导航文件则清空 diff 区 */
  const applyFilter = (): void => {
    computeShown();
    renderList();
    if (shown.length === 0) {
      clearSelection();
      return;
    }
    if (!shown.some(f => f.path === sel.get())) {
      sel.set(shown[0].path);
      scheduleDiff(0);
    }
    markSelected(true);
  };

  // ---- diff ----

  const headParts = { diffPath, headStat, headTags, posEl, prevBtn, nextBtn };
  const renderDiffHead = (f: ChangedFile | undefined): void => {
    headExtra.replaceChildren();
    diffHead.hidden = !f;
    if (!f) {
      clearDiffHead(headParts);
      return;
    }
    headExtra.append(...collect(x => x.headActions?.(f)));
    fillDiffHead(headParts, f, { addr: addressOf(f), session: filesScope === 'session', index: selectedIndex(), total: shown.length });
  };

  const loadDiff = async (): Promise<void> => {
    const id = sessionId;
    const sc = currentScope();
    const f = shown.find(x => x.path === sel.get());
    const token = ++diffSeq;
    if (!id || !f) {
      shownDiffPath = undefined;
      shownDiff = undefined;
      renderDiffHead(undefined);
      presenter.clear();
      return;
    }
    renderDiffHead(f);
    // 换了文件时立即清掉旧内容，绝不让上一个文件的 diff 挂在新文件名下；同一文件刷新则保留旧内容直到新结果到达
    if (shownDiffPath !== f.path) {
      shownDiffPath = f.path;
      shownDiff = undefined;
      presenter.clear(el('div', 'chg-diff-loading', '正在加载…'));
      diffScroll.scrollTop = 0;
      diffScroll.scrollLeft = 0;
    }
    let d: FileDiff;
    try {
      d = sc === 'session'
        ? await api.sessionChanges.fileDiff(id, f.path, ignoreWs())
        : await api.fileDiff(id, f.path, currentMode(), ignoreWs());
    } catch (err) {
      if (stale(token, diffSeq, id, sc)) return;
      d = { path: f.path, binary: false, truncated: false, hunks: [], error: ipcErrorText(err) };
    }
    if (stale(token, diffSeq, id, sc) || sel.get() !== f.path) return;
    // 同一文件静默刷新时保持滚动位置，避免正在看的行跳走
    presenter.render(d);
    shownDiff = d;
    each(x => x.diffRendered?.(f, d));
  };

  const scheduleDiff = (delay: number): void => {
    window.clearTimeout(diffTimer);
    diffTimer = undefined;
    if (delay <= 0) { void loadDiff(); return; }
    // 等待期间先作废进行中的请求并切换标题，避免旧结果落到新选中的文件上
    diffSeq++;
    const f = shown.find(x => x.path === sel.get());
    renderDiffHead(f);
    if (f && shownDiffPath !== f.path) {
      shownDiffPath = undefined;
      presenter.clear();
    }
    diffTimer = window.setTimeout(() => { diffTimer = undefined; void loadDiff(); }, delay);
  };

  // ---- 列表加载 ----

  const clearFiles = (): void => {
    files = [];
    shown = [];
    matched = [];
    list.replaceChildren();
    shownDiffPath = undefined;
    diffSeq++;
    clearer.sync();
    search.sync(0, 0);
  };

  /** 清空列表、选中与 diff（换会话或换视角时） */
  const resetContent = (): void => {
    clearFiles();
    loadedOnce = false;
    lastSeenAt = undefined;
    pendingAt = undefined;
    repoRoot = undefined;
    sel.set(undefined);
    shownDiff = undefined;
    window.clearTimeout(diffTimer);
    diffTimer = undefined;
    list.scrollTop = 0;
    presenter.clear();
    renderDiffHead(undefined);
    fillSummary(summaryEl, refreshBtn, undefined, false, 0);
    renderBanner(0);
  };

  const applyList = (res: ListResult, sc: ChangesScope): void => {
    fillSummary(summaryEl, refreshBtn, res.summary, res.truncated, res.files.length, res.roots);
    renderBanner(res.sharedWith);
    filesScope = sc;
    repoRoot = res.root;
    if (res.summary.error) {
      clearFiles();
      showError(res.summary.error);
      return;
    }
    const prevIdx = selectedIndex();
    files = res.files;
    computeShown();
    clearer.sync();
    if (files.length === 0) {
      clearFiles();
      showState(stateMsg('暂无改动'));
      return;
    }
    showState(null);
    renderList();
    // 搜索无匹配或分组全部折叠时没有可选文件：清空 diff 区，列表里的组头 / 占位仍可操作
    if (shown.length === 0) {
      clearSelection();
      return;
    }
    // 选中的文件仍可导航则保持；不可见就停在原来的位置附近；首次加载选第一个
    if (sel.get() === undefined || !shown.some(f => f.path === sel.get())) {
      const i = prevIdx < 0 ? 0 : Math.min(prevIdx, shown.length - 1);
      sel.set(shown[i].path);
    }
    markSelected(true);
    scheduleDiff(0);
  };

  const loadList = async (quiet: boolean): Promise<void> => {
    const id = sessionId;
    if (!id || !visible) return;
    const sc = currentScope();
    const token = ++listSeq;
    const mode = currentMode();
    listLoading = true;
    pendingAt = undefined;
    setBusy(true);
    if (!quiet) showState(stateMsg('正在统计改动…', 'dim'));
    let res: ListResult;
    try {
      res = await fetchList(api, id, sc, mode);
    } catch (err) {
      if (stale(token, listSeq, id, sc)) return;
      listLoading = false;
      setBusy(false);
      clearFiles();
      showError(ipcErrorText(err));
      return;
    }
    if (stale(token, listSeq, id, sc)) return;
    listLoading = false;
    setBusy(false);
    loadedOnce = true;
    lastSeenAt = res.summary.updatedAt;
    applyList(res, sc);
    // 加载期间后台又统计出了更新的摘要：静默补拉一次
    const later = pendingAt;
    pendingAt = undefined;
    if (later !== undefined && later > res.summary.updatedAt) void loadList(true);
  };

  const switchScope = (sc: ChangesScope): Promise<void> => {
    if (!sessionId || currentScope() === sc) return Promise.resolve();
    scopes.set(sessionId, sc);
    resetContent();
    renderMode();
    each(x => x.scopeChanged?.(sc));
    return visible ? loadList(false) : Promise.resolve();
  };

  // ---- 事件 ----

  scopeSession.addEventListener('click', () => void switchScope('session'));
  scopeRepo.addEventListener('click', () => void switchScope('repo'));
  segBase.addEventListener('click', () => { if (currentMode() !== 'base') view.toggleMode(); });
  segWorking.addEventListener('click', () => { if (currentMode() !== 'working') view.toggleMode(); });
  refreshBtn.addEventListener('click', () => view.refresh());

  bindHeadActions({ openBtn, revealBtn, copyBtn, diffPath, prevBtn, nextBtn }, {
    api, toast: opts.toast, sessionId: () => sessionId, selectedPath: sel.get,
    selectedFile: () => files.find(x => x.path === sel.get()), addressOf, isSession: () => filesScope === 'session',
    shownDiff: () => shownDiff, step: delta => selectIndex(selectedIndex() + delta, false),
  });

  bindLayoutControls({ host, body, listCol, splitter, wrapBtn, wsBtn, listToggle });
  const syncFocusBtn = bindFocusButton({ focusBtn, focusText }, opts.focusMode);

  // 忽略空白口径变化：diff 内容本身变了，清掉当前内容按新口径重新拉取（其余偏好只影响绘制）
  let lastWs = ignoreWs();
  onDiffPrefs(() => {
    const ws = ignoreWs();
    if (ws === lastWs) return;
    lastWs = ws;
    if (!visible || !sessionId || sel.get() === undefined) return;
    shownDiffPath = undefined;
    scheduleDiff(0);
  });

  const extHost: ChangesHost = {
    session: () => currentSession,
    scope: currentScope,
    mode: currentMode,
    files: () => shown,
    selected: () => shown.find(f => f.path === sel.get()),
    diff: () => (shownDiffPath !== undefined && shownDiffPath === sel.get() ? shownDiff : undefined),
    diffScroll,
    async selectPath(path: string): Promise<boolean> {
      if (!shown.some(f => f.path === path)) return false;
      if (sel.get() !== path || !shownDiff || shownDiffPath !== path) {
        window.clearTimeout(diffTimer);
        diffTimer = undefined;
        sel.set(path);
        markSelected(true);
        await loadDiff();
      }
      return sel.get() === path && shownDiffPath === path && !!shownDiff;
    },
    setScope: switchScope,
    rerenderRows(): void {
      if (files.length === 0) return;
      renderList();
      markSelected(false);
    },
    rerenderHead: () => renderDiffHead(files.find(f => f.path === sel.get())),
    refresh: () => view.refresh(),
  };
  // 扩展横条放在横幅之后、主体之前；浮层挂在 diff 区内
  for (const x of runner.attach(opts.extensions ?? [], extHost)) {
    if (x.bar) host.insertBefore(x.bar, stateEl);
    if (x.overlay) diffPane.append(x.overlay);
  }

  const view: ChangesView = {
    show(session: Session): void {
      visible = true;
      isWorktree = !!session.worktree;
      currentSession = session;
      if (session.id !== sessionId) {
        sessionId = session.id;
        resetContent();
      }
      renderMode();
      syncFocusBtn();
      each(x => x.show?.(session));
      void loadList(loadedOnce);
    },

    hide(): void {
      visible = false;
      listSeq++;
      diffSeq++;
      listLoading = false;
      pendingAt = undefined;
      window.clearTimeout(diffTimer);
      diffTimer = undefined;
      search.cancel();
      setBusy(false);
      presenter.pause();
      each(x => x.hide?.());
    },

    refresh(): void {
      if (!visible || !sessionId) return;
      void loadList(loadedOnce);
    },

    toggleMode(): void {
      if (!isWorktree || !sessionId || !visible || currentScope() !== 'repo') return;
      modes.set(sessionId, currentMode() === 'base' ? 'working' : 'base');
      renderMode();
      // 口径变了同一路径的 diff 内容也不同，强制按新口径重新加载
      shownDiffPath = undefined;
      void loadList(loadedOnce);
    },

    toggleScope(): void {
      if (!sessionId || !visible) return;
      void switchScope(currentScope() === 'session' ? 'repo' : 'session');
    },

    scope: currentScope,

    update(session: Session): void {
      // 专注审阅由外层布局切换（快捷键、Esc），每轮渲染都会走到这里，顺带同步按钮状态
      syncFocusBtn();
      if (!visible || session.id !== sessionId) return;
      currentSession = session;
      each(x => x.update?.(session));
      const wasWorktree = isWorktree;
      isWorktree = !!session.worktree;
      if (wasWorktree !== isWorktree) renderMode();
      const at = currentScope() === 'session' ? session.sessionChanges?.updatedAt : session.changes?.updatedAt;
      if (at === undefined || at === lastSeenAt) return;
      if (listLoading) {
        // 正在加载：可能就是本次请求触发的摘要推送，等结果回来再比较，避免自激循环
        pendingAt = Math.max(pendingAt ?? 0, at);
        return;
      }
      // 时间戳比已处理的还旧，说明是过期推送
      if (lastSeenAt !== undefined && at < lastSeenAt) return;
      lastSeenAt = at;
      void loadList(true);
    },

    focus(): void {
      if (!body.hidden) list.focus({ preventScroll: true });
    },

    focusSearch: search.focus,

    clearAll: clearer.clearAll,
  };

  return view;
}
