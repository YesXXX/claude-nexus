import { el } from '../../core/dom.js';
import { on } from '../../core/events.js';
import { renderEach, settingsSections } from '../../core/registry.js';

/**
 * 设置页：覆盖在工作区之上的整页视图，左侧为分节导航，右侧按注册顺序列出各分节。
 * 每次打开都重新调用各分节的 render，关闭时清空内容。
 * 选中会话、回到首页（selection-changed）、点「返回」或按 Esc 时关闭；
 * 打开期间拦截不带修饰键的单键热键（Y/N/A、J/K），避免误操作被设置页挡住的会话。
 */

let page: HTMLElement | null = null;
let nav: HTMLElement;
let content: HTMLElement;
let rail: HTMLButtonElement | null = null;
let prevFocus: HTMLElement | null = null;
let tailSizer: ResizeObserver | null = null;
let lastSec: HTMLElement | null = null;

export function isSettingsOpen(): boolean {
  return !!page && !page.hidden;
}

export function initSettingsPage(railButton: HTMLButtonElement | null): void {
  rail = railButton;
  page = el('div', 'settings-page');
  page.id = 'settings-page';
  page.hidden = true;
  page.tabIndex = -1;
  page.setAttribute('role', 'region');
  page.setAttribute('aria-label', '设置');

  const top = el('header', 'set-top');
  const back = el('button', 'btn sm set-back', '‹ 返回');
  back.type = 'button';
  back.id = 'settings-back';
  back.addEventListener('click', () => closeSettings());
  top.append(back, el('h2', 'set-title', '设置'), el('span', 'sp'), el('span', 'set-hint', '修改即时生效'));

  const body = el('div', 'set-body');
  nav = el('nav', 'set-nav');
  nav.id = 'settings-nav';
  nav.setAttribute('aria-label', '设置分节');
  content = el('div', 'set-content');
  content.id = 'settings-content';
  content.addEventListener('scroll', syncNav, { passive: true });
  body.append(nav, content);
  page.append(top, body);
  document.getElementById('app')?.appendChild(page);
  tailSizer = new ResizeObserver(sizeTail);
  tailSizer.observe(content);

  on('selection-changed', () => closeSettings());
  // window 捕获阶段先于全局热键分发注册，因此能先看到按键
  window.addEventListener('keydown', e => {
    if (!isSettingsOpen()) return;
    if (document.querySelector('.modal-backdrop:not([hidden])')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeSettings();
      return;
    }
    // 单键热键作用于背后的会话，设置页打开时一律不分发；输入框里的正常输入不受影响
    if (!e.ctrlKey && !e.altKey && !e.metaKey) e.stopImmediatePropagation();
  }, true);
}

export function openSettings(anchor?: string): void {
  if (!page) return;
  if (!isSettingsOpen()) {
    prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    build();
    page.hidden = false;
    rail?.classList.add('on');
    document.getElementById('app')?.classList.add('settings-open');
    sizeTail();
  }
  const target = anchor ? document.getElementById(`settings-sec-${anchor}`) : null;
  if (target) {
    content.scrollTop = target.offsetTop;
  } else {
    content.scrollTop = 0;
  }
  syncNav();
  // 焦点放在页面本身：移出终端与输入框，Tab 从返回按钮开始，又不会在按钮上显示焦点框
  page.focus({ preventScroll: true });
}

export function closeSettings(): void {
  if (!page || page.hidden) return;
  page.hidden = true;
  rail?.classList.remove('on');
  document.getElementById('app')?.classList.remove('settings-open');
  nav.replaceChildren();
  content.replaceChildren();
  if (lastSec) tailSizer?.unobserve(lastSec);
  lastSec = null;
  if (prevFocus && prevFocus.isConnected) prevFocus.focus();
  prevFocus = null;
}

export function toggleSettings(): void {
  if (isSettingsOpen()) closeSettings();
  else openSettings();
}

/** 分节 id 中的点换成短横线作为锚点，如 resume.settings → settings-sec-resume-settings */
function anchorOf(id: string): string {
  return id.replace(/\./g, '-');
}

function build(): void {
  nav.replaceChildren();
  content.replaceChildren();
  const secs = settingsSections();
  const built = renderEach(secs, undefined, sec => {
    const body = sec.render();
    return body ? { sec, body } : null;
  });
  for (const { sec, body } of built) {
    const key = anchorOf(sec.id);
    const box = el('section', 'set-sec');
    box.id = `settings-sec-${key}`;
    box.dataset.key = key;
    box.appendChild(el('h3', 'set-sec-title', sec.title));
    body.classList.add('set-sec-body');
    box.appendChild(body);
    content.appendChild(box);

    const item = el('button', 'set-nav-i', sec.title);
    item.type = 'button';
    item.dataset.key = key;
    item.addEventListener('click', () => {
      content.scrollTo({ top: box.offsetTop, behavior: 'smooth' });
      markNav(key);
    });
    nav.appendChild(item);
    lastSec = box;
  }
  // 末尾留白，最后一节也能滚到顶部与导航对应；高度随内容区与最后一节的尺寸调整
  content.appendChild(el('div', 'set-tail'));
  if (lastSec) tailSizer?.observe(lastSec);
}

/** 留白高度 = 内容区可视高度 - 最后一节高度，刚好让最后一节能滚到顶部 */
function sizeTail(): void {
  const tail = content.querySelector<HTMLElement>('.set-tail');
  if (!tail || !lastSec) return;
  tail.style.height = `${Math.max(0, content.clientHeight - lastSec.offsetHeight)}px`;
}

/** 导航高亮跟随滚动：取顶部已越过阅读线的最后一节 */
function syncNav(): void {
  const line = content.scrollTop + 24;
  let cur: string | undefined;
  for (const box of content.querySelectorAll<HTMLElement>('.set-sec')) {
    if (box.offsetTop <= line) cur = box.dataset.key;
  }
  cur ??= content.querySelector<HTMLElement>('.set-sec')?.dataset.key;
  if (cur) markNav(cur);
}

function markNav(key: string): void {
  for (const b of nav.querySelectorAll<HTMLElement>('.set-nav-i')) b.classList.toggle('on', b.dataset.key === key);
}
