import type { VerifyConfig, VerifyConfigView } from '../../../shared/verify-types';
import {
  VERIFY_CONCURRENCY_MAX, VERIFY_CONCURRENCY_MIN, VERIFY_TIMEOUT_DEFAULT, VERIFY_TIMEOUT_MAX, VERIFY_TIMEOUT_MIN,
} from '../../../shared/verify-types.js';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';

/**
 * 验证配置对话框：命令、启用、超时、无改动跳过、准备命令，以及全局并发与失败通知。
 * 配置按仓库保存（工作区会话共用主仓库），写回时带上读取时拿到的仓库键。
 * 校验以主进程为准，失败原因显示在对话框内、对话框保持打开。
 */

let open: { close(): void } | null = null;

export function isConfigDialogOpen(): boolean {
  return open !== null;
}

function textField(id: string, label: string, value: string, placeholder: string, hint?: string): { lab: HTMLElement; input: HTMLInputElement } {
  const lab = el('label', 'verify-cfg-field');
  lab.appendChild(el('span', 'verify-cfg-lab', label));
  const input = el('input');
  input.type = 'text';
  input.id = id;
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  lab.appendChild(input);
  if (hint) lab.appendChild(el('span', 'verify-cfg-hint', hint));
  return { lab, input };
}

function checkField(id: string, label: string, checked: boolean): { lab: HTMLElement; input: HTMLInputElement } {
  const lab = el('label', 'verify-cfg-check');
  const input = el('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = checked;
  lab.append(input, el('span', '', label));
  return { lab, input };
}

function numField(id: string, label: string, value: number, min: number, max: number): { lab: HTMLElement; input: HTMLInputElement } {
  const lab = el('label', 'verify-cfg-field verify-cfg-num');
  lab.appendChild(el('span', 'verify-cfg-lab', label));
  const input = el('input');
  input.type = 'number';
  input.id = id;
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  lab.appendChild(input);
  return { lab, input };
}

function button(id: string, text: string, cls = 'btn'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.id = id;
  return b;
}

/** 打开某会话所属仓库的配置；保存或删除成功后调用 onSaved */
export async function openConfigDialog(ctx: AppContext, sessionId: string, onSaved: () => void): Promise<void> {
  let view: VerifyConfigView | null;
  try {
    view = await ctx.api.verify.getConfig(sessionId);
  } catch (err) {
    ctx.toast(`读取验证配置失败：${ipcErrorText(err)}`, 'error');
    return;
  }
  if (!view) { ctx.toast('会话不存在', 'error'); return; }
  open?.close();
  const v = view;
  const c: Partial<VerifyConfig> = v.config ?? {};
  const prevFocus = document.activeElement as HTMLElement | null;
  const backdrop = el('div', 'modal-backdrop');
  backdrop.id = 'verify-cfg-backdrop';
  const modal = el('div', 'modal verify-cfg-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.appendChild(el('h2', '', '自动验证'));
  const repo = el('div', 'verify-cfg-repo');
  repo.append(el('span', 'verify-cfg-path', v.repoRoot));
  repo.append(el('span', 'verify-cfg-hint', v.isRepo ? '对此仓库下所有会话（含独立工作区）生效' : '不是 git 仓库：只对这个目录生效，且不做无改动跳过'));
  modal.appendChild(repo);
  modal.appendChild(el('div', 'verify-cfg-warn',
    '验证命令在会话目录中直接执行，请勿配置会修改源码的命令（如 lint --fix、format）。每轮结束后自动运行，Claude 开始新一轮时立即中止。'));

  const cmd = textField('verify-cfg-cmd', '验证命令', c.command ?? '', '如 npm test 或 mvn -q test', '只能写一行，多条命令用 && 连接');
  const enabled = checkField('verify-cfg-enabled', '每轮结束后自动验证', c.enabled ?? true);
  const skip = checkField('verify-cfg-skip', '工作区无改动时跳过，沿用上次结果', c.skipUnchanged ?? true);
  const timeout = numField('verify-cfg-timeout', '超时（秒）', c.timeoutSec ?? VERIFY_TIMEOUT_DEFAULT, VERIFY_TIMEOUT_MIN, VERIFY_TIMEOUT_MAX);
  const setup = textField('verify-cfg-setup', '准备命令（可选）', c.setupCommand ?? '', '如 npm ci', '每个会话第一次验证前执行一次');
  const conc = numField('verify-cfg-concurrency', '全局并发上限', v.global.maxConcurrent, VERIFY_CONCURRENCY_MIN, VERIFY_CONCURRENCY_MAX);
  const notify = checkField('verify-cfg-notify', '失败时发系统通知', v.global.notifyOnFail);

  const repoBox = el('div', 'verify-cfg-group');
  const nums = el('div', 'verify-cfg-row');
  nums.append(timeout.lab);
  repoBox.append(cmd.lab, nums, enabled.lab, skip.lab, setup.lab);
  const globalBox = el('div', 'verify-cfg-group');
  globalBox.appendChild(el('div', 'verify-cfg-gh', '全局设置（所有仓库）'));
  const gRow = el('div', 'verify-cfg-row');
  gRow.append(conc.lab);
  globalBox.append(gRow, notify.lab);
  modal.append(repoBox, globalBox);

  const err = el('div', 'form-error');
  err.id = 'verify-cfg-error';
  const del = button('verify-cfg-delete', '删除配置', 'btn danger');
  del.hidden = !v.config;
  const cancel = button('verify-cfg-cancel', '取消');
  const save = button('verify-cfg-save', '保存', 'btn white');
  const btns = el('div', 'dialog-buttons');
  btns.append(del, el('span', 'chg-sp'), cancel, save);
  modal.append(err, btns);
  backdrop.appendChild(modal);

  const close = (): void => {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    open = null;
    prevFocus?.focus?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    // 删除确认框打开时按键交给确认框
    const confirmBox = document.getElementById('confirm-backdrop');
    if (confirmBox && !confirmBox.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') {
      e.preventDefault();
      e.stopPropagation();
      void submit();
    }
  };
  const busy = (on: boolean): void => { save.disabled = on; del.disabled = on; };

  const submit = async (): Promise<void> => {
    err.textContent = '';
    busy(true);
    try {
      const r = await ctx.api.verify.setConfig(v.repoKey, {
        command: cmd.input.value,
        enabled: enabled.input.checked,
        timeoutSec: Number(timeout.input.value),
        skipUnchanged: skip.input.checked,
        ...(setup.input.value.trim() ? { setupCommand: setup.input.value, setupTimeoutSec: c.setupTimeoutSec } : {}),
      });
      if (!r.ok) { err.textContent = r.error; cmd.input.focus(); return; }
      await ctx.api.verify.setGlobal({ maxConcurrent: Number(conc.input.value), notifyOnFail: notify.input.checked });
      ctx.toast('验证配置已保存');
      close();
      onSaved();
    } catch (e) {
      err.textContent = ipcErrorText(e);
    } finally {
      busy(false);
    }
  };

  del.addEventListener('click', () => {
    void ctx.confirm({ title: '删除验证配置', message: `删除后此仓库不再自动验证：\n${v.repoRoot}`, okText: '删除', danger: true })
      .then(async ok => {
        if (!ok) return;
        const r = await ctx.api.verify.setConfig(v.repoKey, null);
        if (!r.ok) { err.textContent = r.error; return; }
        ctx.toast('验证配置已删除');
        close();
        onSaved();
      });
  });
  cancel.addEventListener('click', close);
  save.addEventListener('click', () => { void submit(); });
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);
  open = { close };
  cmd.input.focus();
}
