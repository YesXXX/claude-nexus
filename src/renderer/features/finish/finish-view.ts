import type { Session } from '../../../shared/types';
import type { CommandRecord, FinishStatus } from '../../../shared/review-types';
import { IN_PROGRESS_TEXT, READ_ONLY_TEXT } from '../../../shared/finish-rules.js';
import type { FinishBridge } from '../../core/api.js';
import { el, ipcErrorText } from '../../core/dom.js';
import type { DetailTabView } from '../../core/registry.js';
import type { FinishFlowDeps } from './finish-flow.js';
import { commitSection, mergeSection, prSection, pushSection, type Draft, type SectionEnv } from './finish-sections.js';
import { hms, openLogDialog, recordRow } from './log-dialog.js';

/**
 * 收尾标签页：顶部是分支与主工作区状态，下面依次是提交、合并、推送、创建 PR 四个分区和最近的操作记录。
 * 打开标签或切换会话时取一次状态；会话状态或改动统计变化时防抖重取；任何操作结束后也重取。
 * 状态里的数字一律来自主进程实时执行的 git，不做缓存推算。
 */

export type FinishAction = 'commit' | 'merge' | 'push' | 'pr';

export interface FinishView extends DetailTabView {
  refresh(): void;
  /** 命令面板入口：滚到对应分区并聚焦其主按钮或输入框 */
  reveal(action: FinishAction): void;
}

export interface FinishViewDeps {
  api: FinishBridge;
  flow: FinishFlowDeps;
  /** 状态取回后通知（供标签数字与命令面板使用） */
  onStatus(id: string, st: FinishStatus): void;
}

const LOG_SHOWN = 5;

/** 会话变化中需要重取状态的部分 */
function changeKey(s: Session): string {
  const c = s.changes;
  return [s.status, s.readOnly ? 1 : 0, c?.files, c?.additions, c?.deletions, c?.mode, s.worktree?.branch].join('|');
}

export function createFinishView(host: HTMLElement, deps: FinishViewDeps): FinishView {
  const root = el('div', 'chg-root fin-root');
  const head = el('div', 'chg-toolbar fin-head');
  const banner = el('div', 'chg-banner fin-banner');
  const body = el('div', 'fin-body');
  root.append(head, banner, body);
  host.append(root);

  const drafts = new Map<string, Draft>();
  let session: Session | undefined;
  let st: FinishStatus | undefined;
  let log: CommandRecord[] = [];
  let error = '';
  let loading = false;
  let running = false;
  let seq = 0;
  let key = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const draftOf = (id: string): Draft => {
    let d = drafts.get(id);
    if (!d) { d = { msg: '', noVerify: false, ffOnly: false }; drafts.set(id, d); }
    return d;
  };

  const load = async (): Promise<void> => {
    const s = session;
    if (!s) return;
    const my = ++seq;
    loading = true;
    renderHead();
    let next: FinishStatus | { error: string };
    let records: CommandRecord[] = [];
    try {
      [next, records] = await Promise.all([deps.api.status(s.id), deps.api.log(s.id).catch(() => [])]);
    } catch (err) {
      next = { error: ipcErrorText(err) };
    }
    if (my !== seq || session?.id !== s.id) return;
    loading = false;
    log = records;
    if ('error' in next) {
      error = next.error;
      st = undefined;
    } else {
      error = '';
      st = next;
      deps.onStatus(s.id, next);
    }
    render();
  };

  const schedule = (ms = 400): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void load(); }, ms);
  };

  const run = (op: () => Promise<unknown>): void => {
    if (running) return;
    running = true;
    render();
    void op().catch(err => deps.flow.toast(ipcErrorText(err), 'error')).finally(() => {
      running = false;
      void load();
    });
  };

  function renderHead(): void {
    head.replaceChildren();
    const s = session;
    if (!s) return;
    head.append(el('span', 'fin-branch', `⑂ ${st?.branch ?? s.worktree?.branch ?? ''}`));
    if (st) {
      const stats = el('span', 'fin-stats');
      stats.append(
        el('span', 'fin-ahead', `↑${st.ahead}`),
        el('span', 'fin-behind', ` ↓${st.behind}`),
        el('span', 'fin-dirty', ` · ${st.dirty} 个未提交`),
      );
      stats.title = `相对 ${st.baseRef}：领先 ${st.ahead}、落后 ${st.behind}；工作区 ${st.dirty} 个未提交改动`;
      head.append(stats);
      if (st.upstream) head.append(el('span', 'fin-upstream', `上游 ${st.upstream.name}`));
      const m = st.main;
      const mainText = m.inProgress
        ? `主工作区：${IN_PROGRESS_TEXT[m.inProgress]}中`
        : m.clean ? `主工作区：${m.branch ?? '分离头指针'} · 干净` : `主工作区：${m.branch ?? '分离头指针'} · ${m.dirtyCount} 个未提交`;
      const main = el('span', `fin-main${m.clean && !m.inProgress ? '' : ' warn'}`, mainText);
      main.title = m.path;
      head.append(main);
    }
    head.append(el('span', 'chg-sp'));
    if (st) head.append(el('span', 'fin-time', loading ? '检查中…' : `检查于 ${hms(st.checkedAt)}`));
    const refresh = el('button', 'chg-icon-btn fin-refresh', '⟳');
    refresh.type = 'button';
    refresh.title = '重新检查';
    refresh.disabled = loading || running;
    refresh.addEventListener('click', () => void load());
    head.append(refresh);
  }

  function renderBanner(): void {
    const lines: string[] = [];
    if (error) lines.push(error);
    if (st?.readOnly) lines.push(READ_ONLY_TEXT);
    if (st?.inProgress) lines.push(`工作区有进行中的${IN_PROGRESS_TEXT[st.inProgress]}，请先在终端里完成或放弃`);
    if (st?.main.inProgress === 'merge') lines.push('主工作区处于合并中：可以开解决冲突的会话，或放弃合并');
    banner.textContent = lines.join('；');
    banner.hidden = lines.length === 0;
  }

  function logSection(): HTMLElement {
    const box = el('section', 'fin-sec fin-log-sec');
    const h = el('div', 'fin-sec-head');
    h.append(el('h3', 'fin-sec-title', '操作记录'), el('span', 'chg-sp'));
    const all = el('button', 'chg-btn fin-log-all', `全部（${log.length}）`);
    all.type = 'button';
    all.disabled = log.length === 0;
    all.addEventListener('click', () => openLogDialog('收尾操作记录', log));
    h.append(all);
    box.append(h);
    const recent = log.slice(-LOG_SHOWN).reverse();
    if (recent.length === 0) box.append(el('div', 'fin-note', '还没有执行过收尾操作'));
    for (const r of recent) box.append(recordRow(r, () => openLogDialog(r.display, [r])));
    return box;
  }

  function render(): void {
    renderHead();
    renderBanner();
    const s = session;
    // 重建前记下焦点所在的输入框与光标，重建后恢复，避免状态刷新打断输入
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const focusKey = active && body.contains(active) ? active.dataset.focusKey : undefined;
    const sel = focusKey ? [active!.selectionStart, active!.selectionEnd] : undefined;
    const scroll = body.scrollTop;
    body.replaceChildren();
    if (!s || !st) {
      if (!error) body.append(el('div', 'fin-empty', loading ? '正在检查工作区…' : ''));
      return;
    }
    const env: SectionEnv = { s, st, draft: draftOf(s.id), running, flow: deps.flow, run };
    body.append(commitSection(env), mergeSection(env), pushSection(env, render), prSection(env), logSection());
    body.scrollTop = scroll;
    if (focusKey) {
      const again = body.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-focus-key="${focusKey}"]`);
      if (again && !again.disabled) {
        again.focus();
        if (sel && sel[0] !== null && sel[1] !== null) again.setSelectionRange(sel[0], sel[1]);
      }
    }
  }

  const SECTION: Record<FinishAction, [string, string]> = {
    commit: ['.fin-commit-sec', '.fin-msg'],
    merge: ['.fin-merge-sec', '.fin-merge'],
    push: ['.fin-push-sec', '.fin-push'],
    pr: ['.fin-pr-sec', '.fin-pr-title'],
  };

  return {
    show(s: Session): void {
      const switched = session?.id !== s.id;
      session = s;
      key = changeKey(s);
      if (switched) { st = undefined; error = ''; log = []; }
      render();
      void load();
    },
    update(s: Session): void {
      session = s;
      const k = changeKey(s);
      if (k !== key) { key = k; schedule(); }
    },
    hide(): void {
      if (timer) { clearTimeout(timer); timer = undefined; }
      seq++;
      loading = false;
    },
    focus(): void {
      const target = body.querySelector<HTMLElement>('.fin-msg:not(:disabled)') ?? head.querySelector<HTMLElement>('.fin-refresh');
      target?.focus();
    },
    refresh: () => void load(),
    reveal(action: FinishAction): void {
      const [secSel, targetSel] = SECTION[action];
      const tryReveal = (left: number): void => {
        const sec = body.querySelector<HTMLElement>(secSel);
        if (!sec) { if (left > 0) setTimeout(() => tryReveal(left - 1), 100); return; }
        sec.scrollIntoView({ block: 'nearest' });
        sec.classList.add('flash');
        setTimeout(() => sec.classList.remove('flash'), 800);
        body.querySelector<HTMLElement>(targetSel)?.focus();
      };
      tryReveal(20);
    },
  };
}
