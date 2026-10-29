// 浏览器 ESM 不做无扩展名解析：从 shared 导入运行时值必须写显式 .js（types 是纯类型、emit 时擦除，不受此限）
import type { UpdateUiHandle } from './features/update/update-ui.js';
import { initUpdateUi } from './features/update/update-ui.js';
import { byId, fatal, queryEl } from './core/dom.js';
import { dbg, short } from './core/debug.js';
import { api, hasPanelApi } from './core/api.js';
import { loadCollapsed, loadInspectorHidden, saveCollapsed } from './core/persist.js';
import { findSession, initState, state } from './core/state.js';
import { handleRemovedSessions, initPaneLayout, reconcileLayoutOnBoot, syncLayoutWithSelection } from './core/panes.js';
import { render, setRenderer } from './core/render.js';
import { syncReviewLayout } from './core/review-layout.js';
import { emit } from './core/events.js';
import { isApproveLockStale } from './actions/session-actions.js';
import { focusUrgent, selectSession, showTerminalTab } from './actions/selection.js';
import { goHome, initHome } from './views/home.js';
import { initDetailPane, renderMainPane } from './views/detail-pane.js';
import { initRail, renderFilters, renderRail, renderSidebar } from './views/sidebar.js';
import { renderInspector } from './views/inspector.js';
import { closePalette, initPalette, openPalette } from './views/palette.js';
import { initPaneDrag } from './views/pane-drag.js';
import { installBuiltinCommands } from './builtin/commands.js';
import { createAppContext } from './builtin/context.js';
import { installBuiltinHotkeys } from './builtin/hotkeys.js';
import { installBuiltinDetailTabs } from './builtin/detail-tabs.js';
import { installBuiltinInspectorSections } from './builtin/inspector-sections.js';
import { installBuiltinPaneActions } from './builtin/pane-actions.js';
import { installBuiltinPaneLayout } from './builtin/pane-layout.js';
import { install as installResume } from './features/resume/index.js';
import { install as installUsage } from './features/usage/index.js';
import { install as installAnnotations } from './features/annotations/index.js';
import { install as installRevert } from './features/revert/index.js';
import { install as installEditorJump } from './features/editor-jump/index.js';
import { install as installPresets } from './features/presets/index.js';
import { install as installFinish } from './features/finish/index.js';
import { install as installTermSearch } from './features/term-search/index.js';
import { install as installTermExport } from './features/term-export/index.js';
import { install as installInitialPrompt } from './features/initial-prompt/index.js';
import { install as installTemplates } from './features/templates/index.js';
import { install as installVerify } from './features/verify/index.js';
import { install as installBatch } from './features/batch/index.js';
import { install as installHistory } from './features/history/index.js';
import { install as installDiffView } from './features/changes/index.js';
import { install as installTimeline } from './features/timeline/index.js';
import { install as installRemoteNotify } from './features/remote-notify/index.js';
import { install as installSettings } from './features/settings/index.js';
import { install as installAppearance } from './features/appearance/index.js';
import { bindHotkeys } from './input/hotkeys.js';
import { fitVisible, writeOutput } from './term/terminals.js';
import { disposeSubagentTermsForSession, writeSubagentOutput } from './term/subagent-terms.js';

// ================= 渲染总入口 =================

function renderAll(): void {
  syncLayoutWithSelection();
  renderRail();
  renderFilters();
  renderSidebar();
  renderMainPane();
  renderInspector();
  syncReviewLayout();
}

async function refresh(): Promise<void> {
  state.sessions = await api().list();
  if (state.selectedId && !state.sessions.find(s => s.id === state.selectedId)) state.selectedId = null;
  // 清理折叠集合中已不存在的 sessionId，防止 localStorage 长期累积废弃 id
  const validIds = new Set(state.sessions.map(s => s.id));
  let pruned = false;
  for (const id of [...state.collapsedSessions]) {
    if (!validIds.has(id)) { state.collapsedSessions.delete(id); pruned = true; }
  }
  if (pruned) saveCollapsed(state.collapsedSessions);
  render();
}

// ================= 事件绑定 =================

function bindUi(): void {
  initHome();
  initDetailPane();

  // ---- 标题栏与导航轨 ----
  // 窗口失焦时标题栏变暗，与系统原生窗口的激活态表现一致
  window.addEventListener('blur', () => document.body.classList.add('win-blur'));
  window.addEventListener('focus', () => document.body.classList.remove('win-blur'));
  initRail(openPalette);
  initPaneDrag();
  initPalette();
}

function bootstrap(): void {
  dbg('init', 'bootstrap 开始：注册 onSessions / onOutput / onFocusUrgent / onSelectSession');
  api().onSessions(next => {
    // 只在会话状态摘要变化时打日志，避免刷屏
    const summary = next.map(s => `${short(s.id)}=${s.status}`).join(', ');
    dbg('state', `会话推送 (${next.length})：${summary || '空'}`);
    // 父会话被移除 → 销毁其全部子代理 xterm 实例 + 清掉选中态
    const removedIds = state.sessions.filter(s => !next.find(x => x.id === s.id)).map(s => s.id);
    state.sessions = next;
    emit('sessions-updated', { sessions: next });
    if (state.pendingApprove && isApproveLockStale()) state.pendingApprove = null;   // 推送驱动解锁：状态确认路径
    // 被移除的会话关闭其窗格；选中的正是它时改选新的焦点窗格会话（单窗格时为 null，回到空态）
    if (removedIds.length > 0) {
      const nextFocus = handleRemovedSessions(removedIds);
      if (state.selectedId && removedIds.includes(state.selectedId)) state.selectedId = nextFocus;
    }
    // 选中的会话被删除（kill 后移除）→ 回到空态
    if (state.selectedId && !state.sessions.find(s => s.id === state.selectedId)) state.selectedId = null;
    const selSub = state.selectedSubagent;
    if (selSub && !state.sessions.find(s => s.id === selSub.sessionId)) {
      state.selectedSubagent = null;
    }
    if (removedIds.length > 0) {
      for (const id of removedIds) {
        disposeSubagentTermsForSession(id);
        state.paneTabBySession.delete(id);
      }
    }
    render();
  });
  api().onOutput(writeOutput);
  // 子代理增量：已建实例（含未选中的缓存实例）一律按偏移写入，切回时内容不过期；
  // 回放请求在途则排队，未建实例且无请求的直接丢弃（选中时由回放快照覆盖）
  api().onSubagentOutput(writeSubagentOutput);
  api().onFocusUrgent(() => { focusUrgent(); });
  // 系统通知点击 → 直达对应会话（会话已 kill 则忽略）
  api().onSelectSession(id => {
    if (!findSession(id)) return;
    // 通知直达优先于命令面板：静默关闭（点通知 = 明确要去看那个会话）
    if (!byId('palette-backdrop').hidden) closePalette(false);
    showTerminalTab(id);
    state.pendingFocusId = id;
    selectSession(id);
  });
  // 通知已改为 Windows 系统通知（主进程 Notification），应用内 toast 暂停使用
  // initNotifyToasts(id => selectSession(id));

  bindHotkeys();

  // 终端宿主是稳定元素：窗口尺寸变化 → 只 fit 当前选中的终端
  const host = queryEl('terminal-host');
  const subHost = queryEl('subagent-terminal-host');
  const ro = new ResizeObserver(() => fitVisible(host, subHost));
  if (host) ro.observe(host);
  if (subHost) ro.observe(subHost);
  // 首次拉取会话列表并完成渲染后打就绪标记，自动化测试据此判断可以开始操作；
  // 同时把上次保存的布局与现存会话对账一次
  void refresh().then(() => {
    reconcileLayoutOnBoot(new Set(state.sessions.map(s => s.id)));
    render();
    document.documentElement.dataset.panelReady = '1';
  });
}

// ================= 启动 =================

// 更新界面在主界面之后单独初始化，失败时保持为 null
let updateUi: UpdateUiHandle | null = null;

initState({ collapsedSessions: loadCollapsed(), inspectorHidden: loadInspectorHidden() });
initPaneLayout();
setRenderer(renderAll);

if (!hasPanelApi()) {
  console.error('[panel] FATAL: window.panelApi 未定义 — preload 桥未生效');
  fatal('面板初始化失败：preload 桥未生效，window.panelApi 未定义。请检查 Electron preload 配置。');
} else {
  console.log('[panel] preload 已就绪，panelApi 存在，调用 bindUi/bootstrap');
  try {
    // 先装内置扩展项，再绑定界面：首轮渲染时注册表已完整
    const ctx = createAppContext();
    installBuiltinCommands(ctx, { openUpdateSettings: () => updateUi?.openSettings() });
    installBuiltinHotkeys(ctx);
    installBuiltinDetailTabs(ctx);
    installBuiltinInspectorSections(ctx);
    installBuiltinPaneActions(ctx);
    installBuiltinPaneLayout(ctx);
    // 功能模块在内置项之后安装，order 从 500 起排在内置项后面
    installResume(ctx);
    installUsage(ctx);
    installAnnotations(ctx);
    installRevert(ctx);
    installEditorJump(ctx);
    installPresets(ctx);
    installFinish(ctx);
    installTermSearch(ctx);
    installTermExport(ctx);
    installInitialPrompt(ctx);
    installTemplates(ctx);
    installVerify(ctx);
    installBatch(ctx);
    installHistory(ctx);
    installDiffView(ctx);
    installTimeline(ctx);
    installRemoteNotify(ctx);
    installSettings(ctx);
    installAppearance(ctx);
    bindUi();
    console.log('[panel] bindUi 完成，新建/导航轨/命令面板事件已绑定');
    bootstrap();
    console.log('[panel] bootstrap 完成，onSessions/onOutput/onFocusUrgent/onSelectSession 已注册');
    // 更新界面出错只影响更新入口，不拖垮会话面板
    try { updateUi = initUpdateUi(api().updater); } catch (err) { console.error('[update] 更新界面初始化失败：', err); }
    // 启动即进首页：预填最近目录并聚焦标签输入
    goHome();
    window.setInterval(render, 10000);   // 列表时长与状态 pill 的持续时间每 10 秒刷新
  } catch (err) {
    console.error('[panel] FATAL during init:', err);
    fatal('面板初始化失败：' + (err instanceof Error ? err.stack : String(err)));
  }
}
