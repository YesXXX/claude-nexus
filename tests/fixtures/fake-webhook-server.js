#!/usr/bin/env node
/**
 * 本地假群机器人：只监听 127.0.0.1，把收到的请求逐行写入 received.jsonl，供自测远程通知使用。
 *
 * 命令行：node tests/fixtures/fake-webhook-server.js --port 0 [--out <目录>] [--errcode 310000] [--hang]
 *   启动后打印一行 `fake-webhook listening <端口>`；--errcode 让响应带指定 errcode，--hang 收到请求后不回应。
 * 模块：const { startFakeWebhook } = require('./fake-webhook-server.js')，返回端口、已收请求与关闭函数。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

/**
 * @param {{ port?: number, out?: string, errcode?: number, hang?: boolean, status?: number }} opts
 * @returns {Promise<{ port: number, url: string, requests: Array<object>, set(o: object): void, close(): Promise<void> }>}
 */
function startFakeWebhook(opts = {}) {
  const mode = { errcode: opts.errcode ?? 0, hang: !!opts.hang, status: opts.status ?? 200 };
  const requests = [];
  const hanging = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(body); } catch { /* 原样记录 */ }
      const entry = {
        at: Date.now(), method: req.method, url: req.url, host: req.headers.host ?? '',
        remote: req.socket.remoteAddress ?? '', contentType: req.headers['content-type'] ?? '', body: json ?? body,
      };
      requests.push(entry);
      if (opts.out) fs.appendFileSync(path.join(opts.out, 'received.jsonl'), JSON.stringify(entry) + '\n');
      if (mode.hang) { hanging.add(res); return; }
      res.writeHead(mode.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mode.errcode === 0
        ? { errcode: 0, errmsg: 'ok', code: 0, msg: 'success' }
        : { errcode: mode.errcode, errmsg: `fake error ${mode.errcode}`, code: mode.errcode, msg: `fake error ${mode.errcode}` }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        requests,
        set(o) { Object.assign(mode, o); },
        close() {
          for (const r of hanging) r.destroy();
          hanging.clear();
          server.closeAllConnections?.();
          return new Promise(done => server.close(() => done()));
        },
      });
    });
  });
}

module.exports = { startFakeWebhook };

if (require.main === module) {
  const args = process.argv.slice(2);
  const val = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const out = val('--out') ?? __dirname;
  startFakeWebhook({
    port: Number(val('--port') ?? 0), out,
    errcode: val('--errcode') ? Number(val('--errcode')) : 0, hang: args.includes('--hang'),
  }).then(s => {
    console.log(`fake-webhook listening ${s.port}`);
    console.log(`requests -> ${path.join(out, 'received.jsonl')}`);
  }, err => { console.error(err); process.exit(1); });
}
