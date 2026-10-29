import type { Session } from '../../../shared/types';
import type { VerifyConfigView } from '../../../shared/verify-types';
import { isVerifyFinal } from '../../../shared/verify-types.js';
import { fmtVerifyDuration, verifyBadge, verifyFixable } from '../../../shared/verify-view.js';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import { sessionIdle, verifyBadgeEl } from './badge.js';
import { openConfigDialog } from './config-dialog.js';
import { openOutputDialog } from './output-dialog.js';

/**
 * 属性面板「自动验证」节：仓库未配置验证命令时不显示（配置入口在命令面板「配置验证命令」与设置页）；
 * 已配置时显示命令、启用开关、最近一次结果与运行 / 取消、查看输出、发给 Claude 修复、设置。
 * 配置按会话缓存，首次渲染时后台读取，保存后全部作废重读（同仓库的会话共用配置）。
 */

interface Entry { view: VerifyConfigView | null | undefined; pending: boolean }

let ctxRef: AppContext;
const cache = new Map<string, Entry>();

export function installVerifySection(ctx: AppContext): void {
  ctxRef = ctx;
  ctx.registry.registerInspectorSection({
    id: 'verify.section', order: 100,
    render: s => (s && !s.readOnly ? renderSection(s) : null),
  });
}

/** 配置变化后作废缓存，下次渲染重新读取 */
export function invalidateVerifyConfigs(): void {
  cache.clear();
  ctxRef?.requestRender();
}

function configOf(id: string): VerifyConfigView | null | undefined {
  let e = cache.get(id);
  if (!e) {
    if (cache.size > 50) {
      const alive = new Set(ctxRef.state.sessions.map(x => x.id));
      for (const k of [...cache.keys()]) if (!alive.has(k)) cache.delete(k);
    }
    e = { view: undefined, pending: false };
    cache.set(id, e);
  }
  if (e.view === undefined && !e.pending) {
    const entry = e;
    entry.pending = true;
    void ctxRef.api.verify.getConfig(id).then(v => {
      if (cache.get(id) !== entry) return;
      entry.view = v;
      entry.pending = false;
      ctxRef.requestRender();
    }).catch(err => {
      if (cache.get(id) === entry) { entry.view = null; entry.pending = false; }
      console.error('[verify] 读取验证配置失败：', err);
    });
  }
  return e.view;
}

function actBtn(act: string, text: string, onClick: () => void, title = ''): HTMLButtonElement {
  const b = el('button', 'btn verify-act', text);
  b.type = 'button';
  b.dataset.act = act;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function openSettings(id: string): void {
  void openConfigDialog(ctxRef, id, invalidateVerifyConfigs);
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderResult(s: Session): HTMLElement {
  const box = el('div', 'verify-last');
  const v = s.verify;
  if (!v) {
    box.appendChild(el('span', 'verify-none', '还没有运行过；Claude 每轮结束后自动运行'));
    return box;
  }
  const view = verifyBadge(v);
  box.appendChild(verifyBadgeEl(v, () => openOutputDialog(ctxRef, s.id)));
  const text = el('span', 'verify-last-text', view.text);
  text.title = view.title;
  box.appendChild(text);
  const meta: string[] = [];
  if (v.finishedAt && isVerifyFinal(v.status)) meta.push(fmtTime(v.finishedAt));
  if (v.durationMs !== undefined && isVerifyFinal(v.status)) meta.push(fmtVerifyDuration(v.durationMs));
  if (meta.length) box.appendChild(el('span', 'verify-last-meta', meta.join(' · ')));
  return box;
}

function renderSection(s: Session): HTMLElement | null {
  const view = configOf(s.id);
  if (!view || !view.config) return null;
  const sec = el('section', 'sec verify-sec');
  sec.dataset.sessionId = s.id;
  const h = el('h4');
  h.appendChild(el('span', '', '自动验证'));
  sec.appendChild(h);
  const cfg = view.config;
  const row = el('div', 'verify-cmd-row');
  const cmd = el('code', 'verify-cmd', cfg.command);
  cmd.title = cfg.command;
  const toggle = el('label', 'verify-toggle');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = cfg.enabled;
  cb.dataset.act = 'enabled';
  cb.addEventListener('change', () => {
    void ctxRef.api.verify.setConfig(view.repoKey, { ...cfg, enabled: cb.checked }).then(r => {
      if (!r.ok) ctxRef.toast(r.error, 'error');
      invalidateVerifyConfigs();
    }).catch(err => ctxRef.toast(ipcErrorText(err), 'error'));
  });
  toggle.append(cb, el('span', '', '自动'));
  toggle.title = '每轮结束后自动验证';
  row.append(cmd, toggle);
  sec.appendChild(row);
  sec.appendChild(renderResult(s));

  const idle = sessionIdle(s);
  const running = !!s.verify && !isVerifyFinal(s.verify.status);
  const ops = el('div', 'verify-ops');
  if (running) {
    ops.appendChild(actBtn('cancel', '取消', () => {
      void ctxRef.api.verify.cancel(s.id);
    }));
  } else {
    const run = actBtn('run', '运行', () => {
      void ctxRef.api.verify.run(s.id).then(r => { if (!r.ok) ctxRef.toast(r.reason ?? '无法运行', 'warning'); });
    }, idle ? '立即运行验证命令' : 'Claude 正忙');
    run.disabled = !idle;
    ops.appendChild(run);
  }
  if (s.verify) ops.appendChild(actBtn('output', '查看输出', () => openOutputDialog(ctxRef, s.id)));
  if (verifyFixable(s.verify)) {
    const fix = actBtn('fix', '发给 Claude 修复', () => {
      fix.disabled = true;
      void ctxRef.api.verify.sendToClaude(s.id).then(r => {
        if (r.ok) ctxRef.toast('已把失败输出发给 Claude');
        else ctxRef.toast(r.reason ?? '发送失败', 'warning');
      });
    }, idle ? '把命令、退出码与输出末尾发给 Claude' : 'Claude 正忙');
    fix.disabled = !idle;
    ops.appendChild(fix);
  }
  ops.appendChild(actBtn('settings', '设置', () => openSettings(s.id)));
  sec.appendChild(ops);
  if (s.verify?.interfered) {
    sec.appendChild(el('div', 'verify-note', `验证期间另有 ${s.verify.interfered} 个会话在此目录工作，结果可能受影响`));
  }
  return sec;
}
