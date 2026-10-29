import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { pathToFileURL } from 'url';
import { log } from './logger';

/**
 * 主窗口只能显示面板自己的页面：
 * - 页面内点到的外部链接（如验证输出里的超链接）一律不在窗口内打开，http/https 交给系统浏览器；
 * - 任何 IPC 调用都要求来自面板页面本身，即使窗口被意外导航到外部网页，那个网页也调不动 panelApi。
 */

/** 面板页面所在目录的 file:// 前缀（带末尾斜杠），比较时不区分大小写（Windows 路径） */
export function appUrlPrefix(rendererDir: string): string {
  const href = pathToFileURL(rendererDir).href;
  return (href.endsWith('/') ? href : `${href}/`).toLowerCase();
}

/** url 是否为面板自己的页面（file:// 且位于渲染层目录内） */
export function isAppUrl(url: string, prefix: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'file:') return false;
  // 先规范化（去掉 ..、统一编码）再比较前缀，防止 file:///…/renderer/../../x 越出目录
  return u.href.toLowerCase().startsWith(prefix);
}

/** 可以交给系统浏览器打开的链接：只认 http/https */
export function isExternalWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** 拦截窗口内的导航与新窗口：面板页面之外的地址都不加载，网页链接改用系统浏览器打开 */
export function guardNavigation(wc: WebContents, prefix: string, openExternal: (url: string) => Promise<void>): void {
  const divert = (url: string, how: string): void => {
    log('security', `拦截${how}：${url.slice(0, 200)}`);
    if (isExternalWebUrl(url)) {
      void openExternal(url).catch(err => log('security', `外部打开失败：${String(err)}`));
    }
  };
  wc.on('will-navigate', (e, url) => {
    if (isAppUrl(url, prefix)) return;
    e.preventDefault();
    divert(url, '窗口内导航');
  });
  wc.on('will-redirect', (e, url) => {
    if (isAppUrl(url, prefix)) return;
    e.preventDefault();
    divert(url, '重定向');
  });
  wc.setWindowOpenHandler(({ url }) => {
    divert(url, '新窗口');
    return { action: 'deny' };
  });
  wc.on('will-attach-webview', e => {
    e.preventDefault();
    log('security', '拦截 webview 挂载');
  });
}

/** 调用方是否为面板页面的主框架；框架已销毁或地址不对一律视为不可信 */
export function isTrustedSender(e: Pick<IpcMainInvokeEvent, 'senderFrame'>, prefix: string): boolean {
  const frame = e.senderFrame;
  if (!frame || frame.parent) return false;
  return isAppUrl(frame.url, prefix);
}

let installed = false;

/**
 * 给之后注册的全部 ipcMain.handle 加上调用方校验：必须先于各模块注册 IPC 调用。
 * 校验失败时调用方收到错误，处理函数不执行。
 */
export function installIpcSenderGuard(prefix: string): void {
  if (installed) return;
  installed = true;
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = ((channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    handle(channel, (event, ...args) => {
      if (!isTrustedSender(event, prefix)) {
        log('security', `拒绝来自非面板页面的调用 ${channel}（${event.senderFrame?.url ?? '框架已销毁'}）`);
        throw new Error('拒绝来自非面板页面的调用');
      }
      return listener(event, ...args);
    });
  }) as typeof ipcMain.handle;
}
