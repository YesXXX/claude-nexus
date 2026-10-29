import { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, Notification, globalShortcut, screen, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { SessionManager, findNodePath } from './session-manager';
import { RealPtyFactory } from './pty-factory';
import { HookReceiver } from './hook-receiver';
import { NotificationService } from './notification-service';
import { registerIpc, registerUpdaterIpc } from './ipc';
import { scanOrphans } from './orphan-reclaimer';
import { panelHome, isIsolatedInstance, windowInactive, notifyLogOnly, NOTIFY_LOG_PREFIX } from './panel-home';
import { initFileLogging, log } from './logger';
import { loadWindowState, saveBounds, isOnscreen, type WindowBounds } from './window-state';
import { HOTKEY_CANDIDATES, pickHotkey } from './hotkey';
import { SubagentTracker } from './subagent-tracker';
import { WorktreeManager } from './worktree-manager';
import { createGitRunner, gitOk } from './git-runner';
import { ChangeTracker } from './change-tracker';
import { SessionChanges } from './session-changes';
import { Updater, resolvePublicKeys } from './updater';
import { UPDATE_PUBLIC_KEYS } from './update-pubkey';
import { describeCheckResult } from '../shared/update-status';
import { claudeProjectsRoot } from './claude-paths';
import { probeCapabilities } from './cli-capabilities';
import { dropSessionDirs, recordFromOrphanMeta, SessionRecordStore } from './session-record-store';
import { ResumeSettingsStore } from './resume-settings';
import { applyStartupPlan } from './startup-restore';
import { askQuitChoice, askQuitChoiceSync, QuitChoice } from './quit-dialog';
import { createUsageTracker } from './usage-wiring';
import { registerUsageIpc } from './usage-ipc';
import { TemplateStore } from './template-store';
import { registerTemplateIpc } from './ipc-templates';
import { EditorConfigStore } from './editor-config';
import { registerEditorIpc } from './ipc-editor';
import { AppearanceStore } from './appearance-store';
import { chromeOptions, registerAppearanceIpc } from './ipc-appearance';
import { PresetStore } from './preset-store';
import { registerPresetIpc } from './ipc-presets';
import { VerifyConfigStore } from './verify-config';
import { VerifyRunner } from './verify-runner';
import { workspaceFingerprint } from './verify-exec';
import { configResolver, registerVerifyIpc, RepoKeyResolver } from './ipc-verify';
import { verifyFailText } from '../shared/verify-types';
import { BatchManager } from './batch-manager';
import { registerBatchIpc } from './ipc-batch';
import { registerHistoryIpc } from './ipc-history';
import { registerActivityIpc } from './ipc-activity';
import { createWebhookWiring } from './webhook-wiring';
import { registerWebhookIpc } from './ipc-webhook';
import { endSession, launchSession } from './session-launcher';
import { AnnotationWiring } from './annotation-wiring';
import { ReviewWiring, externalOpener } from './review-wiring';
import { appUrlPrefix, guardNavigation, installIpcSenderGuard } from './window-guard';
import { createActivityWiring, registerActivityTestHooks, type ActivityWiring } from './activity-wiring';
import { verifyResultInput } from './activity-sources';
import type { UsageTracker } from './usage-tracker';
import type { RestorePrompt, RestoreReason } from '../shared/types';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let effectiveHotkey: string | null = null;
let isQuitting = false;
let manager: SessionManager;
let subagentTracker: SubagentTracker;
let records: SessionRecordStore;
let updater: Updater | undefined;
let changeTracker: ChangeTracker | undefined;
let sessionChangeSet: SessionChanges | undefined;
let usageTracker: UsageTracker | undefined;
let annotationWiring: AnnotationWiring | undefined;
let reviewWiring: ReviewWiring | undefined;
let verifyRunner: VerifyRunner | undefined;
let activity: ActivityWiring | undefined;
const resumeSettings = new ResumeSettingsStore(path.join(panelHome(), 'resume-settings.json'));
/** 外观偏好：创建窗口时要用（首帧底色、标题栏系统按钮颜色），在 whenReady 里先于窗口读入 */
const appearance = new AppearanceStore(path.join(panelHome(), 'appearance.json'));
/** 退出确认的选择，before-quit 据此写记录；没经过确认框时为 null，按保留处理 */
let quitDecision: { mode: 'keep' | 'end'; reason: RestoreReason } | null = null;
let quitHandled = false;
/** 询问档横幅内容：启动时算出一次 */
let restorePrompt: RestorePrompt | null = null;

const WINDOW_STATE_FILE = path.join(panelHome(), 'window-state.json');
/** 渲染层页面目录；窗口只允许显示这个目录下的页面，IPC 只接受来自这里的调用 */
const RENDERER_DIR = path.join(__dirname, '..', 'web', 'renderer');
const APP_URL_PREFIX = appUrlPrefix(RENDERER_DIR);

/** 自绘标题栏高度：必须与 renderer.css 的 --titlebar-h 保持一致；底色随皮肤，见 shared/skins.ts */
const TITLEBAR_HEIGHT = 40;
let saveStateTimer: NodeJS.Timeout | null = null;

/** 从当前窗口提取状态快照（getNormalBounds 在最大化时返回还原尺寸） */
function currentWindowBounds(): WindowBounds {
  const b = mainWindow!.getNormalBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: mainWindow!.isMaximized() };
}

/** 防抖 500ms 落盘；窗口销毁后静默跳过 */
function queueSaveWindowState(): void {
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    saveStateTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try { saveBounds(WINDOW_STATE_FILE, currentWindowBounds()); } catch { /* 写失败不影响运行 */ }
  }, 500);
}

function createWindow(): void {
  const st = loadWindowState(WINDOW_STATE_FILE);
  // 记录过位置且仍与某台显示器相交才复用；否则回默认尺寸由系统摆放（防显示器拔掉后窗口消失）
  const onscreen = isOnscreen(st, screen.getAllDisplays().map(d => d.workArea));
  // 测试用隔离实例：先隐藏创建再以不激活方式显示，不抢前台焦点
  const inactive = windowInactive();
  const chrome = chromeOptions(appearance.skin());
  mainWindow = new BrowserWindow({
    show: !inactive,
    width: onscreen ? st.width : 1200,
    height: onscreen ? st.height : 780,
    ...(onscreen ? { x: st.x, y: st.y } : {}),
    minWidth: 880,
    minHeight: 560,
    title: 'Claude Nexus',
    // 首帧前的底色与标题栏一致，避免启动时闪白或闪成别的皮肤
    backgroundColor: chrome.color,
    // 隐藏原生标题栏，由页面自绘；最小化 / 最大化 / 关闭仍由系统绘制（保留贴靠布局与无障碍行为）
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...chrome, height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true, nodeIntegration: false,
      // 皮肤随启动参数带给 preload，页面脚本运行前就设好 data-skin，首帧即为所选皮肤
      additionalArguments: [`--nexus-skin=${appearance.skin()}`],
    },
  });
  // 最大化会激活窗口，不激活模式下跳过
  if (st.maximized && !inactive) mainWindow.maximize();
  if (inactive) mainWindow.showInactive();
  mainWindow.on('resize', queueSaveWindowState);
  mainWindow.on('move', queueSaveWindowState);
  // 窗口只显示面板自己的页面：外部链接改用系统浏览器打开，其他导航与新窗口一律拦下
  guardNavigation(mainWindow.webContents, APP_URL_PREFIX, externalOpener(url => shell.openExternal(url)));
  // 渲染层产物独立输出到 dist/web，避免与主进程编译的 dist/shared（CommonJS）互相覆盖
  mainWindow.loadFile(path.join(RENDERER_DIR, 'index.html'));

  // 开发态默认开 DevTools；安装版不弹。排障逃生口：CLAUDE_PANEL_DEVTOOLS=1 可在任何形态强制打开
  //（注意 Explorer 启动的 GUI 进程不继承终端环境变量，安装版需系统级设置该变量后从快捷方式启动）
  if (process.env.CLAUDE_PANEL_DEVTOOLS === '1' ||
      (!app.isPackaged && process.env.CLAUDE_PANEL_DEVTOOLS !== '0')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('close', e => {
    if (!mainWindow!.isDestroyed()) {
      try { saveBounds(WINDOW_STATE_FILE, currentWindowBounds()); } catch { /* 忽略 */ }
    }
    if (!isQuitting) {
      e.preventDefault();
      mainWindow!.hide();
    }
  });

  // 页面加载完成（渲染层监听器就绪）后做启动检查；之后每次从托盘唤起都复查（带冷却）
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => { void updater?.checkNow('startup'); }, 500);
    void runPendingAutoResume();
  });
  mainWindow.on('show', () => { void updater?.checkNow('show'); });
}

/** 启动时要自动续接的会话：窗口加载完成（渲染层能收到结果推送）后才开始逐个拉起 */
let pendingAutoResume: string[] = [];

async function runPendingAutoResume(): Promise<void> {
  const ids = pendingAutoResume;
  pendingAutoResume = [];
  if (ids.length === 0) return;
  const result = await manager.restoreSessions(ids);
  if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('panel:restore-result', { ...result, auto: true });
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 发 Windows 系统通知（屏幕右下角 + 通知中心），点击唤起面板并直达对应会话 */
function showSystemNotification(title: string, body: string, sessionId?: string): void {
  // 测试用隔离实例：只写日志，不弹出真实的系统通知
  if (notifyLogOnly()) {
    log('notify', `${NOTIFY_LOG_PREFIX}${title}｜${body}${sessionId ? `（会话 ${sessionId.slice(0, 8)}）` : ''}`);
    return;
  }
  if (!Notification.isSupported()) {
    log('notify', '系统通知不被支持（Notification.isSupported()=false）');
    return;
  }
  const sys = new Notification({ title, body });
  sys.on('click', () => {
    log('notify', '系统通知被点击：唤起面板并选中会话');
    showWindow();
    if (sessionId) mainWindow?.webContents.send('panel:select-session', sessionId);
  });
  sys.on('failed', (_e, err) => log('notify', `系统通知失败：${String(err)}`));
  sys.show();
  log('notify', `系统通知已 show()：${title}`);
}

const APP_AUMID = 'io.github.yesxxx.claude-nexus';

/** Windows toast 要求 AUMID 关联到开始菜单快捷方式；开发模式无安装器，手动写入 .lnk */
function ensureNotificationShortcut(): void {
  if (process.platform !== 'win32') return;
  // 安装版快捷方式由 NSIS 安装器创建（AUMID = yml 的 appId，与 APP_AUMID 一致），手写 .lnk 仅作开发态兜底
  if (app.isPackaged) { log('notify', '安装版运行：跳过手写开始菜单快捷方式'); return; }
  const programs = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const lnk = path.join(programs, 'Claude Nexus.lnk');
  try {
    const ok = shell.writeShortcutLink(lnk, {
      target: process.execPath,
      args: `"${app.getAppPath()}"`,
      description: 'Claude Nexus',
      appUserModelId: APP_AUMID,
    });
    log('notify', `开始菜单快捷方式${ok ? '已写入' : '写入返回 false'}：${lnk}（AUMID=${APP_AUMID}）`);
  } catch (err) {
    log('notify', `快捷方式写入失败：${String(err)}（Windows 可能不显示系统通知）`);
  }
}

/**
 * 安装更新前确认：没有运行中的会话直接继续；退出设置为保留 / 结束时按设置处理；
 * 否则弹同步三选一。选择结果留给 before-quit 写记录，返回 false 表示取消安装。
 */
function confirmInstall(): boolean {
  const live = manager.liveManagedIds().length;
  if (live === 0) return true;
  const onQuit = resumeSettings.get().onQuit;
  const choice = onQuit === 'ask' ? askQuitChoiceSync(mainWindow, live) : onQuit;
  log('main', `安装更新确认：${choice}（运行中 ${live} 个）`);
  if (choice === 'cancel') return false;
  quitDecision = { mode: choice, reason: 'update' };
  return true;
}

/** 退出入口：没有运行中的会话直接退出；否则按设置或询问决定保留还是结束 */
async function requestQuit(): Promise<void> {
  const live = manager.liveManagedIds().length;
  if (live === 0) { app.quit(); return; }
  const onQuit = resumeSettings.get().onQuit;
  let choice: QuitChoice = onQuit === 'ask' ? 'cancel' : onQuit;
  if (onQuit === 'ask') {
    const r = await askQuitChoice(mainWindow, live);
    choice = r.choice;
    if (r.remember && choice !== 'cancel') resumeSettings.set({ onQuit: choice });
  }
  log('main', `退出确认：${choice}（运行中 ${live} 个）`);
  if (choice === 'cancel') return;
  quitDecision = { mode: choice, reason: 'quit' };
  app.quit();
}

/** 托盘「检查更新」：先唤起面板，发现新版本由面板弹窗接管，其余结果用系统通知告知 */
async function checkUpdateFromTray(): Promise<void> {
  showWindow();
  if (!updater) return;
  const r = await updater.checkNow('manual');
  log('update', `托盘手动检查：${r.status}${r.error ? `（${r.error}）` : ''}`);
  if (r.status !== 'update-available') showSystemNotification('检查更新', describeCheckResult(r));
}

/** 托盘上常驻显示的当前热键状态行（可见 = 可信） */
function trayHotkeyLine(): string {
  return effectiveHotkey ? `热键：${effectiveHotkey}` : '热键：未注册（点击托盘图标唤起）';
}

/** 候选链注册全局热键：成功者写日志并显示在托盘；全失败则系统通知兜底提示 */
function registerHotkeyWithFallback(): void {
  effectiveHotkey = pickHotkey(HOTKEY_CANDIDATES, accel => {
    const ok = globalShortcut.register(accel, () => {
      log('hotkey', `${accel} 触发：显示窗口并聚焦紧急会话`);
      showWindow();
      mainWindow?.webContents.send('panel:focus-urgent');
    });
    return ok;
  });
  if (effectiveHotkey) {
    log('hotkey', `全局热键注册成功：${effectiveHotkey}`);
  } else {
    log('hotkey', `全局热键全部候选注册失败：${HOTKEY_CANDIDATES.join(' / ')}（托盘点击唤起仍可用）`);
    showSystemNotification('热键未注册', '所有候选组合均被占用，可点击托盘图标唤起面板。');
  }
}

/** 读取开机自启状态（注册表读取失败按关闭处理，不 fatal） */
function getOpenAtLogin(): boolean {
  try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
}

function createTray(): void {
  const iconPath = path.join(app.getAppPath(), 'assets', 'tray.png');
  const image = nativeImage.createFromPath(iconPath);
  const icon = image.isEmpty()
    ? nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')
    : image;
  tray = new Tray(icon);
  tray.setToolTip(`Claude Nexus（${trayHotkeyLine()}）`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: trayHotkeyLine(), enabled: false },
    { type: 'separator' },
    { label: '显示面板', click: () => showWindow() },
    {
      label: '开机自启',
      type: 'checkbox',
      enabled: app.isPackaged,   // 开发态 electron.exe 在 node_modules 内，写入自启会指向错误目标
      checked: getOpenAtLogin(),
      click: item => {
        try {
          app.setLoginItemSettings({ openAtLogin: item.checked });
          const ok = app.getLoginItemSettings().openAtLogin === item.checked;   // Electron 44 注册表写失败不抛异常，回读才是真凭据
          if (ok) { log('tray', `开机自启已${item.checked ? '开启' : '关闭'}`); }
          else { item.checked = !item.checked; log('tray', '开机自启写入未生效，已回滚开关状态'); }
        } catch (err) {
          log('tray', `开机自启设置失败：${String(err)}`);
          item.checked = !item.checked;   // 失败回滚视觉状态，避免开关与实际不符
        }
      },
    },
    { type: 'separator' },
    { label: '检查更新…', click: () => { void checkUpdateFromTray(); } },
    { label: '退出…', click: () => { void requestQuit(); } },
  ]));
  tray.on('click', () => showWindow());
}

// 隔离实例（指定了 CLAUDE_PANEL_HOME）把 userData 挪进自己的数据目录：
// 单实例锁按 userData 计算，这样能与常驻面板并行运行而互不干扰
if (isIsolatedInstance()) app.setPath('userData', path.join(panelHome(), 'electron-data'));

// 单实例锁：拿不到锁直接退出，避免重复启动抢 hook 端口/扫孤儿导致误认领。
// 必须先于任何 app.on / app.whenReady 注册；拿到锁的实例收到 'second-instance' 时
// 把已存在的窗口摆到前台（双击图标或再跑一次 electron . 都不再开新进程）。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    log('main', '收到 second-instance：唤起已存在的窗口');
    showWindow();
  });
  app.whenReady().then(async () => {
  app.setAppUserModelId(APP_AUMID);
  // 界面只有深色：原生控件（输入联想下拉、右键菜单、滚动条）随之走深色
  nativeTheme.themeSource = 'dark';
  // 去掉默认的 File / Edit / View 菜单栏；输入框的复制粘贴由 Chromium 自身处理，不依赖菜单
  Menu.setApplicationMenu(null);
  const appRoot = app.getAppPath();
  // 打包态脚本在 app.asar.unpacked（外部 node 进程读不了 asar 内文件）；开发态仍在项目根
  const scriptsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'scripts')
    : path.join(appRoot, 'scripts');
  const hookClientPath = path.join(scriptsDir, 'hook-client.js');
  const mockClaudePath = path.join(scriptsDir, 'mock-claude.js');

  const logFile = initFileLogging(path.join(panelHome(), 'logs'));
  log('main', `面板启动，版本目录 ${appRoot}`);
  log('main', `日志文件：${logFile}`);
  log('main', `hook-client 路径：${hookClientPath}`);
  // 所有 IPC 只接受来自面板页面的调用：必须先于下面任何一处 ipcMain.handle 注册
  installIpcSenderGuard(APP_URL_PREFIX);
  // 隔离实例的快捷方式与常驻面板同名，写入会覆盖安装版的开始菜单入口
  if (isIsolatedInstance()) log('main', `隔离实例运行（数据目录 ${panelHome()}）：跳过开始菜单快捷方式与全局热键`);
  else ensureNotificationShortcut();
  // CLI 能力探测（异步，不阻塞启动）：完成前新建的会话按保守能力启动，id 由 SessionStart 回填
  if (process.env.CLAUDE_PANEL_MOCK_CLAUDE) log('cli', 'mock 模式：CLI 能力全开');
  else void probeCapabilities();

  // 活动日志最先创建：后续各模块的事件都汇入这里
  const act = createActivityWiring({ manager: () => manager, isQuitting: () => isQuitting });
  activity = act;
  registerActivityTestHooks(act.log);

  const notifications = new NotificationService(
    { escalateAfterMs: Number(process.env.CLAUDE_PANEL_ESCALATE_MS) || undefined, activity: act.log },
  );
  // 通知统一走 Windows 系统通知（屏幕右下角 + 通知中心），点击唤起面板
  notifications.subscribe(n => {
    if (isQuitting) return;   // 主动退出时杀进程引发的掉线不是异常，不弹告别报错
    log('notify', `发 Windows 系统通知：[${n.level}] ${n.title}（${n.sessionId ? `会话 ${n.sessionId.slice(0, 8)}` : '全局'}）`);
    showSystemNotification(n.title, n.body, n.sessionId);
  });
  // 远程通知（群机器人 webhook）订阅同一出口；总开关默认关闭，未配置目标时不发任何请求
  const webhook = createWebhookWiring({ notifications, getWindow: () => mainWindow, isQuitting: () => isQuitting });

  // 子代理 tracker：单定时器轮询全部 running 条目的 transcript；面板退出随 before-quit 停掉
  subagentTracker = new SubagentTracker({
    onChange: () => { if (!isQuitting) mainWindow?.webContents.send('panel:sessions', manager.getSessions()); },
    onOutput: (sessionId, agentId, chunk, end) => {
      if (isQuitting) return;   // 退出期间不再向已销毁 webContents 推流
      mainWindow?.webContents.send('panel:subagent-output', { sessionId, agentId, chunk, end });
    },
    onLifecycle: (sessionId, entry, phase) => act.sources.onSubagent(sessionId, entry, phase),
  });

  const git = createGitRunner();
  const worktrees = new WorktreeManager({
    git,
    registryFile: path.join(panelHome(), 'worktrees.json'),
  });

  // 改动摘要：只在数字或错误变化时推送会话列表，避免每次统计都触发整表重绘
  const lastSummaryKey = new Map<string, string>();
  const changes = new ChangeTracker({
    git,
    getSession: id => manager.getSession(id),
    onSummary: (id, s) => {
      annotationWiring?.onSummary(id);
      const key = `${s.mode}|${s.files}|${s.additions}|${s.deletions}|${s.error ?? ''}`;
      if (lastSummaryKey.get(id) === key) return;
      lastSummaryKey.set(id, key);
      if (!isQuitting) manager.notifyChanged();
    },
    // 同一仓库根下其他普通会话的数量（工作区会话各自隔离，不计入）；按真实路径比较，短路径与长路径写法视为同一目录
    countSharedCwd: id => {
      const canon = (p: string | undefined): string | undefined => {
        if (!p) return undefined;
        try { return fs.realpathSync.native(p).toLowerCase(); } catch { return p.toLowerCase(); }
      };
      const root = canon(changes.getRepoRoot(id));
      if (!root) return 0;
      return manager.getSessions()
        .filter(s => s.id !== id && !s.worktree && canon(changes.getRepoRoot(s.id)) === root).length;
    },
  });
  changeTracker = changes;

  // 本会话改动：按 Claude 动过的文件统计，跨仓库、非 git 目录同样适用；摘要变化才推会话列表
  const lastSessionKey = new Map<string, string>();
  const sessionChanges = new SessionChanges({
    home: panelHome(),
    git,
    getSession: id => manager?.getSession(id),
    onSummary: (id, s) => {
      const key = `${s.files}|${s.additions}|${s.deletions}|${s.roots}|${s.error ?? ''}`;
      if (lastSessionKey.get(id) === key) return;
      lastSessionKey.set(id, key);
      if (!isQuitting) manager?.notifyChanged();
    },
  });
  sessionChangeSet = sessionChanges;

  // 会话记录：独立于 sessions/<id> 目录存放，孤儿扫描删目录也不丢；读入后先按历史上限清理一次
  records = new SessionRecordStore(path.join(panelHome(), 'records'), {
    onChange: ids => {
      if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('panel:records-changed', { ids });
    },
    onRemoved: ids => {
      dropSessionDirs(path.join(panelHome(), 'sessions'), ids);
      sessionChanges.drop(ids);
    },
  });
  records.load();
  records.prune(resumeSettings.get());

  // 上下文统计：摘要变化才推会话列表
  usageTracker = createUsageTracker({
    getSession: id => manager?.getSession(id),
    listSessions: () => manager?.getSessions() ?? [],
    onSummaryChanged: () => { if (!isQuitting) manager?.notifyChanged(); },
    // 上下文告警上报活动日志，由活动日志的观察者转成系统通知
    activity: act.log,
  });
  act.log.watch((e, fresh) => { if (fresh) notifications.onActivity(e); });
  const usage = usageTracker;

  // 批注存储先于会话管理器创建（会话行带批注摘要），注入器在会话管理器之后挂接
  const annotations = new AnnotationWiring({
    home: panelHome(),
    changes,
    push: (channel, payload) => {
      if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(channel, payload);
    },
    notify: (level, title, body, sessionId) => notifications.notifyGlobal(level, title, body, sessionId),
    refreshSessions: () => { if (!isQuitting) manager?.notifyChanged(); },
  });
  annotationWiring = annotations;

  manager = new SessionManager({
    ptyFactory: new RealPtyFactory(),
    hookClientPath,
    mockClaudePath,
    onTransition: (prev, curr, event) => notifications.onTransition(prev, curr, event),
    onChange: sessions => {
      if (isQuitting) return;   // 窗口随退出销毁，send 到已销毁 webContents 会抛未捕获异常（?. 只防 null）
      mainWindow?.webContents.send('panel:sessions', sessions);
    },
    onOutput: (id, line) => {
      if (isQuitting) return;   // 同上：退出期间 PTY 末尾输出不再推流
      mainWindow?.webContents.send('panel:output', { id, line });
    },
    onEvent: (id, event) => { changes.onEvent(id, event); sessionChanges.onEvent(id, event); },
    changeSummary: id => changes.getSummary(id),
    sessionChangeSummary: id => sessionChanges.getSummary(id),
    usageSummary: usage ? id => usage.getSummary(id) : undefined,
    annotationSummary: id => annotations.store.summary(id),
    pendingPrompt: id => reviewWiring?.internal?.promptState(id),
    verifySummary: id => verifyRunner?.getSummary(id),
    onHookMessage: usage ? msg => usage.onHookMessage(msg) : undefined,
    subagentTracker,
    records,
    historyLimits: () => resumeSettings.get(),
  });
  // 活动来源在认领孤儿与恢复会话之前挂上，这些会话的生命周期事件也要记下
  manager.addListener({
    onEvent: (id, event) => act.sources.onEvent(id, event),
    onLifecycle: (kind, s) => act.sources.onLifecycle(kind, s),
  });
  subagentTracker.start();
  annotations.attach(manager);
  // 外部编辑器命令：diff 跳转与「打开」按钮共用；损坏的文件改名留档后按未配置处理
  const editorConfig = new EditorConfigStore(path.join(panelHome(), 'editor.json'));
  editorConfig.load();
  registerEditorIpc({ store: editorConfig });
  // 外观偏好：损坏的文件改名留档后回退默认皮肤；须在 createWindow 之前读入
  appearance.load();
  registerAppearanceIpc({ store: appearance, window: () => mainWindow });
  const review = new ReviewWiring({
    home: panelHome(), git, changes, sessionChanges, editor: editorConfig,
    mock: process.env.CLAUDE_PANEL_MOCK_CLAUDE ? { node: findNodePath(), script: mockClaudePath } : undefined,
    injector: () => annotations.injector,
    subscribe: s => annotations.subscribe(s),
    notice: (id, message, level) => {
      if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('panel:outbox-notice', { id, message, level });
    },
    openExternal: externalOpener(url => shell.openExternal(url)),
    activity: act.log,
  });
  review.attach(manager);
  reviewWiring = review;

  const receiver = new HookReceiver(msg => manager.handleHookMessage(msg), (id, raw) => sessionChanges.preflight(id, raw));
  await receiver.start();
  // 认领上次运行遗留的孤儿会话
  const isPidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const scan = scanOrphans({ home: panelHome(), now: Date.now(), isAlive: isPidAlive });
  for (const s of scan.adopted) manager.adoptSession(s, scan.adoptedPids.get(s.id));
  log('orphan', `孤儿扫描：认领 ${scan.adopted.length} 个存活会话，清理 ${scan.removedIds.length} 个残留目录`);
  // 旧版遗留、还没有记录的会话迁移成历史记录，之后仍可从历史续接
  let migrated = 0;
  for (const meta of scan.deadMetas) {
    if (typeof meta.id !== 'string' || records.get(meta.id)) continue;
    const rec = recordFromOrphanMeta(meta, Date.now());
    if (rec) { records.upsert(rec); migrated++; }
  }
  if (migrated > 0) {
    log('records', `迁移旧会话 ${migrated} 条为历史记录`);
    records.prune(resumeSettings.get());
  }
  // 上次保留或崩溃遗留的会话按设置放回列表；要自动续接的等窗口就绪后逐个拉起
  const startup = applyStartupPlan({
    records, manager, onStartup: resumeSettings.get().onStartup,
    adoptedIds: new Set(scan.adopted.map(s => s.id)), now: Date.now(),
  });
  restorePrompt = startup.prompt;
  pendingAutoResume = startup.autoResume;
  if (startup.end.length > 0) records.prune(resumeSettings.get());
  // 批注跟着会话行与历史记录走：两者都没有的会话，批注文件一并清掉
  const prunedAnn = annotations.store.prune(id => !!manager.getSession(id) || !!records.get(id));
  if (prunedAnn > 0) log('annotations', `清理无主批注文件 ${prunedAnn} 个`);
  // 本会话改动集同样跟着会话行与历史记录走
  const prunedSets = sessionChanges.prune(id => !!manager.getSession(id) || !!records?.get(id));
  if (prunedSets > 0) log('session-changes', `清理无主改动集 ${prunedSets} 个`);
  review.pruneOnStartup();
  // 重建运行中的子代理：对话记录根目录尊重 CLAUDE_CONFIG_DIR，mock 与隔离实例另有覆盖
  const projectsRoot = claudeProjectsRoot();
  let rebuiltSubs = 0;
  for (const s of scan.adopted) rebuiltSubs += subagentTracker.reconstruct(s, projectsRoot);
  if (rebuiltSubs > 0) log('subagent', `重启后重建 ${rebuiltSubs} 个运行中子代理`);
  // 上下文统计：按恢复后的会话列表对齐账本并补读一次
  usage?.syncSessions();
  usage?.start();
  const prompts = {
    deliver: (id: string, text: string) => review.internal.deliver(id, text, 'prompt'),
    insert: (id: string, text: string, submit: boolean) => annotations.injector.insert(id, text, submit),
    insertPending: (id: string) => review.internal.insertPending(id),
  };
  registerIpc(manager, subagentTracker, {
    worktrees, changes, sessionChanges, records, usage, resume: { settings: resumeSettings, prompt: () => restorePrompt }, prompts,
    editor: editorConfig,
  });
  registerHistoryIpc({ manager, records });
  registerWebhookIpc(webhook);
  registerActivityIpc({
    log: act.log,
    push: p => {
      if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('activity:events', p);
    },
  });
  log('main', 'IPC handlers 注册完成（panel:list/create/output/input/resize/approve/restart/kill/pickCwd/git-info/worktree-*/changes/file-diff/open-path）');
  // 登记表同步：目录已被手动删除的工作区记录清掉（不阻塞启动）
  void worktrees.prune().catch(err => log('worktree', `登记表同步失败：${String(err)}`));
  // 认领的会话补一次改动统计（只读会话同样可以审阅改动）
  for (const s of scan.adopted) void changes.refresh(s.id);

  // 共享目录更新：自动检查仅安装版启用；开发态可用 CLAUDE_PANEL_UPDATE_TEST_PUBKEY 追加测试公钥走手动检查
  updater = new Updater({
    currentVersion: app.getVersion(),
    configFile: path.join(panelHome(), 'update-config.json'),
    downloadRoot: path.join(app.getPath('userData'), 'updates'),
    publicKeys: resolvePublicKeys(UPDATE_PUBLIC_KEYS, !app.isPackaged, process.env.CLAUDE_PANEL_UPDATE_TEST_PUBKEY),
    enabled: app.isPackaged,
    send: (channel, payload) => {
      if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(channel, payload);
    },
    confirmInstall: () => confirmInstall(),
    quit: () => { isQuitting = true; app.quit(); },
  });
  updater.cleanStaleDownloads();
  registerUpdaterIpc(updater);
  registerUsageIpc(usage);
  // 提示词模板：损坏的文件改名留档后以空列表启动
  const templates = new TemplateStore(path.join(panelHome(), 'templates.json'));
  templates.load();
  registerTemplateIpc({ store: templates, git, manager, changes });
  // 会话预设：损坏的文件同样改名留档后以空列表启动
  const presets = new PresetStore(path.join(panelHome(), 'presets.json'));
  presets.load();
  registerPresetIpc({ store: presets });
  // 每轮自动验证：一轮结束后执行仓库配置的命令，Claude 开始新一轮或会话结束时立即让路
  const verifyStore = new VerifyConfigStore(path.join(panelHome(), 'verify.json'));
  verifyStore.load();
  const repoKeys = new RepoKeyResolver(git);
  const runner = new VerifyRunner({
    getSession: id => manager.getSession(id),
    resolveConfig: configResolver(manager, verifyStore, repoKeys),
    global: () => verifyStore.global(),
    fingerprint: cwd => workspaceFingerprint(git, cwd),
    logDir: path.join(panelHome(), 'verify-logs'),
    onSummary: () => { if (!isQuitting) manager.notifyChanged(); },
    onFinished: (id, s) => {
      act.log.report(verifyResultInput(id, s));
      if (s.status === 'passed' || !verifyStore.global().notifyOnFail) return;
      const label = manager.getSession(id)?.label ?? id.slice(0, 8);
      notifications.notifyGlobal('warning', `验证未通过：${label}`, verifyFailText(s), id);
    },
    countInterferers: id => {
      const s = manager.getSession(id);
      if (!s) return 0;
      const key = path.resolve(s.cwd).toLowerCase();
      return manager.getSessions()
        .filter(o => o.id !== id && o.status === 'running' && path.resolve(o.cwd).toLowerCase() === key).length;
    },
  });
  verifyRunner = runner;
  const prunedLogs = runner.pruneLogs();
  if (prunedLogs > 0) log('verify', `清理过期验证日志 ${prunedLogs} 个`);
  manager.addListener({
    onEvent: (id, event) => runner.onEvent(id, event),
    onDetach: (id, reason) => runner.onDetach(id, reason),
  });
  registerVerifyIpc({
    runner, store: verifyStore, git, manager,
    insert: (id, text, submit) => annotations.injector.insert(id, text, submit),
  }, repoKeys);
  // 批量派发：同一提示词派给多个独立工作区会话，批次记录独立于会话目录存放
  const batches = new BatchManager({
    file: path.join(panelHome(), 'batches.json'),
    launch: input => launchSession({ manager, worktrees, changes, prompts }, input),
    end: (id, opts) => endSession({ manager, worktrees, changes, usage, records }, id, opts),
    getSession: id => manager.getSession(id),
    inspect: cwd => worktrees.inspect(cwd),
    resolveCommit: async (cwd, ref) => {
      const r = await git.run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return gitOk(r) ? r.stdout.trim() : undefined;
    },
    getChanges: id => changes.getChanges(id, 'base', { remember: false }),
    worktreeStatus: info => worktrees.status(info),
    onChange: id => {
      if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('batch:changed', { id });
    },
  });
  batches.load();
  manager.addListener({
    onEvent: (id, event) => batches.onEvent(id, event),
    onDetach: id => batches.onDetach(id),
  });
  registerBatchIpc(batches);
  log('update', `当前版本 v${app.getVersion()}，更新目录：${updater.getUpdateDir() ?? '未设置'}`);

  setInterval(() =>
    manager.markEscalated(notifications.tick(manager.getSessions(), Date.now())), 60_000);
  // 认领会话没有 PTY 退出回调，定时按 pid 判活，进程结束后转为可重启
  if (scan.adoptedPids.size > 0) setInterval(() => manager.pollOrphans(isPidAlive), 5_000);

  if (!isIsolatedInstance()) registerHotkeyWithFallback();
  createWindow();
  createTray();
  log('main', '窗口与托盘创建完成');
});

app.on('window-all-closed', () => {
  /* 窗口关闭仅隐藏到托盘，应用常驻 */
});

app.on('before-quit', () => {
  if (quitHandled) return;
  quitHandled = true;
  // 先写记录再杀进程：没经过确认框的退出（注销、关机等）一律按保留处理，宁可多留一条待续接
  const decision = quitDecision ?? { mode: 'keep' as const, reason: 'quit' as const };
  try {
    if (manager) {
      const ids = decision.mode === 'end' ? manager.endAll() : manager.suspendAll(decision.reason);
      log('main', `退出：${decision.mode === 'end' ? '结束' : '保留'} ${ids.length} 个会话`);
    }
  } catch (err) { log('main', `退出前写记录失败：${String(err)}`); }
  isQuitting = true;
  try { const n = verifyRunner?.disposeAll() ?? 0; if (n > 0) log('main', `退出：结束 ${n} 个验证进程树`); } catch (err) { log('main', `验证进程清理失败：${String(err)}`); }
  try { const sent = manager.disposeAll(); log('main', `退出：已向 ${sent} 个托管会话进程发送终止`); } catch (err) { log('main', `退出清理失败：${String(err)}`); }
  try { subagentTracker.dispose(); } catch (err) { log('main', `subagent tracker 清理失败：${String(err)}`); }
  changeTracker?.dispose();
  sessionChangeSet?.dispose();
  try { annotationWiring?.dispose(); } catch (err) { log('main', `发件箱清理失败：${String(err)}`); }
  try { usageTracker?.dispose(); } catch (err) { log('main', `上下文账本落盘失败：${String(err)}`); }
  try { records?.dispose(); } catch (err) { log('main', `会话记录落盘失败：${String(err)}`); }
  try { activity?.log.dispose(); } catch (err) { log('main', `活动日志落盘失败：${String(err)}`); }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
}
