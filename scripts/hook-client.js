#!/usr/bin/env node
/**
 * Claude Code hooks 命令：stdin 读事件 payload，带上环境变量里的 sessionId，
 * POST 给面板 Hook Receiver。fire-and-forget：任何失败静默退出。
 * 不向 stdout 输出任何内容（SessionStart / UserPromptSubmit 的 stdout 会被 CLI 当作上下文），
 * 总以 0 退出；上报带超时，面板卡住时不拖住提交提示词。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const POST_TIMEOUT_MS = 3000;

function panelHome() {
  return process.env.CLAUDE_PANEL_HOME || path.join(os.homedir(), '.claude-session-panel');
}

/** 面板每次启动随机生成的上报令牌；与端口一样每次上报都现读，面板重启后认领的旧会话也能继续上报 */
function readToken() {
  return fs.readFileSync(path.join(panelHome(), 'receiver.token'), 'utf8').trim();
}

async function postEvent(payload) {
  const portFile = path.join(panelHome(), 'receiver.port');
  const port = fs.readFileSync(portFile, 'utf8').trim();
  const sessionId = process.env.CLAUDE_PANEL_SESSION_ID || 'unknown';
  await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nexus-token': readToken() },
    body: JSON.stringify({ sessionId, payload }),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
}

async function main() {
  let raw = '';
  await new Promise(resolve => {
    process.stdin.on('data', c => (raw += c));
    process.stdin.on('end', resolve);
  });
  try {
    await postEvent(raw ? JSON.parse(raw) : {});
  } catch {
    /* 面板未运行/重启中：放弃本次上报，不影响会话 */
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { postEvent, panelHome };
