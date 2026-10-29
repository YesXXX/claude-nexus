import { emit } from '../core/events.js';
import { cwdBaseName } from '../../shared/session-view.js';
import { api } from '../core/api.js';
import { byId, el, ipcErrorText } from '../core/dom.js';
import { loadRecent, migrateLegacyCwd, RECENT_CWDS_KEY, RECENT_LABELS_KEY } from '../core/persist.js';
import { render } from '../core/render.js';
import { state } from '../core/state.js';
import { createSessionAndSelect } from '../actions/create-session.js';
import type { WorktreeFormHandle } from '../features/worktree/worktree-form.js';
import { initWorktreeOption } from '../features/worktree/worktree-form.js';

/** 首页：新建会话表单、浏览目录、最近目录卡片、历史联想、独立工作区选项 */

let wtForm: WorktreeFormHandle | null = null;
let creating = false;

function renderHistory(): void {
  fillDatalist('cwd-history', loadRecent(RECENT_CWDS_KEY));
  fillDatalist('label-history', loadRecent(RECENT_LABELS_KEY));
}

function fillDatalist(id: string, values: string[]): void {
  const dl = document.getElementById(id);
  if (!dl) return;
  dl.innerHTML = '';
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    dl.appendChild(opt);
  }
}

export function goHome(prefillCwd?: string): void {
  state.selectedId = null;
  state.selectedSubagent = null;
  emit('selection-changed', { sessionId: null });
  byId('form-error').textContent = '';
  if (prefillCwd !== undefined) {
    byId<HTMLInputElement>('form-cwd').value = prefillCwd;
    wtForm?.refresh();
  }
  render();
  byId<HTMLInputElement>('form-label').focus();
}

/** 最近工作目录卡片：点击回填并聚焦标签输入 */
export function renderRecent(): void {
  const box = byId('recent-cwds');
  box.innerHTML = '';
  const list = loadRecent(RECENT_CWDS_KEY).slice(0, 3);
  for (const cwd of list) {
    const card = el('button', 'rc') as HTMLButtonElement;
    card.type = 'button';
    card.title = cwd;
    card.appendChild(el('div', 'n', cwdBaseName(cwd) || cwd));
    card.appendChild(el('div', 'p', cwd));
    card.addEventListener('click', () => {
      byId<HTMLInputElement>('form-cwd').value = cwd;
      wtForm?.refresh();
      byId<HTMLInputElement>('form-label').focus();
    });
    box.appendChild(card);
  }
}

/** 绑定首页表单与入口按钮；启动时调用一次 */
export function initHome(): void {
  const formCwd = byId<HTMLInputElement>('form-cwd');
  const formLabel = byId<HTMLInputElement>('form-label');
  const form = byId<HTMLFormElement>('new-session-form');

  migrateLegacyCwd();
  renderHistory();
  formCwd.value = loadRecent(RECENT_CWDS_KEY)[0] ?? '';
  renderRecent();
  wtForm = initWorktreeOption(api(), formCwd);

  byId('btn-new').addEventListener('click', () => goHome());
  byId('btn-browse').addEventListener('click', async () => {
    const dir = await api().pickCwd();
    if (dir) {
      formCwd.value = dir;
      wtForm?.refresh();
      formLabel.focus();
    }
  });

  // 首条提示词里 Enter 换行，Ctrl+Enter 直接创建
  byId<HTMLTextAreaElement>('form-prompt').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (creating) return;
    const cwd = formCwd.value.trim();
    const label = formLabel.value.trim();
    const formError = byId('form-error');
    if (!cwd || !label) { formError.textContent = '工作目录与任务标签都必须填写'; return; }
    const wtOpts = wtForm?.options();
    const formPrompt = byId<HTMLTextAreaElement>('form-prompt');
    const initialPrompt = formPrompt.value.trim();
    const sendBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    creating = true;
    formError.textContent = '';
    if (wtOpts) {
      // 创建工作区要跑 git worktree add，大仓库可能数秒，期间锁住表单防重复提交
      wtForm?.setBusy(true);
      byId('wt-busy').hidden = false;
      if (sendBtn) sendBtn.disabled = true;
    }
    try {
      const opts = wtOpts || initialPrompt ? { ...(wtOpts ?? {}), ...(initialPrompt ? { initialPrompt } : {}) } : undefined;
      await createSessionAndSelect(label, cwd, opts);
      if (wtOpts) wtForm?.reset();
      formPrompt.value = '';
      formLabel.value = '';
      renderHistory();
      renderRecent();
    } catch (err) {
      console.error('[create] 创建失败：', err);
      byId('form-error').textContent = ipcErrorText(err);
    } finally {
      creating = false;
      if (wtOpts) {
        wtForm?.setBusy(false);
        byId('wt-busy').hidden = true;
        if (sendBtn) sendBtn.disabled = false;
      }
    }
  });
}
