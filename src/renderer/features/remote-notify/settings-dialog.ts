import {
  WEBHOOK_EVENT_GROUPS, WEBHOOK_MAX_TARGETS, type WebhookConfigDraft, type WebhookConfigView, type WebhookSendResult,
} from '../../../shared/webhook-types.js';
import type { NotifyKind } from '../../../shared/types';
import type { WebhookBridge } from '../../core/api.js';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { createTargetRow, rowDraft, setRowError, setRowLast, type TargetRow } from './target-row.js';

/**
 * 远程通知设置弹窗：总开关、目标列表、推送事件、推送时机、静默时段、节流与摘要开关。
 * 表单只做即时提示（地址格式、时间格式），保存与测试的最终校验以主进程返回的逐字段错误为准。
 * 弹窗第一次打开时创建并挂到 body，之后复用；每次打开重新读取配置。
 */

interface Dialog {
  backdrop: HTMLElement;
  enabled: HTMLInputElement;
  targetBox: HTMLElement;
  add: HTMLButtonElement;
  events: Map<string, HTMLInputElement>;
  whenAway: HTMLInputElement;
  whenAlways: HTMLInputElement;
  awayMin: HTMLInputElement;
  quietOn: HTMLInputElement;
  quietStart: HTMLInputElement;
  quietEnd: HTMLInputElement;
  throttle: HTMLInputElement;
  summary: HTMLInputElement;
  encWarn: HTMLElement;
  error: HTMLElement;
  testAll: HTMLButtonElement;
  save: HTMLButtonElement;
  fieldErrs: Map<string, HTMLElement>;
  rows: TargetRow[];
  view: WebhookConfigView | null;
  busy: boolean;
}

let api: WebhookBridge;
let toast: AppContext['toast'];
let onSaved: (view: WebhookConfigView) => void = () => undefined;
let dlg: Dialog | null = null;
let prevFocus: HTMLElement | null = null;

/** 绑定 api；saved 在保存成功后以新配置回调 */
export function bindRemoteNotifyDialog(ctx: AppContext, saved?: (view: WebhookConfigView) => void): void {
  api = ctx.api.webhook;
  toast = ctx.toast;
  if (saved) onSaved = saved;
}

export function isRemoteNotifyOpen(): boolean {
  return !!dlg && !dlg.backdrop.hidden;
}

function input(type: string, id: string, cls = ''): HTMLInputElement {
  const i = el('input', cls);
  i.type = type;
  i.id = id;
  i.spellcheck = false;
  i.autocomplete = 'off';
  return i;
}

function check(id: string, text: string): { label: HTMLLabelElement; box: HTMLInputElement } {
  const label = el('label', 'rn-check');
  const box = input('checkbox', id);
  label.append(box, el('span', '', text));
  return { label, box };
}

function fieldErr(d: Pick<Dialog, 'fieldErrs'>, key: string): HTMLElement {
  const e = el('div', 'rn-err');
  e.dataset.field = key;
  e.hidden = true;
  d.fieldErrs.set(key, e);
  return e;
}

function row(title: string, ...nodes: Node[]): HTMLElement {
  const r = el('div', 'rn-row');
  r.appendChild(el('span', 'rn-lab', title));
  const body = el('div', 'rn-body');
  body.append(...nodes);
  r.appendChild(body);
  return r;
}

function line(...nodes: Node[]): HTMLElement {
  const l = el('span', 'rn-line');
  l.append(...nodes);
  return l;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 时间框即时提示：格式不对时显示在字段下方 */
function hhmmHint(d: Dialog, box: HTMLInputElement, key: string): void {
  const v = box.value.trim();
  showFieldErr(d, key, v && !HHMM.test(v) ? '时间格式为 HH:mm，如 22:00' : '');
}

function showFieldErr(d: Dialog, key: string, text: string): void {
  const e = d.fieldErrs.get(key);
  if (!e) return;
  e.textContent = text;
  e.hidden = !text;
}

function buildDialog(): Dialog {
  const backdrop = el('div', 'modal-backdrop');
  backdrop.id = 'rn-backdrop';
  backdrop.hidden = true;
  const modal = el('div', 'modal rn-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'rn-title');
  const form = el('form');
  form.id = 'rn-form';
  form.noValidate = true;
  const title = el('h2', '', '远程通知');
  title.id = 'rn-title';

  const partial: Pick<Dialog, 'fieldErrs'> = { fieldErrs: new Map() };
  const en = check('rn-enabled', '启用远程通知（推送到企业微信 / 钉钉 / 飞书群机器人）');
  const targetBox = el('div', 'rn-targets');
  targetBox.id = 'rn-targets';
  const add = el('button', 'btn sm rn-add', `＋ 添加目标（最多 ${WEBHOOK_MAX_TARGETS} 个）`);
  add.type = 'button';
  add.id = 'rn-add';

  const events = new Map<string, HTMLInputElement>();
  const evLine = el('div', 'rn-events');
  for (const g of WEBHOOK_EVENT_GROUPS) {
    const c = check(`rn-ev-${g.key}`, g.text);
    c.box.dataset.group = g.key;
    events.set(g.key, c.box);
    evLine.appendChild(c.label);
  }

  const whenAway = input('radio', 'rn-when-away');
  whenAway.name = 'rn-when';
  whenAway.value = 'away';
  const whenAlways = input('radio', 'rn-when-always');
  whenAlways.name = 'rn-when';
  whenAlways.value = 'always';
  const awayMin = input('text', 'rn-away-min', 'rn-num');
  const awayLab = el('label', 'rn-check');
  awayLab.append(whenAway, el('span', '', '仅离开时：空闲'), awayMin, el('span', '', '分钟或锁屏'));
  const alwaysLab = el('label', 'rn-check');
  alwaysLab.append(whenAlways, el('span', '', '始终'));

  const quiet = check('rn-quiet-on', '');
  const quietStart = input('text', 'rn-quiet-start', 'rn-time');
  quietStart.placeholder = '22:00';
  const quietEnd = input('text', 'rn-quiet-end', 'rn-time');
  quietEnd.placeholder = '08:00';

  const throttle = input('text', 'rn-throttle', 'rn-num');
  const summary = check('rn-summary', '消息包含命令摘要（已自动打码）');

  const encWarn = el('div', 'rn-warn', '⚠ 系统加密不可用，URL 与 secret 将以明文保存在本机');
  encWarn.id = 'rn-enc-warn';
  encWarn.hidden = true;
  const error = el('div', 'form-error rn-error');
  error.id = 'rn-error';

  const testAll = el('button', 'btn', '发送测试消息');
  testAll.type = 'button';
  testAll.id = 'rn-test-all';
  const cancel = el('button', 'btn', '取消');
  cancel.type = 'button';
  cancel.id = 'rn-cancel';
  const save = el('button', 'btn white', '保存');
  save.type = 'submit';
  save.id = 'rn-save';
  const buttons = el('div', 'dialog-buttons');
  buttons.append(testAll, cancel, save);

  const d: Dialog = {
    backdrop, enabled: en.box, targetBox, add, events, whenAway, whenAlways, awayMin,
    quietOn: quiet.box, quietStart, quietEnd, throttle, summary: summary.box, encWarn, error, testAll, save,
    fieldErrs: partial.fieldErrs, rows: [], view: null, busy: false,
  };
  form.append(
    title, en.label,
    row('目标', targetBox, fieldErr(d, 'targets'), add),
    row('推送事件', evLine),
    row('推送时机', line(awayLab, alwaysLab), fieldErr(d, 'awayMinutes')),
    row('静默时段', line(quiet.label, quietStart, el('span', '', '至'), quietEnd),
      fieldErr(d, 'quiet.start'), fieldErr(d, 'quiet.end')),
    row('同会话节流', line(throttle, el('span', '', '秒'), summary.label), fieldErr(d, 'throttleSec')),
    encWarn, error, buttons,
  );
  modal.appendChild(form);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  add.addEventListener('click', () => { addRow(d, null).name.focus(); });
  quietStart.addEventListener('input', () => hhmmHint(d, quietStart, 'quiet.start'));
  quietEnd.addEventListener('input', () => hhmmHint(d, quietEnd, 'quiet.end'));
  testAll.addEventListener('click', () => { void runTest(d); });
  cancel.addEventListener('click', () => close(d));
  form.addEventListener('submit', e => { e.preventDefault(); void submit(d); });
  return d;
}

function syncAdd(d: Dialog): void {
  d.add.disabled = d.rows.length >= WEBHOOK_MAX_TARGETS;
  d.targetBox.classList.toggle('empty', d.rows.length === 0);
}

function addRow(d: Dialog, view: WebhookConfigView['targets'][number] | null): TargetRow {
  const r = createTargetRow(view, {
    onTest: row => { void runTest(d, row); },
    onDelete: row => {
      d.rows = d.rows.filter(x => x !== row);
      row.root.remove();
      syncAdd(d);
    },
  });
  d.rows.push(r);
  d.targetBox.appendChild(r.root);
  if (view && d.view) setRowLast(r, d.view.lastResults[view.id], d.view.circuitOpenUntil[view.id]);
  syncAdd(d);
  return r;
}

function fill(d: Dialog, v: WebhookConfigView): void {
  d.view = v;
  d.enabled.checked = v.enabled;
  for (const r of d.rows) r.root.remove();
  d.rows = [];
  for (const t of v.targets) addRow(d, t);
  syncAdd(d);
  for (const g of WEBHOOK_EVENT_GROUPS) d.events.get(g.key)!.checked = g.kinds.every(k => v.events[k]);
  d.whenAway.checked = v.when === 'away';
  d.whenAlways.checked = v.when === 'always';
  d.awayMin.value = String(v.awayMinutes);
  d.quietOn.checked = v.quiet.enabled;
  d.quietStart.value = v.quiet.start;
  d.quietEnd.value = v.quiet.end;
  d.throttle.value = String(v.throttleSec);
  d.summary.checked = v.includeSummary;
  d.encWarn.hidden = v.encryptionAvailable;
}

function int(box: HTMLInputElement): number {
  const t = box.value.trim();
  return t === '' ? Number.NaN : Number(t);
}

export function collectDraft(d: Dialog): WebhookConfigDraft {
  const events = {} as Record<NotifyKind, boolean>;
  for (const g of WEBHOOK_EVENT_GROUPS) for (const k of g.kinds) events[k] = d.events.get(g.key)!.checked;
  return {
    enabled: d.enabled.checked,
    targets: d.rows.map(rowDraft),
    events,
    when: d.whenAlways.checked ? 'always' : 'away',
    awayMinutes: int(d.awayMin),
    quiet: { enabled: d.quietOn.checked, start: d.quietStart.value.trim(), end: d.quietEnd.value.trim() },
    throttleSec: int(d.throttle),
    includeSummary: d.summary.checked,
  };
}

function clearErrors(d: Dialog): void {
  for (const k of d.fieldErrs.keys()) showFieldErr(d, k, '');
  for (const r of d.rows) setRowError(r, '');
  d.error.textContent = '';
}

/** 逐字段显示主进程返回的错误；目标字段显示在对应目标行，认不出的键汇总到底部 */
function showErrors(d: Dialog, errors: Record<string, string>): void {
  clearErrors(d);
  const rest: string[] = [];
  for (const [k, v] of Object.entries(errors)) {
    const m = /^targets\.(\d+)\.\w+$/.exec(k);
    if (m && d.rows[Number(m[1])]) setRowError(d.rows[Number(m[1])], v);
    else if (d.fieldErrs.has(k)) showFieldErr(d, k, v);
    else rest.push(v);
  }
  d.error.textContent = rest.length > 0 ? rest.join('；') : '请修正标红的字段';
}

function setBusy(d: Dialog, busy: boolean, testing?: TargetRow | 'all'): void {
  d.busy = busy;
  d.save.disabled = busy;
  d.testAll.disabled = busy;
  d.testAll.textContent = busy && testing === 'all' ? '发送中…' : '发送测试消息';
  for (const r of d.rows) {
    r.test.disabled = busy;
    r.test.textContent = busy && (testing === 'all' ? r.enabled.checked : testing === r) ? '发送中…' : '测试';
  }
}

async function runTest(d: Dialog, only?: TargetRow): Promise<void> {
  if (d.busy) return;
  clearErrors(d);
  setBusy(d, true, only ?? 'all');
  try {
    const res = await api.test({ draft: collectDraft(d), ...(only ? { onlyTargetId: only.id } : {}) });
    if (!res.ok) { showErrors(d, res.errors); return; }
    const byId = new Map<string, WebhookSendResult>(res.results.map(r => [r.targetId, r]));
    for (const r of d.rows) {
      const hit = byId.get(r.id);
      if (hit) setRowLast(r, hit, d.view?.circuitOpenUntil[r.id]);
    }
    const okCount = res.results.filter(r => r.ok).length;
    d.error.textContent = okCount === res.results.length
      ? ''
      : `${res.results.length - okCount} 个目标发送失败，原因见各目标的「最近」行`;
  } catch (err) {
    d.error.textContent = ipcErrorText(err) || '发送测试消息失败';
  } finally {
    setBusy(d, false);
  }
}

async function submit(d: Dialog): Promise<void> {
  if (d.busy) return;
  clearErrors(d);
  setBusy(d, true);
  try {
    const res = await api.setConfig(collectDraft(d));
    if (!res.ok) { showErrors(d, res.errors); return; }
    fill(d, res.config);
    close(d);
    toast('远程通知设置已保存', 'success');
    onSaved(res.config);
  } catch (err) {
    d.error.textContent = ipcErrorText(err) || '保存失败';
  } finally {
    setBusy(d, false);
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !dlg || dlg.backdrop.hidden) return;
  e.preventDefault();
  e.stopPropagation();
  close(dlg);
}

function close(d: Dialog): void {
  d.backdrop.hidden = true;
  document.removeEventListener('keydown', onKey, true);
  if (prevFocus && prevFocus.isConnected) prevFocus.focus();
  prevFocus = null;
}

/** 打开远程通知设置；每次打开重新读取配置，丢弃上次未保存的修改 */
export async function openRemoteNotify(): Promise<void> {
  if (!dlg) dlg = buildDialog();
  const d = dlg;
  try {
    fill(d, await api.getConfig());
  } catch (err) {
    toast(`读取远程通知设置失败：${ipcErrorText(err)}`, 'error');
    return;
  }
  clearErrors(d);
  if (d.backdrop.hidden) {
    prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.addEventListener('keydown', onKey, true);
  }
  d.backdrop.hidden = false;
  d.enabled.focus();
}
