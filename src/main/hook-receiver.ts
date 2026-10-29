import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { randomBytes, timingSafeEqual } from 'crypto';
import { parseHookPayload } from '../shared/status-engine';
import { panelHome } from './panel-home';
import { HookMessage, PanelEvent, RawHookPayload } from '../shared/types';
import { log } from './logger';

/**
 * 从 hook payload 提取 Claude 自管 sessionId：优先 session_id，
 * 缺失时用 transcript_path 文件名兜底（~/.claude/projects/<proj>/<claudeId>.jsonl）。
 */
export function extractClaudeSessionId(raw: RawHookPayload | undefined): string | undefined {
  if (!raw) return undefined;
  if (typeof raw.session_id === 'string' && raw.session_id) return raw.session_id;
  if (typeof raw.transcript_path === 'string') {
    const m = raw.transcript_path.match(/([^/\\]+)\.jsonl$/);
    if (m) return m[1];
  }
  return undefined;
}

/** 从 hook payload 提取对话记录路径（transcript_path，必须是 .jsonl 文件）；取不到返回 undefined */
export function extractTranscriptPath(raw: RawHookPayload | undefined): string | undefined {
  const p = raw?.transcript_path;
  return typeof p === 'string' && /\.jsonl$/i.test(p) ? p : undefined;
}

/** 上报请求头里的令牌字段，令牌每次启动随机生成，写在 <panelHome>/receiver.token */
export const HOOK_TOKEN_HEADER = 'x-nexus-token';
/** 单次上报的请求体上限：hook payload 正常只有几 KB，超过即拒绝，防止被撑爆内存 */
export const HOOK_MAX_BODY_BYTES = 1024 * 1024;
/** 前置处理最多等这么久：hook-client 自己 3 秒超时，留出余量 */
const PREFLIGHT_MAX_MS = 2500;

/**
 * localhost HTTP 服务：接收 hooks 上报，解析后按回调分发。
 * 只接受带正确令牌、Content-Type 为 JSON 的 POST /hook：
 * 令牌挡住本机其他程序伪造状态事件，JSON 类型要求挡住浏览器网页发来的跨域简单请求。
 */
export class HookReceiver {
  private server?: http.Server;
  private readonly token = randomBytes(24).toString('hex');

  constructor(
    private readonly onMessage: (msg: HookMessage) => void,
    /** 回应前的处理：返回 Promise 时等它完成（最多 PREFLIGHT_MAX_MS）再回应 */
    private readonly preflight?: (sessionId: string, raw: RawHookPayload | undefined) => Promise<void> | void,
  ) {}

  private runPreflight(sessionId: string, raw: RawHookPayload | undefined): Promise<void> | undefined {
    if (!this.preflight) return undefined;
    let p: Promise<void> | void;
    try {
      p = this.preflight(sessionId, raw);
    } catch (err) {
      log('hook', `前置处理异常：${String(err)}`);
      return undefined;
    }
    if (!p) return undefined;
    return new Promise<void>(resolve => {
      const t = setTimeout(resolve, PREFLIGHT_MAX_MS);
      const done = () => { clearTimeout(t); resolve(); };
      (p as Promise<void>).then(done, err => { log('hook', `前置处理失败：${String(err)}`); done(); });
    });
  }

  async start(): Promise<number> {
    return new Promise(resolve => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address() as net.AddressInfo;
        fs.mkdirSync(panelHome(), { recursive: true });
        // 先写令牌再写端口：hook-client 读到新端口时令牌一定已是本次的
        fs.writeFileSync(path.join(panelHome(), 'receiver.token'), this.token, { mode: 0o600 });
        fs.writeFileSync(path.join(panelHome(), 'receiver.port'), String(addr.port));
        log('hook', `接收服务已启动 127.0.0.1:${addr.port}（端口文件 ${path.join(panelHome(), 'receiver.port')}）`);
        resolve(addr.port);
      });
    });
  }

  private reject(req: http.IncomingMessage, res: http.ServerResponse, code: number, why: string): void {
    log('hook', `拒绝请求 ${req.method} ${req.url}（${why}）→ ${code}`);
    res.statusCode = code;
    res.end();
  }

  private tokenOk(req: http.IncomingMessage): boolean {
    const got = req.headers[HOOK_TOKEN_HEADER];
    if (typeof got !== 'string') return false;
    const a = Buffer.from(got);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/hook') {
      this.reject(req, res, 404, '只接受 POST /hook');
      return;
    }
    if (!this.tokenOk(req)) {
      this.reject(req, res, 401, '令牌缺失或不匹配');
      req.resume();
      return;
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      this.reject(req, res, 415, 'Content-Type 不是 application/json');
      req.resume();
      return;
    }
    if (Number(req.headers['content-length'] ?? 0) > HOOK_MAX_BODY_BYTES) {
      this.reject(req, res, 413, '请求体超过上限');
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > HOOK_MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        this.reject(req, res, 413, '请求体超过上限');
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        const msg = JSON.parse(body) as { sessionId?: string; payload?: unknown };
        const raw = msg.payload as RawHookPayload | undefined;
        // 子代理事件：原样透传（不归一化、不进入状态机），由 SessionManager 派给 SubagentTracker
        if (raw?.hook_event_name === 'SubagentStart') {
          this.emit(msg.sessionId, raw, 'subagent_start');
          res.statusCode = 200; res.end();
          return;
        }
        if (raw?.hook_event_name === 'SubagentStop') {
          this.emit(msg.sessionId, raw, 'subagent_stop');
          res.statusCode = 200; res.end();
          return;
        }
        const event = parseHookPayload(raw);
        if (msg.sessionId && event) {
          log('hook', `会话 ${msg.sessionId.slice(0, 8)} 上报 ${raw?.hook_event_name ?? '?'} → 事件 ${event.type}`);
          this.onMessage(this.message(msg.sessionId, event, raw));
        } else {
          log('hook', `丢弃无法解析的上报：sessionId=${msg.sessionId ?? '缺失'} event=${event ? 'ok' : 'null'} body=${body.slice(0, 200)}`);
        }
        // 前置处理（如工具执行前的文件快照）完成后才回应：hook-client 等到回应才退出，工具在此之前不会执行
        const pending = msg.sessionId ? this.runPreflight(msg.sessionId, raw) : undefined;
        if (pending) {
          void pending.then(() => { res.statusCode = 200; res.end(); });
          return;
        }
        res.statusCode = 200;
        res.end();
      } catch (err) {
        log('hook', `JSON 解析失败 → 400：${String(err)} body=${body.slice(0, 200)}`);
        res.statusCode = 400;
        res.end();
      }
    });
  }

  private emit(sessionId: string | undefined, raw: RawHookPayload, type: 'subagent_start' | 'subagent_stop'): void {
    if (!sessionId) {
      log('hook', `丢弃子代理事件：缺失 sessionId（${type}）`);
      return;
    }
    log('hook', `会话 ${sessionId.slice(0, 8)} 上报 ${type}（agent=${raw.agent_id ?? '?'}）`);
    this.onMessage(this.message(sessionId, { type, raw }, raw));
  }

  /** 组装分发消息：能取到 Claude sessionId、对话记录路径才带上对应字段 */
  private message(sessionId: string, event: PanelEvent, raw: RawHookPayload | undefined): HookMessage {
    const msg: HookMessage = { sessionId, event };
    const claudeSessionId = extractClaudeSessionId(raw);
    if (claudeSessionId) msg.claudeSessionId = claudeSessionId;
    const transcriptPath = extractTranscriptPath(raw);
    if (transcriptPath) msg.transcriptPath = transcriptPath;
    return msg;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>(resolve => this.server!.close(() => resolve()));
  }
}
