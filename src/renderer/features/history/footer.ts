import type { HistoryMeta } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import type { DialogChoice } from '../../core/dialog-types.js';
import { el, ipcErrorText } from '../../core/dom.js';

type ClearMode = 'keep' | 'all';

/**
 * 历史面板底栏：显示保留策略，可展开修改条数与天数上限（改后主进程立即按新上限清理），
 * 以及清空历史（二次确认，可选择保留固定的记录）。
 */

export const COUNT_RANGE: [number, number] = [20, 5000];
export const DAYS_RANGE: [number, number] = [1, 3650];

export interface FooterHost {
  degraded(): boolean;
  reload(): void;
}

function numInput(id: string, [min, max]: [number, number]): HTMLInputElement {
  const i = el('input', 'hist-num') as HTMLInputElement;
  i.id = id;
  i.type = 'number';
  i.min = String(min);
  i.max = String(max);
  i.step = '1';
  return i;
}

function inRange(v: number, [min, max]: [number, number]): boolean {
  return Number.isInteger(v) && v >= min && v <= max;
}

export function buildFooter(ctx: AppContext, host: FooterHost): { el: HTMLElement; paint(meta: HistoryMeta): void } {
  const foot = el('div', 'hist-foot');
  const policy = el('span', 'hist-policy');
  policy.id = 'history-policy';
  const bEdit = el('button', 'btn sm', '保留策略');
  bEdit.type = 'button';
  bEdit.id = 'history-policy-edit';
  const form = el('div', 'hist-policy-form');
  form.id = 'history-policy-form';
  form.hidden = true;
  const count = numInput('history-max-count', COUNT_RANGE);
  const days = numInput('history-max-days', DAYS_RANGE);
  const bSave = el('button', 'btn sm white', '保存');
  bSave.type = 'button';
  bSave.id = 'history-policy-save';
  form.append(el('span', '', '最多'), count, el('span', '', '条，且不超过'), days, el('span', '', '天'), bSave);
  const bClear = el('button', 'btn sm danger', '清空历史');
  bClear.type = 'button';
  bClear.id = 'history-clear';
  foot.append(policy, bEdit, form, el('span', 'sp'), bClear);

  let meta: HistoryMeta | null = null;

  const showPolicy = async (): Promise<void> => {
    try {
      const s = await ctx.api.resumeSettingsGet();
      policy.textContent = `保留最近 ${s.historyMaxCount} 条、${s.historyMaxDays} 天内的历史；固定的不受限制`;
      count.value = String(s.historyMaxCount);
      days.value = String(s.historyMaxDays);
    } catch {
      policy.textContent = '保留策略读取失败';
    }
  };

  bEdit.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) count.focus();
  });
  bSave.addEventListener('click', () => void (async () => {
    const c = Number(count.value);
    const d = Number(days.value);
    if (!inRange(c, COUNT_RANGE) || !inRange(d, DAYS_RANGE)) {
      ctx.toast(`条数需在 ${COUNT_RANGE[0]}～${COUNT_RANGE[1]}，天数需在 ${DAYS_RANGE[0]}～${DAYS_RANGE[1]} 之间`, 'warning');
      return;
    }
    try {
      await ctx.api.resumeSettingsSet({ historyMaxCount: c, historyMaxDays: d });
      form.hidden = true;
      await showPolicy();
      ctx.toast('已更新保留策略', 'success');
      host.reload();
    } catch (e) {
      ctx.toast(ipcErrorText(e), 'error');
    }
  })());

  bClear.addEventListener('click', () => void (async () => {
    const total = meta?.total ?? 0;
    const pinned = meta?.pinned ?? 0;
    const choices: Array<DialogChoice<ClearMode>> = pinned > 0
      ? [
        { value: 'keep', text: `清空，保留 ${pinned} 条固定的`, style: 'primary' },
        { value: 'all', text: '全部清空', style: 'danger' },
      ]
      : [{ value: 'all', text: '全部清空', style: 'danger' }];
    const pick = await ctx.choice<ClearMode>({
      title: '清空会话历史？',
      message: `将删除 ${total} 条已结束会话的记录，不可撤销。\n不会删除工作区与 Claude 自己的对话记录。`,
      choices,
      danger: true,
      defaultValue: pinned > 0 ? 'keep' : undefined,
    });
    if (pick !== 'keep' && pick !== 'all') return;
    try {
      const removed = await ctx.api.recordsClear(pick === 'keep');
      ctx.toast(`已清空 ${removed.length} 条历史`, 'success');
    } catch (e) {
      ctx.toast(ipcErrorText(e), 'error');
    }
    host.reload();
  })());

  return {
    el: foot,
    paint(m: HistoryMeta): void {
      meta = m;
      const off = host.degraded();
      bEdit.disabled = off;
      bSave.disabled = off;
      bClear.disabled = off || m.total === 0;
      void showPolicy();
    },
  };
}
