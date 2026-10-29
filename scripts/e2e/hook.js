// @ts-check
'use strict';
/**
 * 模拟 Claude 的 hook 事件：读取 <home>/receiver.port 与 receiver.token，向 127.0.0.1:<port>/hook POST {sessionId, payload}。
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

/** @param {string} home @returns {number | null} */
function readReceiverPort(home) {
  try {
    const n = Number(fs.readFileSync(path.join(home, 'receiver.port'), 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} home 面板数据目录
 * @param {string} sessionId
 * @param {object} payload Claude hook 的原始载荷，例如 { hook_event_name: 'Stop' }
 * @param {{ token?: string | null, contentType?: string }} [opts] 覆盖令牌（null = 不带）或 Content-Type，用于验证拒绝路径
 * @returns {Promise<number>} HTTP 状态码
 */
function postHook(home, sessionId, payload, opts = {}) {
  const port = readReceiverPort(home);
  if (!port) return Promise.reject(new Error(`读取 ${path.join(home, 'receiver.port')} 失败`));
  let token = opts.token;
  if (token === undefined) {
    try { token = fs.readFileSync(path.join(home, 'receiver.token'), 'utf8').trim(); } catch { token = null; }
  }
  const body = JSON.stringify({ sessionId, payload });
  /** @type {Record<string, string | number>} */
  const headers = { 'Content-Type': opts.contentType ?? 'application/json', 'Content-Length': Buffer.byteLength(body) };
  if (token) headers['x-nexus-token'] = token;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/hook', method: 'POST', timeout: 5000, headers,
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('timeout', () => req.destroy(new Error('POST /hook 超时')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { readReceiverPort, postHook };
