import type { NotificationPayload } from '../shared/types';
import type { WebhookConfig, WebhookSendResult, WebhookTarget } from '../shared/webhook-types';
import { buildMessage, buildRequest, isLoopbackUrl, judgeResponse, maskWebhookUrl, testMessage, type WebhookMessage } from './webhook-format';

/**
 * webhook 投递：订阅通知服务的结构化通知，按规则决定是否推送到群机器人。
 * 判定顺序：总开关 → 事件勾选 → 退出中 → 离开判定 → 静默时段 → 去重 → 节流 → 每目标限流 → 熔断 → 投递。
 * 每一处跳过都写一行 [webhook] 日志并带原因；日志里的地址一律脱敏。失败不自动重试。
 */

/** 传输层：主进程注入 Electron net.fetch，单测注入 Node fetch；超时由实现方按 timeoutMs 中止 */
export type WebhookTransport = (url: string, body: string, timeoutMs: number) => Promise<{ status: number; text: string }>;

export interface WebhookNotifierDeps {
  config(): WebhookConfig;
  transport: WebhookTransport;
  now?: () => number;
  /** 用户是否离开电脑：空闲不少于 minutes 分钟或已锁屏，且面板窗口不在前台 */
  isAway(minutes: number): boolean;
  isQuitting(): boolean;
  /** 只允许回环目标（自测隔离实例） */
  loopbackOnly?: boolean;
  timeoutMs?: number;
  hostname?: string;
  log(msg: string): void;
}

const DEDUPE_MS = 10 * 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 15;
const BREAK_AFTER = 5;
const BREAK_MS = 10 * 60_000;

interface TargetState {
  sent: number[];
  dropped: number;
  failures: number;
  openUntil: number;
  /** 同一目标的投递串行执行，熔断与限速按前一条的结果判定 */
  queue: Promise<void>;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** 静默时段判定，支持跨零点（如 22:00–08:00）；开始等于结束视为不静默 */
export function inQuiet(quiet: WebhookConfig['quiet'], ts: number): boolean {
  if (!quiet.enabled) return false;
  const d = new Date(ts);
  const cur = d.getHours() * 60 + d.getMinutes();
  const s = minutesOf(quiet.start);
  const e = minutesOf(quiet.end);
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

export class WebhookNotifier {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly dedupe = new Map<string, number>();
  private readonly lastBySession = new Map<string, number>();
  private readonly state = new Map<string, TargetState>();
  private readonly results = new Map<string, WebhookSendResult>();

  constructor(private readonly deps: WebhookNotifierDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 8000;
  }

  lastResults(): Record<string, WebhookSendResult> {
    return Object.fromEntries(this.results);
  }

  /** 处于熔断中的目标及恢复时间 */
  circuitOpenUntil(): Record<string, number> {
    const now = this.now();
    const out: Record<string, number> = {};
    for (const [id, s] of this.state) if (s.openUntil > now) out[id] = s.openUntil;
    return out;
  }

  /** 目标被删除或修改后清掉它的状态 */
  forget(keepIds: readonly string[]): void {
    for (const id of [...this.state.keys()]) if (!keepIds.includes(id)) this.state.delete(id);
    for (const id of [...this.results.keys()]) if (!keepIds.includes(id)) this.results.delete(id);
  }

  private skip(reason: string, n: NotificationPayload, extra = ''): void {
    this.deps.log(`skip ${reason}：${n.kind ?? '-'} 会话 ${n.sessionId?.slice(0, 8) ?? '全局'}${extra ? `，${extra}` : ''}`);
  }

  private st(id: string): TargetState {
    let s = this.state.get(id);
    if (!s) { s = { sent: [], dropped: 0, failures: 0, openUntil: 0, queue: Promise.resolve() }; this.state.set(id, s); }
    return s;
  }

  /** 通知入口；返回投递完成的 Promise，供测试等待 */
  async onNotification(n: NotificationPayload): Promise<void> {
    const cfg = this.deps.config();
    if (!cfg.enabled) return;
    if (!n.kind) return;
    if (!cfg.events[n.kind]) { this.skip('event-off', n); return; }
    if (this.deps.isQuitting()) { this.skip('quitting', n); return; }
    const targets = cfg.targets.filter(t => t.enabled && t.url);
    if (targets.length === 0) { this.skip('no-target', n); return; }
    if (cfg.when === 'away' && !this.deps.isAway(cfg.awayMinutes)) { this.skip('present', n); return; }
    const now = this.now();
    if (inQuiet(cfg.quiet, now)) { this.skip('quiet', n, `${cfg.quiet.start}–${cfg.quiet.end}`); return; }

    for (const [k, at] of this.dedupe) if (now - at >= DEDUPE_MS) this.dedupe.delete(k);
    const key = `${n.sessionId ?? '-'}|${n.kind}|${n.meta?.summary ?? n.meta?.status ?? n.title}`;
    if (this.dedupe.has(key)) { this.skip('duplicate', n); return; }
    const exempt = n.kind === 'error' || n.kind === 'lost';
    const sid = n.sessionId ?? '-';
    const last = this.lastBySession.get(sid);
    if (!exempt && last !== undefined && now - last < cfg.throttleSec * 1000) {
      this.skip('throttle', n, `距上次 ${Math.round((now - last) / 1000)} 秒`);
      return;
    }
    this.dedupe.set(key, now);
    this.lastBySession.set(sid, now);

    await Promise.all(targets.map(t => this.deliverRuled(t, n, cfg, now)));
  }

  /** 排进目标自己的队列；前一条未完成时等待，避免并发请求同时越过熔断与限速判断 */
  private deliverRuled(t: WebhookTarget, n: NotificationPayload, cfg: WebhookConfig, now: number): Promise<void> {
    const s = this.st(t.id);
    const run = s.queue.then(() => this.deliverOne(t, s, n, cfg, now))
      .catch(err => this.deps.log(`投递异常：目标「${t.name}」${String(err)}`));
    s.queue = run;
    return run;
  }

  private async deliverOne(t: WebhookTarget, s: TargetState, n: NotificationPayload, cfg: WebhookConfig, now: number): Promise<void> {
    if (this.deps.isQuitting()) { this.skip('quitting', n); return; }
    s.sent = s.sent.filter(at => now - at < RATE_WINDOW_MS);
    if (s.sent.length >= RATE_MAX) {
      s.dropped++;
      this.skip('rate-limit', n, `目标「${t.name}」本分钟已发 ${s.sent.length} 条，累计丢弃 ${s.dropped} 条`);
      return;
    }
    if (s.openUntil > now) {
      this.skip('circuit-open', n, `目标「${t.name}」熔断至 ${new Date(s.openUntil).toLocaleTimeString()}`);
      return;
    }
    s.sent.push(now);
    const dropped = s.dropped;
    s.dropped = 0;
    const msg = buildMessage(n, { includeSummary: cfg.includeSummary, now, dropped });
    const r = await this.send(t, msg, `${n.kind} 会话 ${n.sessionId?.slice(0, 8) ?? '全局'}`);
    if (r.ok) {
      s.failures = 0;
    } else if (++s.failures >= BREAK_AFTER) {
      s.openUntil = this.now() + BREAK_MS;
      s.failures = 0;
      this.deps.log(`目标「${t.name}」连续失败 ${BREAK_AFTER} 次，熔断 10 分钟`);
    }
  }

  /** 发送一条消息到一个目标；回环限制在这里统一把关，测试消息也不例外 */
  private async send(t: Pick<WebhookTarget, 'id' | 'name' | 'platform' | 'url' | 'secret'>, msg: WebhookMessage, what: string): Promise<WebhookSendResult> {
    const start = this.now();
    const masked = maskWebhookUrl(t.url);
    const done = (r: Omit<WebhookSendResult, 'targetId' | 'ms' | 'at'>): WebhookSendResult => {
      const res: WebhookSendResult = { targetId: t.id, ...r, ms: Math.max(0, this.now() - start), at: start };
      this.results.set(t.id, res);
      this.deps.log(`${res.ok ? '投递成功' : '投递失败'}：目标「${t.name}」${masked}，${what}，${res.ms}ms${res.error ? `，${res.error}` : ''}`);
      return res;
    };
    if (this.deps.loopbackOnly && !isLoopbackUrl(t.url)) {
      this.deps.log(`skip loopback only：目标「${t.name}」${masked} 不是回环地址，已拒绝`);
      return done({ ok: false, error: '自测模式只允许本机回环地址（loopback only）' });
    }
    let req;
    try { req = buildRequest(t, msg, start); } catch (err) { return done({ ok: false, error: `生成请求失败：${String(err)}` }); }
    try {
      const resp = await this.deps.transport(req.url, req.body, this.timeoutMs);
      const j = judgeResponse(t.platform, resp.status, resp.text);
      return done({ ok: j.ok, status: resp.status, ...(j.error ? { error: j.error } : {}) });
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const timeout = e?.name === 'AbortError' || e?.name === 'TimeoutError';
      return done({ ok: false, error: timeout ? `超时（${this.timeoutMs}ms 无响应）` : `请求失败：${e?.message ?? String(err)}` });
    }
  }

  /** 测试消息：绕过静默、节流、离开判定与熔断，逐个目标发送并返回结果 */
  async test(targets: WebhookTarget[]): Promise<WebhookSendResult[]> {
    const msg = testMessage(this.deps.hostname ?? '', this.now());
    const out: WebhookSendResult[] = [];
    for (const t of targets) out.push(await this.send(t, msg, '测试消息'));
    return out;
  }
}
