import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { EventEmitter } from 'events';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const registered = new Map<string, Handler>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => { registered.set(channel, fn); } },
}));

import { ipcMain } from 'electron';
import { appUrlPrefix, guardNavigation, installIpcSenderGuard, isAppUrl, isExternalWebUrl, isTrustedSender } from '../src/main/window-guard';

const DIR = path.resolve('D:\\Program Files\\Claude Nexus\\resources\\app.asar\\dist\\web\\renderer');
const PREFIX = appUrlPrefix(DIR);
const PAGE = `${PREFIX}index.html`;

describe('isAppUrl', () => {
  it('渲染层目录内的 file:// 页面才算面板页面，大小写与带 hash 不影响', () => {
    expect(isAppUrl(PAGE, PREFIX)).toBe(true);
    expect(isAppUrl(PAGE.toUpperCase().replace('FILE:', 'file:'), PREFIX)).toBe(true);
    expect(isAppUrl(`${PAGE}#x`, PREFIX)).toBe(true);
  });

  it('外部网页、其他本地文件、越出目录的路径与非法地址都不算', () => {
    expect(isAppUrl('https://example.com/', PREFIX)).toBe(false);
    expect(isAppUrl('file:///C:/Windows/win.ini', PREFIX)).toBe(false);
    expect(isAppUrl(`${PREFIX}../../evil.html`, PREFIX)).toBe(false);
    expect(isAppUrl(`${PREFIX.slice(0, -1)}-evil/index.html`, PREFIX)).toBe(false);
    expect(isAppUrl('data:text/html,<p>x</p>', PREFIX)).toBe(false);
    expect(isAppUrl('not a url', PREFIX)).toBe(false);
  });
});

describe('isExternalWebUrl', () => {
  it('只认 http/https', () => {
    expect(isExternalWebUrl('https://example.com/x')).toBe(true);
    expect(isExternalWebUrl('HTTP://example.com')).toBe(true);
    expect(isExternalWebUrl('file:///C:/x')).toBe(false);
    expect(isExternalWebUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('isTrustedSender', () => {
  const ev = (url: string | null, parent: unknown = null) =>
    ({ senderFrame: url === null ? null : { url, parent } }) as unknown as Parameters<typeof isTrustedSender>[0];

  it('面板页面主框架可信；外部页面、子框架与已销毁的框架不可信', () => {
    expect(isTrustedSender(ev(PAGE), PREFIX)).toBe(true);
    expect(isTrustedSender(ev('https://evil.example/'), PREFIX)).toBe(false);
    expect(isTrustedSender(ev(PAGE, {}), PREFIX)).toBe(false);
    expect(isTrustedSender(ev(null), PREFIX)).toBe(false);
  });
});

describe('installIpcSenderGuard', () => {
  beforeEach(() => registered.clear());

  it('安装后注册的处理函数只在调用方可信时执行', async () => {
    installIpcSenderGuard(PREFIX);
    const fn = vi.fn((_e: unknown, x: unknown) => `ok:${String(x)}`);
    ipcMain.handle('panel:input', fn);
    const wrapped = registered.get('panel:input')!;
    expect(wrapped({ senderFrame: { url: PAGE, parent: null } }, 1)).toBe('ok:1');
    expect(() => wrapped({ senderFrame: { url: 'https://evil.example/', parent: null } }, 2)).toThrow('拒绝来自非面板页面的调用');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('guardNavigation', () => {
  function fakeWc() {
    const wc = new EventEmitter() as EventEmitter & { setWindowOpenHandler: (h: (d: { url: string }) => unknown) => void; openHandler?: (d: { url: string }) => unknown };
    wc.setWindowOpenHandler = h => { wc.openHandler = h; };
    return wc;
  }
  const navigate = (wc: EventEmitter, name: string, url: string): boolean => {
    let prevented = false;
    wc.emit(name, { preventDefault: () => { prevented = true; } }, url);
    return prevented;
  };

  it('面板页面放行；外部网页链接拦下并交给系统浏览器，其他地址只拦不开', async () => {
    const wc = fakeWc();
    const open = vi.fn(async () => undefined);
    guardNavigation(wc as never, PREFIX, open);
    expect(navigate(wc, 'will-navigate', PAGE)).toBe(false);
    expect(navigate(wc, 'will-navigate', 'https://example.com/docs')).toBe(true);
    expect(navigate(wc, 'will-redirect', 'file:///C:/Windows/win.ini')).toBe(true);
    expect(wc.openHandler!({ url: 'https://example.com/new' })).toEqual({ action: 'deny' });
    expect(wc.openHandler!({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    let webview = false;
    wc.emit('will-attach-webview', { preventDefault: () => { webview = true; } });
    expect(webview).toBe(true);
    expect(open.mock.calls).toEqual([['https://example.com/docs'], ['https://example.com/new']]);
  });
});
