import { BATCH_MAX } from '../../../shared/batch-types.js';
import type { BatchProgress } from '../../../shared/batch-types';
import { clampBatchCount, createSummary } from '../../../shared/batch-view.js';
import type { AppContext } from '../../core/context.js';
import { byId, ipcErrorText } from '../../core/dom.js';
import { pushRecent, RECENT_CWDS_KEY, RECENT_LABELS_KEY } from '../../core/persist.js';

/**
 * 新建表单里的「并行方案数」：勾选独立工作区后出现，范围 1～6。
 * 大于 1 时提交按钮改为「派发 N 个方案」，首条提示词必填，分支名由每个方案自动生成；
 * 提交在捕获阶段拦下（先于首页表单自己的提交处理），改走批量派发，创建期间显示「正在创建 i/N…」。
 * 方案数为 1 或未勾选独立工作区时不拦截，行为与单个新建完全一致。
 */

/** 单个新建时提示位留空；批量模式才写出派发数量，提醒提交行为已改变 */
const HINT_SINGLE = '';
const PROMPT_PLACEHOLDER = '首条提示词（可选）';
const PROMPT_REQUIRED = '首条提示词（批量派发必填）：每个方案都会收到同一条提示词';

interface FormEls {
  form: HTMLFormElement;
  label: HTMLInputElement;
  cwd: HTMLInputElement;
  prompt: HTMLTextAreaElement;
  toggle: HTMLInputElement;
  row: HTMLElement;
  count: HTMLInputElement;
  branch: HTMLInputElement;
  base: HTMLInputElement;
  busy: HTMLElement;
  note: HTMLElement;
  hint: HTMLElement | null;
  send: HTMLButtonElement | null;
}

export function installBatchForm(ctx: AppContext, onCreated: (batchId: string) => void): void {
  const form = document.getElementById('new-session-form') as HTMLFormElement | null;
  const countInput = document.getElementById('wt-count') as HTMLInputElement | null;
  if (!form || !countInput) return;
  const els: FormEls = {
    form, count: countInput,
    label: byId<HTMLInputElement>('form-label'),
    cwd: byId<HTMLInputElement>('form-cwd'),
    prompt: byId<HTMLTextAreaElement>('form-prompt'),
    toggle: byId<HTMLInputElement>('wt-on'),
    row: byId('wt-row'),
    branch: byId<HTMLInputElement>('wt-branch'),
    base: byId<HTMLInputElement>('wt-base'),
    busy: byId('wt-busy'),
    note: byId('batch-note'),
    hint: form.querySelector<HTMLElement>('.home-hint'),
    send: form.querySelector<HTMLButtonElement>('button[type="submit"]'),
  };
  let creating = false;
  let progressCb: ((p: BatchProgress) => void) | null = null;
  ctx.api.batch.onProgress(p => progressCb?.(p));

  /** 当前是否处于批量模式：独立工作区可用且已勾选、方案数大于 1 */
  const batchCount = (): number => {
    // 提交中开关被临时禁用，此时仍按批量模式显示
    if (els.row.hidden || !els.toggle.checked || (els.toggle.disabled && !creating)) return 1;
    return clampBatchCount(els.count.value);
  };

  const paint = (): void => {
    const n = batchCount();
    const batch = n > 1;
    els.form.classList.toggle('batch-mode', batch);
    if (els.hint) els.hint.textContent = batch ? `Enter 派发 ${n} 个方案` : HINT_SINGLE;
    if (els.send) {
      els.send.title = batch ? `派发 ${n} 个方案` : '创建会话';
      els.send.setAttribute('aria-label', els.send.title);
    }
    els.prompt.placeholder = batch ? PROMPT_REQUIRED : PROMPT_PLACEHOLDER;
    els.branch.disabled = batch || creating;
    if (batch) els.branch.placeholder = '每个方案自动生成 nexus/…';
    else els.branch.placeholder = '留空自动生成 nexus/…';
    els.note.hidden = !batch;
    els.note.textContent = batch ? `每个方案一个独立工作区，磁盘占用约为 ${n} 倍工作区大小；创建后自动打开对比视图` : '';
  };

  const normalizeCount = (): void => {
    const n = clampBatchCount(els.count.value);
    if (String(n) !== els.count.value) els.count.value = String(n);
    paint();
  };
  els.count.addEventListener('input', paint);
  els.count.addEventListener('change', normalizeCount);
  els.count.addEventListener('blur', normalizeCount);
  els.toggle.addEventListener('change', paint);
  // 工作区选项行的显隐由仓库探测异步决定，观察属性变化来同步批量提示
  new MutationObserver(paint).observe(els.row, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(paint).observe(els.toggle, { attributes: true, attributeFilter: ['disabled'] });

  const setBusy = (on: boolean, text = ''): void => {
    creating = on;
    for (const x of [els.label, els.cwd, els.prompt, els.count, els.base, els.toggle]) x.disabled = on;
    if (els.send) els.send.disabled = on;
    els.busy.hidden = !on;
    els.busy.textContent = on ? text : '正在创建工作区…';
    paint();
  };

  const submit = async (n: number): Promise<void> => {
    const formError = byId('form-error');
    const label = els.label.value.trim();
    const cwd = els.cwd.value.trim();
    const prompt = els.prompt.value.trim();
    if (!cwd || !label) { formError.textContent = '工作目录与任务标签都必须填写'; return; }
    if (!prompt) {
      formError.textContent = '批量派发需要填写首条提示词';
      els.prompt.focus();
      return;
    }
    formError.textContent = '';
    setBusy(true, `正在创建 1/${n}…`);
    progressCb = p => {
      if (p.done < p.total) els.busy.textContent = `正在创建 ${p.done + 1}/${p.total}…`;
    };
    try {
      const base = els.base.value.trim();
      const r = await ctx.api.batch.create({ label, cwd, prompt, count: n, ...(base ? { baseRef: base } : {}) });
      const sum = createSummary(r, n);
      ctx.toast(sum.text, sum.level);
      if (!r.batch) { formError.textContent = sum.text; return; }
      pushRecent(RECENT_CWDS_KEY, cwd);
      pushRecent(RECENT_LABELS_KEY, label);
      els.label.value = '';
      els.prompt.value = '';
      els.base.value = '';
      els.count.value = '1';
      onCreated(r.batch.id);
    } catch (err) {
      formError.textContent = ipcErrorText(err);
    } finally {
      progressCb = null;
      setBusy(false);
    }
  };

  // 捕获阶段在 document 上拦截：先于表单自身的提交监听执行
  document.addEventListener('submit', e => {
    if (e.target !== els.form) return;
    const n = batchCount();
    if (n <= 1 && !creating) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!creating) void submit(n);
  }, true);

  els.count.max = String(BATCH_MAX);
  paint();
}
