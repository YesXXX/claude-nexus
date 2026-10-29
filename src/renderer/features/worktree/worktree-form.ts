import type { GitRepoInfo } from '../../../shared/types';
import { byId } from '../../core/dom.js';

/**
 * 新建会话表单里的「独立工作区」选项行。
 * 工作目录变化后（防抖 300ms）探测仓库：非仓库整行隐藏；未装 git / 裸仓库 / 无提交时开关禁用并说明原因。
 * 开关状态按主仓库根目录记在 localStorage，同一仓库下次沿用上次的选择。
 */

export interface WorktreeFormApi {
  gitInfo(cwd: string): Promise<GitRepoInfo>;
}

export interface WorktreeCreateOptions { worktree: true; branch?: string; baseRef?: string; }

export interface WorktreeFormHandle {
  /** 勾选了独立工作区时返回创建参数，否则 undefined */
  options(): WorktreeCreateOptions | undefined;
  /** 提交中：禁用输入，按钮文字由调用方处理 */
  setBusy(busy: boolean): void;
  /** 立即重新探测（浏览选定目录、回填最近目录后调用） */
  refresh(): void;
  /** 创建成功后清空分支 / 基线输入 */
  reset(): void;
}

const PREF_KEY = 'panel.worktreeByRepo';
const PROBE_DEBOUNCE_MS = 300;

function loadPrefs(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' ? raw as Record<string, boolean> : {};
  } catch {
    return {};
  }
}

function savePref(repoRoot: string, on: boolean): void {
  try {
    const prefs = loadPrefs();
    prefs[repoRoot.toLowerCase()] = on;
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch { /* 存储不可用则不记忆 */ }
}

const DISABLED_REASON: Partial<Record<GitRepoInfo['state'], string>> = {
  no_git: '未检测到 git，无法创建独立工作区',
  bare: '裸仓库不支持独立工作区',
  no_commit: '仓库还没有提交，无法创建独立工作区',
};

const TOGGLE_TIP = '在 .claude/worktrees 下为本会话创建独立的 git 工作区和分支，多个会话改同一仓库互不干扰。'
  + '\n依赖目录（如 node_modules）不会复制，首次进入工作区需要重新安装。';

export function initWorktreeOption(api: WorktreeFormApi, cwdInput: HTMLInputElement): WorktreeFormHandle {
  const row = byId('wt-row');
  const toggle = byId<HTMLInputElement>('wt-on');
  const toggleLabel = byId('wt-toggle');
  const fields = byId('wt-fields');
  const branch = byId<HTMLInputElement>('wt-branch');
  const base = byId<HTMLInputElement>('wt-base');
  const note = byId('wt-note');

  let info: GitRepoInfo = { state: 'not_repo' };
  let probeSeq = 0;
  let timer: number | undefined;
  let busy = false;

  const usable = (): boolean => info.state === 'repo';

  const renderNote = (): void => {
    const lines: string[] = [];
    const reason = DISABLED_REASON[info.state];
    if (reason) lines.push(reason);
    if (usable() && toggle.checked) {
      if (info.dirtyCount) lines.push(`⚠ 所选目录有 ${info.dirtyCount} 个未提交改动，不会带入新工作区`);
      if (info.hasSubmodules) lines.push('子模块需要在工作区内自行初始化');
    }
    note.textContent = lines.join('\n');
    note.hidden = lines.length === 0;
  };

  const render = (): void => {
    const visible = info.state !== 'not_repo';
    row.hidden = !visible;
    if (!visible) { note.hidden = true; return; }
    toggle.disabled = busy || !usable();
    if (!usable()) toggle.checked = false;
    toggleLabel.title = DISABLED_REASON[info.state] ?? TOGGLE_TIP;
    fields.hidden = !toggle.checked;
    branch.disabled = busy;
    base.disabled = busy;
    base.placeholder = info.head ? `${info.head}（当前）` : '当前分支';
    renderNote();
  };

  const probe = async (): Promise<void> => {
    const cwd = cwdInput.value.trim();
    const seq = ++probeSeq;
    if (!cwd) { info = { state: 'not_repo' }; render(); return; }
    let next: GitRepoInfo;
    try {
      next = await api.gitInfo(cwd);
    } catch {
      next = { state: 'not_repo' };
    }
    if (seq !== probeSeq) return;   // 输入已变化，丢弃过期结果
    const repoChanged = next.repoRoot !== info.repoRoot;
    info = next;
    if (repoChanged && usable() && info.repoRoot) {
      toggle.checked = loadPrefs()[info.repoRoot.toLowerCase()] ?? false;
    }
    render();
  };

  const schedule = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void probe(), PROBE_DEBOUNCE_MS);
  };

  cwdInput.addEventListener('input', schedule);
  cwdInput.addEventListener('change', schedule);
  toggle.addEventListener('change', () => {
    if (info.repoRoot) savePref(info.repoRoot, toggle.checked);
    render();
    if (toggle.checked) branch.focus();
  });

  schedule();

  return {
    options: () => {
      if (!usable() || !toggle.checked) return undefined;
      const b = branch.value.trim();
      const r = base.value.trim();
      return { worktree: true, ...(b ? { branch: b } : {}), ...(r ? { baseRef: r } : {}) };
    },
    setBusy: (v: boolean) => { busy = v; render(); },
    refresh: () => { window.clearTimeout(timer); void probe(); },
    reset: () => { branch.value = ''; base.value = ''; void probe(); },
  };
}
