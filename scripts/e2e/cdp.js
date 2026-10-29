// @ts-check
'use strict';
/**
 * 极简 CDP 客户端：基于 Node 内置的全局 WebSocket（Node 22.4 起稳定），零依赖。
 * 提供页面目标发现、请求与事件、evaluate、按键与文本输入、页面截图、重载、Browser.close。
 * 截图只走 Page.captureScreenshot，截的是测试窗口自己的页面内容，不做任何系统截屏。
 */
const http = require('http');

/** @param {number} port @param {string} p @param {number} [timeout] @returns {Promise<any>} */
function getJson(port, p, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`请求 ${p} 超时`)));
    req.on('error', reject);
  });
}

function assertWebSocket() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(`当前 Node ${process.version} 没有全局 WebSocket，e2e 需要 Node >= 22.4`);
  }
}

/** 面板主页面目标：type 为 page 且 url 以 renderer/index.html 结尾，排除 devtools */
function isPanelPage(/** @type {any} */ t) {
  return t && t.type === 'page' && typeof t.url === 'string' && !t.url.startsWith('devtools://')
    && /renderer\/index\.html(?:[?#].*)?$/.test(t.url.replace(/\\/g, '/'));
}

/** @param {number} port */
async function findPageTarget(port) {
  /** @type {any[]} */
  const list = await getJson(port, '/json/list');
  return list.find(isPanelPage) ?? null;
}

class CdpSession {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, method: string, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    /** @type {Map<string, Set<(params: any) => void>>} */
    this.listeners = new Map();
    this.closed = false;
    ws.addEventListener('message', ev => this.onMessage(ev));
    ws.addEventListener('close', () => this.onClose());
  }

  /** @param {string} url @param {number} [timeout] @returns {Promise<CdpSession>} */
  static connect(url, timeout = 5000) {
    assertWebSocket();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { try { ws.close(); } catch { /* 忽略 */ } reject(new Error(`连接 ${url} 超时`)); }, timeout);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpSession(ws)); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`连接 ${url} 失败`)); }, { once: true });
    });
  }

  /** @param {MessageEvent} ev */
  onMessage(ev) {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method} 失败：${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === 'string') {
      for (const fn of this.listeners.get(msg.method) ?? []) {
        try { fn(msg.params ?? {}); } catch { /* 监听器异常不影响其他监听器 */ }
      }
    }
  }

  onClose() {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`${p.method} 未完成：连接已关闭`));
    }
    this.pending.clear();
  }

  /** @param {string} method @param {object} [params] @param {number} [timeout] @returns {Promise<any>} */
  send(method, params = {}, timeout = 15_000) {
    if (this.closed) return Promise.reject(new Error(`${method} 未发送：连接已关闭`));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeout}ms）`));
      }, timeout);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** @param {string} method @param {(params: any) => void} fn @returns {() => void} 注销函数 */
  on(method, fn) {
    const set = this.listeners.get(method) ?? new Set();
    set.add(fn);
    this.listeners.set(method, set);
    return () => { set.delete(fn); };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.close(); } catch { /* 忽略 */ }
  }
}

// ---- 按键 ----

/** @type {Record<string, { code: string, vk: number, text?: string }>} */
const NAMED_KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  Space: { code: 'Space', vk: 32, text: ' ' },
  F3: { code: 'F3', vk: 114 },
  Comma: { code: 'Comma', vk: 188, text: ',' },
  Slash: { code: 'Slash', vk: 191, text: '/' },
};

const MODIFIER_BITS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };

/**
 * 把 'Control+Shift+K'、'Enter'、'y'、'Control+1' 这类组合解析成 Input.dispatchKeyEvent 的参数。
 * 带 Ctrl / Alt / Meta 时不附带 text，避免在输入框里插入字符。
 * @param {string} combo
 */
function keyEventParams(combo) {
  const parts = combo.split('+').filter(Boolean);
  const keyName = parts.pop();
  if (!keyName) throw new Error(`无效按键：${combo}`);
  let modifiers = 0;
  for (const m of parts) {
    const bit = /** @type {Record<string, number>} */ (MODIFIER_BITS)[m];
    if (!bit) throw new Error(`未知修饰键：${m}（${combo}）`);
    modifiers |= bit;
  }
  const shift = (modifiers & 8) !== 0;
  const command = (modifiers & (1 | 2 | 4)) !== 0;
  /** @type {{ key: string, code: string, windowsVirtualKeyCode: number, text?: string }} */
  let def;
  const named = NAMED_KEYS[keyName];
  if (named) {
    def = { key: keyName === 'Space' ? ' ' : keyName === 'Comma' ? ',' : keyName === 'Slash' ? '/' : keyName, code: named.code, windowsVirtualKeyCode: named.vk, text: named.text };
  } else if (/^[a-zA-Z]$/.test(keyName)) {
    const lower = keyName.toLowerCase();
    const ch = shift ? lower.toUpperCase() : lower;
    def = { key: ch, code: `Key${lower.toUpperCase()}`, windowsVirtualKeyCode: lower.toUpperCase().charCodeAt(0), text: ch };
  } else if (/^[0-9]$/.test(keyName)) {
    def = { key: keyName, code: `Digit${keyName}`, windowsVirtualKeyCode: keyName.charCodeAt(0), text: keyName };
  } else {
    throw new Error(`不支持的按键：${keyName}（${combo}）`);
  }
  if (command) delete def.text;
  return { ...def, modifiers };
}

// ---- 页面 ----

/**
 * 面板页面：封装 evaluate、按键、截图等，并收集控制台输出与未捕获异常。
 */
class PanelPage {
  /** @param {CdpSession} session @param {any} target */
  constructor(session, target) {
    this.session = session;
    this.target = target;
    /** @type {string[]} */
    this.console = [];
    /** @type {string[]} */
    this.exceptions = [];
    session.on('Runtime.consoleAPICalled', p => {
      const text = (p.args ?? []).map((/** @type {any} */ a) =>
        a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type)).join(' ');
      this.pushConsole(`[console.${p.type}] ${text}`);
    });
    session.on('Log.entryAdded', p => {
      const e = p.entry ?? {};
      this.pushConsole(`[log.${e.level}] ${e.text ?? ''}${e.url ? ` (${e.url})` : ''}`);
    });
    session.on('Runtime.exceptionThrown', p => {
      const d = p.exceptionDetails ?? {};
      const text = d.exception?.description ?? d.text ?? JSON.stringify(d);
      this.exceptions.push(text);
      this.pushConsole(`[exception] ${text}`);
    });
  }

  /** @param {string} line */
  pushConsole(line) {
    this.console.push(`${new Date().toISOString()} ${line}`);
    if (this.console.length > 5000) this.console.splice(0, this.console.length - 5000);
  }

  /** @param {number} port @param {number} [timeout] */
  static async connect(port, timeout = 5000) {
    const target = await findPageTarget(port);
    if (!target) throw new Error(`端口 ${port} 上找不到面板页面`);
    const session = await CdpSession.connect(target.webSocketDebuggerUrl, timeout);
    const page = new PanelPage(session, target);
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await session.send('Log.enable');
    // 窗口不在前台时页面仍按「有焦点」处理，focus / blur 相关逻辑与人工操作一致
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    return page;
  }

  /**
   * 在页面中求值，返回可序列化的结果；表达式抛错时抛出带描述的错误。
   * @param {string} expression
   * @returns {Promise<any>}
   */
  async evaluate(expression) {
    const r = await this.session.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`页面求值异常：${d.exception?.description ?? d.text}\n表达式：${expression.slice(0, 300)}`);
    }
    return r.result?.value;
  }

  /** 按下并松开一个组合键，例如 'Control+Shift+K' @param {string} combo */
  async press(combo) {
    const p = keyEventParams(combo);
    await this.session.send('Input.dispatchKeyEvent', { type: p.text ? 'keyDown' : 'rawKeyDown', ...p });
    const { text: _text, ...up } = p;
    await this.session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...up });
  }

  /** 向当前焦点元素插入文本（等同输入法上屏） @param {string} text */
  async insertText(text) {
    await this.session.send('Input.insertText', { text });
  }

  /** 页面截图（PNG），只截本页面 @returns {Promise<Buffer>} */
  async screenshot() {
    const r = await this.session.send('Page.captureScreenshot', { format: 'png' }, 20_000);
    return Buffer.from(r.data, 'base64');
  }

  async reload() {
    await this.session.send('Page.reload', { ignoreCache: true });
  }

  /**
   * 模拟页面视口尺寸（只影响排版，不改真实窗口），不传宽度则恢复按窗口实际尺寸排版。
   * @param {number} [width] @param {number} [height]
   */
  async viewport(width, height) {
    if (!width) {
      await this.session.send('Emulation.clearDeviceMetricsOverride');
      return;
    }
    const h = height ?? await this.evaluate('window.innerHeight');
    await this.session.send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 0, mobile: false });
  }

  close() {
    this.session.close();
  }
}

/**
 * 通过浏览器级会话发送 Browser.close，让应用走正常退出流程（before-quit）。
 * @param {number} port
 */
async function browserClose(port) {
  const ver = await getJson(port, '/json/version');
  const browser = await CdpSession.connect(ver.webSocketDebuggerUrl);
  try {
    await browser.send('Browser.close', {}, 5000);
  } catch {
    // 进程退出时连接随之断开，响应可能来不及返回
  } finally {
    browser.close();
  }
}

module.exports = { getJson, assertWebSocket, isPanelPage, findPageTarget, CdpSession, PanelPage, keyEventParams, browserClose };
