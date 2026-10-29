import type { NotificationPayload } from '../../shared/types';
import type { ToastLevel } from '../core/dialog-types.js';
import { api } from '../core/api.js';
import { dbg } from '../core/debug.js';

/**
 * 右下角 Toast 通知管理器。主进程的状态通知当前走 Windows 系统通知，
 * 这里只承担应用内操作反馈（复制、工作区删除结果等）。
 * 点击行为由调用方注入，组件本身不知道「选中会话」。
 */
class ToastManager {
  private container: HTMLElement | null = null;
  private readonly items = new Map<string, { el: HTMLElement; timer: number | null; remaining: number; startedAt: number }>();
  private static readonly AUTO_DISMISS_MS = 6000;
  private static readonly MAX_VISIBLE = 4;

  init(onSessionClick: (sessionId: string) => void): void {
    this.container = document.getElementById('toast-container');
    if (!this.container) {
      console.warn('[toast] #toast-container 不存在，toast 将不会显示');
      return;
    }
    dbg('toast', '初始化完成，已订阅 panel:notify');
    api().onNotify(n => {
      const sid = n.sessionId;
      this.show(n, sid ? () => onSessionClick(sid) : undefined);
    });
  }

  show(n: NotificationPayload, onClick?: () => void): void {
    if (!this.container) this.container = document.getElementById('toast-container');
    if (!this.container) return;
    if (this.items.has(n.id)) return;        // 主进程 id 去重
    if (this.items.size >= ToastManager.MAX_VISIBLE) {
      const oldestId = this.items.keys().next().value;
      if (oldestId) this.dismiss(oldestId, /*immediate*/ true);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${n.level}`;
    if (n.sessionId) el.dataset.session = n.sessionId;

    const title = document.createElement('div');
    title.className = 'toast-title';
    title.textContent = n.title;

    const body = document.createElement('div');
    body.className = 'toast-body';
    body.textContent = n.body;

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.type = 'button';
    close.setAttribute('aria-label', '关闭通知');
    close.textContent = '×';
    close.addEventListener('click', e => { e.stopPropagation(); this.dismiss(n.id); });

    el.append(title, body, close);
    el.addEventListener('click', () => this.handleClick(n.id, onClick));
    el.addEventListener('mouseenter', () => this.pauseTimer(n.id));
    el.addEventListener('mouseleave', () => this.resumeTimer(n.id));

    this.container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));

    this.items.set(n.id, { el, timer: null, remaining: ToastManager.AUTO_DISMISS_MS, startedAt: Date.now() });
    this.startTimer(n.id);
  }

  private startTimer(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    item.startedAt = Date.now();
    item.timer = window.setTimeout(() => this.dismiss(id), item.remaining);
  }

  private pauseTimer(id: string): void {
    const item = this.items.get(id);
    if (!item || item.timer === null) return;
    item.remaining = Math.max(0, item.remaining - (Date.now() - item.startedAt));
    clearTimeout(item.timer);
    item.timer = null;
  }

  private resumeTimer(id: string): void {
    const item = this.items.get(id);
    if (!item || item.timer !== null) return;
    this.startTimer(id);
  }

  private dismiss(id: string, immediate = false): void {
    const item = this.items.get(id);
    if (!item) return;
    if (item.timer !== null) { clearTimeout(item.timer); item.timer = null; }
    const finalize = (): void => {
      item.el.remove();
      this.items.delete(id);
    };
    if (immediate) { finalize(); return; }
    item.el.classList.add('removing');
    item.el.classList.remove('show');
    item.el.addEventListener('transitionend', finalize, { once: true });
    setTimeout(finalize, 400);
  }

  private handleClick(toastId: string, onClick?: () => void): void {
    this.dismiss(toastId);
    onClick?.();
  }
}

const manager = new ToastManager();

/** 应用内操作反馈：默认点击只关闭；传入 onClick 时关闭后再执行 */
export function toast(text: string, level: ToastLevel = 'success', onClick?: () => void): void {
  dbg('ui', text);
  manager.show({ id: `notice-${Date.now()}-${Math.random()}`, sessionId: '', level, title: text, body: '', createdAt: Date.now() }, onClick);
}

/**
 * 订阅主进程的 panel:notify，把会话通知显示为 Toast，点击时调用 onSessionClick。
 * 通知已改为 Windows 系统通知，入口暂不调用。
 */
export function initNotifyToasts(onSessionClick: (sessionId: string) => void): void {
  manager.init(onSessionClick);
}
