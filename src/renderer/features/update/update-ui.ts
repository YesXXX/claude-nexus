import type {
  UpdateAvailablePayload, UpdateCheckResult, UpdateConfig, UpdateDirResult, UpdateInstallStart, UpdateProgress,
} from '../../../shared/update-status';
// 浏览器 ESM 不做无扩展名解析：运行时值必须写显式 .js
import { describeCheckResult } from '../../../shared/update-status.js';
import { byId } from '../../core/dom.js';

/**
 * 更新界面：导航轨底部的「检查更新」入口（悬停提示带当前版本）、更新设置弹窗、发现新版本弹窗。
 * 发现新版本由主进程推送（启动、从托盘唤起、手动检查都会触发），下载进度与失败同样走推送。
 */

export interface UpdaterApi {
  getConfig(): Promise<UpdateConfig>;
  setDir(dir: string): Promise<UpdateDirResult>;
  pickDir(): Promise<UpdateDirResult>;
  check(): Promise<UpdateCheckResult>;
  install(): Promise<UpdateInstallStart>;
  onAvailable(cb: (info: UpdateAvailablePayload) => void): void;
  onProgress(cb: (p: UpdateProgress) => void): void;
  onError(cb: (message: string) => void): void;
}

/** 初始化后返回的句柄：命令面板等入口直接调用，不再模拟点击按钮 */
export interface UpdateUiHandle {
  /** 打开更新入口：已有可装的新版本时回到更新弹窗，否则打开更新设置 */
  openSettings(): void;
}

type Phase = 'available' | 'downloading' | 'installing' | 'error';

/** 字节数格式化为 MB */
function formatSize(bytes: number): string {
  return bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '0 MB';
}

export function initUpdateUi(api: UpdaterApi): UpdateUiHandle {
  const btnUpdate = byId<HTMLButtonElement>('btn-update');

  // 更新设置弹窗
  const settings = byId('update-settings-backdrop');
  const settingsForm = byId<HTMLFormElement>('update-settings-form');
  const currentVersion = byId('update-current-version');
  const dirInput = byId<HTMLInputElement>('update-dir');
  const btnBrowse = byId<HTMLButtonElement>('btn-update-browse');
  const btnCheck = byId<HTMLButtonElement>('btn-update-check');
  const status = byId('update-settings-status');

  // 发现新版本弹窗
  const dialog = byId('update-dialog-backdrop');
  const fromLabel = byId('update-from');
  const toLabel = byId('update-to');
  const notes = byId('update-notes');
  const fileMeta = byId('update-file-meta');
  const progressBar = byId('update-progress-bar');
  const progressPercent = byId('update-progress-percent');
  const progressSize = byId('update-progress-size');
  const errorBox = byId('update-phase-error');
  const buttons = byId('update-dialog-buttons');
  const btnInstall = byId<HTMLButtonElement>('btn-update-install');
  const btnLater = byId<HTMLButtonElement>('btn-update-later');
  const phaseNodes: Record<Phase, HTMLElement> = {
    available: byId('update-phase-available'),
    downloading: byId('update-phase-downloading'),
    installing: byId('update-phase-installing'),
    error: errorBox,
  };

  let phase: Phase = 'available';
  let lastInfo: UpdateAvailablePayload | null = null;

  const setStatus = (text: string, kind: '' | 'ok' | 'error' = ''): void => {
    status.textContent = text;
    status.className = `update-status${kind ? ' ' + kind : ''}`;
  };

  const setPhase = (next: Phase): void => {
    phase = next;
    for (const [key, node] of Object.entries(phaseNodes)) node.hidden = key !== next;
    // 下载与安装阶段不提供按钮：流程不可中断，结果由推送驱动
    buttons.hidden = next === 'downloading' || next === 'installing';
    btnInstall.textContent = next === 'error' ? '重试' : '立即更新';
    btnLater.textContent = next === 'error' ? '关闭' : '暂不更新';
  };

  const showProgress = (p: UpdateProgress): void => {
    progressBar.style.width = `${p.percent}%`;
    progressPercent.textContent = `${p.percent}%`;
    progressSize.textContent = `${formatSize(p.received)} / ${formatSize(p.total)}`;
  };

  void api.getConfig().then(cfg => {
    btnUpdate.dataset.version = cfg.currentVersion;
    if (!btnUpdate.classList.contains('has-update')) btnUpdate.title = `检查更新（当前 v${cfg.currentVersion}）`;
    currentVersion.textContent = `v${cfg.currentVersion}`;
    dirInput.value = cfg.dir ?? '';
  }).catch(err => console.error('[update] 读取更新配置失败：', err));

  // ---- 更新设置弹窗 ----
  const openSettings = (): void => {
    if (lastInfo && phase !== 'error') { dialog.hidden = false; return; }   // 已有可装的新版本：直接回到更新弹窗
    setStatus('');
    settings.hidden = false;
    dirInput.focus();
  };
  btnUpdate.addEventListener('click', openSettings);
  byId('btn-update-settings-close').addEventListener('click', () => { settings.hidden = true; });
  settings.addEventListener('click', e => { if (e.target === settings) settings.hidden = true; });

  btnBrowse.addEventListener('click', async () => {
    const r = await api.pickDir();
    if (!r) return;
    if (r.ok) { dirInput.value = r.dir; setStatus('更新目录已保存', 'ok'); } else { setStatus(r.error, 'error'); }
  });

  settingsForm.addEventListener('submit', async e => {
    e.preventDefault();
    btnCheck.disabled = true;
    try {
      const saved = await api.setDir(dirInput.value);
      if (saved && !saved.ok) { setStatus(saved.error, 'error'); return; }
      if (saved?.ok) dirInput.value = saved.dir;
      setStatus('正在检查…');
      const r = await api.check();
      const ok = r.status === 'update-available' || r.status === 'up-to-date';
      setStatus(describeCheckResult(r), ok ? 'ok' : 'error');
      // 发现新版本时 update:available 推送会弹出更新弹窗，这里收起设置弹窗让位
      if (r.status === 'update-available') settings.hidden = true;
    } catch (err) {
      setStatus((err as Error).message || '检查更新失败', 'error');
    } finally {
      btnCheck.disabled = false;
    }
  });

  // ---- 发现新版本弹窗 ----
  api.onAvailable(info => {
    if (phase === 'downloading' || phase === 'installing') return;   // 下载、安装进行中不打断
    lastInfo = info;
    btnUpdate.classList.add('has-update');
    // 导航轨上是图标按钮：不改文字，靠红点 + 悬浮提示告知新版本
    btnUpdate.title = `发现新版本 v${info.version}，点击查看`;
    fromLabel.textContent = `v${info.currentVersion}`;
    toLabel.textContent = `v${info.version}`;
    notes.textContent = info.notes || '（此版本暂无更新说明）';
    notes.classList.toggle('empty', !info.notes);
    fileMeta.textContent = `${info.fileName} · ${formatSize(info.fileSize)}`;
    setPhase('available');
    settings.hidden = true;
    dialog.hidden = false;
  });

  api.onProgress(p => {
    if (phase !== 'downloading') return;
    showProgress(p);
    if (p.percent >= 100) setPhase('installing');
  });

  api.onError(message => {
    errorBox.textContent = message;
    setPhase('error');
    dialog.hidden = false;
  });

  btnLater.addEventListener('click', () => { dialog.hidden = true; });

  btnInstall.addEventListener('click', async () => {
    showProgress({ received: 0, total: lastInfo?.fileSize ?? 0, percent: 0 });
    setPhase('downloading');
    try {
      const r = await api.install();
      if (r.started) return;
      if (r.error) { errorBox.textContent = r.error; setPhase('error'); return; }
      setPhase('available');   // 用户在退出确认里取消
    } catch (err) {
      errorBox.textContent = (err as Error).message || '启动更新失败';
      setPhase('error');
    }
  });

  return { openSettings };
}
