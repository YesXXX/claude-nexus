import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebhookNotifier, inQuiet, type WebhookTransport } from '../src/main/webhook-notifier';
import { defaultWebhookConfig } from '../src/main/webhook-config';
import type { NotificationPayload, NotifyKind } from '../src/shared/types';
import type { WebhookConfig, WebhookTarget } from '../src/shared/webhook-types';
import { startFakeWebhook } from './fixtures/fake-webhook-server.js';

type Fake = Awaited<ReturnType<typeof startFakeWebhook>>;

/** 传输层用 Node fetch，指向进程内的假机器人 */
const nodeTransport: WebhookTransport = async (url, body, timeoutMs) => {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: r.status, text: await r.text() };
};

const T0 = new Date(2026, 9, 17, 14, 0, 0).getTime();

describe('webhook 投递规则', () => {
  let fake: Fake;
  const hosts: string[] = [];
  let now = T0;
  let away = true;
  let quitting = false;
  let cfg: WebhookConfig;
  let logs: string[];

  beforeAll(async () => { fake = await startFakeWebhook(); });
  afterAll(async () => {
    for (const r of fake.requests) hosts.push(String((r as { host: string }).host));
    await fake.close();
    // 所有请求都只到过本机回环地址
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.every(h => h.startsWith('127.0.0.1:'))).toBe(true);
  });

  function target(over: Partial<WebhookTarget> = {}): WebhookTarget {
    return { id: 't1', name: '研发群', platform: 'dingtalk', enabled: true, url: `${fake.url}/robot/send?access_token=test`, ...over };
  }
  function make(over: Partial<ConstructorParameters<typeof WebhookNotifier>[0]> = {}) {
    return new WebhookNotifier({
      config: () => cfg, transport: nodeTransport, now: () => now, isAway: () => away, isQuitting: () => quitting,
      loopbackOnly: true, timeoutMs: 2000, hostname: 'PC-TEST', log: m => logs.push(m), ...over,
    });
  }
  let seq = 0;
  function n(kind: NotifyKind, sessionId = 's1', summary = 'npm test'): NotificationPayload {
    return {
      id: `n${++seq}`, sessionId, title: 't', body: 'b', level: 'warning', createdAt: now, kind,
      meta: { label: '甲', cwdTail: 'app', status: kind, summary },
    };
  }
  const received = () => fake.requests.length;

  beforeEach(() => {
    now = T0; away = true; quitting = false; logs = [];
    fake.set({ errcode: 0, hang: false, status: 200 });
    cfg = { ...defaultWebhookConfig(), enabled: true, when: 'always', targets: [target()] };
  });

  it('开关、事件勾选、退出中、无目标依次拦截', async () => {
    const w = make();
    const before = received();
    cfg = { ...cfg, enabled: false };
    await w.onNotification(n('permission'));
    cfg = { ...cfg, enabled: true, events: { ...cfg.events, turn: false } };
    await w.onNotification(n('turn'));
    quitting = true;
    await w.onNotification(n('permission', 's2'));
    quitting = false;
    cfg = { ...cfg, targets: [target({ enabled: false })] };
    await w.onNotification(n('permission', 's3'));
    await w.onNotification({ ...n('permission', 's4'), kind: undefined });
    expect(received()).toBe(before);
    expect(logs.filter(l => l.startsWith('skip ')).map(l => l.split('：')[0]))
      .toEqual(['skip event-off', 'skip quitting', 'skip no-target']);
  });

  it('仅离开时：在场不推送，离开后推送；消息含会话与摘要且带钉钉签名', async () => {
    cfg = { ...cfg, when: 'away', targets: [target({ secret: 'SECabc' })] };
    const w = make();
    away = false;
    const before = received();
    await w.onNotification(n('permission'));
    expect(received()).toBe(before);
    expect(logs.some(l => l.startsWith('skip present'))).toBe(true);
    away = true;
    await w.onNotification(n('permission'));
    expect(received()).toBe(before + 1);
    const req = fake.requests.at(-1) as { url: string; body: { markdown: { text: string } } };
    expect(req.url).toMatch(/timestamp=\d+&sign=/);
    expect(req.body.markdown.text).toContain('> 会话：甲');
    expect(req.body.markdown.text).toContain('> 摘要：npm test');
    expect(w.lastResults().t1).toMatchObject({ ok: true, status: 200 });
  });

  it('静默时段可跨零点', async () => {
    const q = { enabled: true, start: '22:00', end: '08:00' };
    expect(inQuiet(q, new Date(2026, 9, 17, 23, 30).getTime())).toBe(true);
    expect(inQuiet(q, new Date(2026, 9, 17, 7, 59).getTime())).toBe(true);
    expect(inQuiet(q, new Date(2026, 9, 17, 8, 0).getTime())).toBe(false);
    expect(inQuiet({ ...q, start: '09:00', end: '18:00' }, new Date(2026, 9, 17, 12).getTime())).toBe(true);
    expect(inQuiet({ ...q, enabled: false }, new Date(2026, 9, 17, 23).getTime())).toBe(false);
    cfg = { ...cfg, quiet: q };
    now = new Date(2026, 9, 17, 23, 0).getTime();
    const before = received();
    await make().onNotification(n('permission'));
    expect(received()).toBe(before);
    expect(logs.some(l => l.startsWith('skip quiet'))).toBe(true);
  });

  it('同会话节流 60 秒，出错类不受节流；10 分钟内同摘要去重', async () => {
    const w = make();
    const before = received();
    await w.onNotification(n('permission', 's1', 'a'));
    now += 30_000;
    await w.onNotification(n('turn', 's1', 'b'));
    expect(logs.some(l => l.startsWith('skip throttle'))).toBe(true);
    await w.onNotification(n('error', 's1', 'c'));
    await w.onNotification(n('permission', 's2', 'a'));
    expect(received()).toBe(before + 3);
    now += 61_000;
    await w.onNotification(n('permission', 's1', 'a'));
    expect(logs.some(l => l.startsWith('skip duplicate'))).toBe(true);
    await w.onNotification(n('error', 's1', 'c'));
    expect(received()).toBe(before + 3);
    now += 10 * 60_000;
    await w.onNotification(n('permission', 's1', 'a'));
    expect(received()).toBe(before + 4);
  });

  it('每目标每分钟 15 条，超出计数并附注在下一条', async () => {
    cfg = { ...cfg, throttleSec: 0 };
    const w = make();
    const before = received();
    for (let i = 0; i < 18; i++) await w.onNotification(n('permission', `r${i}`));
    expect(received()).toBe(before + 15);
    expect(logs.filter(l => l.startsWith('skip rate-limit'))).toHaveLength(3);
    now += 61_000;
    await w.onNotification(n('permission', 'r-next'));
    const last = fake.requests.at(-1) as { body: { markdown: { text: string } } };
    expect(last.body.markdown.text).toContain('（期间另有 3 条通知因限流未发送）');
  });

  it('errcode 非 0 判失败；连续失败 5 次熔断 10 分钟，之后恢复', async () => {
    fake.set({ errcode: 310000 });
    const w = make();
    const before = received();
    for (let i = 0; i < 6; i++) await w.onNotification(n('error', `e${i}`));
    expect(received()).toBe(before + 5);
    expect(w.lastResults().t1).toMatchObject({ ok: false, error: '平台返回 310000：fake error 310000' });
    expect(logs.some(l => l.startsWith('skip circuit-open'))).toBe(true);
    expect(w.circuitOpenUntil().t1).toBe(T0 + 10 * 60_000);
    fake.set({ errcode: 0 });
    now += 10 * 60_000;
    await w.onNotification(n('error', 'e-after'));
    expect(received()).toBe(before + 6);
    expect(w.lastResults().t1.ok).toBe(true);
    expect(w.circuitOpenUntil().t1).toBeUndefined();
  });

  it('并发到达的通知按目标串行投递，熔断后不再越过', async () => {
    fake.set({ errcode: 310000 });
    const w = make();
    const before = received();
    await Promise.all(Array.from({ length: 6 }, (_, i) => w.onNotification(n('error', `c${i}`))));
    expect(received()).toBe(before + 5);
    expect(logs.filter(l => l.startsWith('skip circuit-open'))).toHaveLength(1);
  });

  it('超时：假服务器不回应时按超时参数失败', async () => {
    fake.set({ hang: true });
    const w = make({ timeoutMs: 200, now: Date.now });
    const t = Date.now();
    await w.onNotification(n('error', 'hang'));
    expect(Date.now() - t).toBeLessThan(2000);
    expect(w.lastResults().t1).toMatchObject({ ok: false, error: '超时（200ms 无响应）' });
  });

  it('测试消息绕过静默、节流、离开与熔断，返回结果与耗时', async () => {
    cfg = { ...cfg, when: 'away', quiet: { enabled: true, start: '00:00', end: '23:59' } };
    away = false;
    const w = make();
    fake.set({ errcode: 310000 });
    for (let i = 0; i < 5; i++) await w.test([target()]);
    fake.set({ errcode: 0 });
    const r = await w.test([target({ platform: 'feishu', secret: 'S' })]);
    expect(r).toEqual([expect.objectContaining({ targetId: 't1', ok: true, status: 200 })]);
    expect(typeof r[0].ms).toBe('number');
    const body = (fake.requests.at(-1) as { body: { content: { text: string }; sign: string } }).body;
    expect(body.content.text).toContain('Claude Nexus · 测试消息');
    expect(body.content.text).toContain('来自：PC-TEST');
    expect(body.sign).toBeTruthy();
  });

  it('只允许回环时拒绝外部地址且不发请求；日志不含令牌', async () => {
    const w = make();
    const before = received();
    let called = 0;
    const spy = make({ transport: async () => { called++; return { status: 200, text: '' }; } });
    cfg = { ...cfg, targets: [target({ url: 'https://example.com/hook?token=supersecret-123456' })] };
    await spy.onNotification(n('error', 'ext'));
    const r = await w.test(cfg.targets);
    expect(called).toBe(0);
    expect(received()).toBe(before);
    expect(r[0]).toMatchObject({ ok: false, error: '自测模式只允许本机回环地址（loopback only）' });
    expect(logs.some(l => l.includes('loopback only'))).toBe(true);
    expect(logs.join('\n')).not.toContain('supersecret-123456');
  });
});
