import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { q, useApp } from './harness';
import { createSessionViaForm, mkWorkDir, runTurn, waitOutput } from './fixtures';
import { startFakeWebhook } from '../fixtures/fake-webhook-server.js';

type Fake = Awaited<ReturnType<typeof startFakeWebhook>>;
interface Req { url: string; host: string; body: { markdown?: { title: string; text: string }; msgtype?: string } }

/** 远程通知：设置界面、测试消息、投递规则与熔断，只连进程内的本机假群机器人 */
describe('远程通知', () => {
  const app = useApp({
    env: { CLAUDE_PANEL_WEBHOOK_LOOPBACK_ONLY: '1', CLAUDE_PANEL_WEBHOOK_AWAY: '1', CLAUDE_PANEL_TEST_HOOKS: '1' },
  });
  let fake: Fake;
  const TOKEN = 'e2e-token-0123456789';
  const SECRET = 'SECe2e-secret-abc';
  const EXT_TOKEN = 'ext-secret-123456';
  let A = '';
  let B = '';

  beforeAll(async () => { fake = await startFakeWebhook(); });
  afterAll(async () => {
    const hosts = fake.requests.map(r => String((r as Req).host));
    await fake.close();
    // 所有请求都只到过本机回环地址
    expect(hosts.every(h => h.startsWith('127.0.0.1:'))).toBe(true);
  });

  const reqs = () => fake.requests as Req[];
  const textOf = (r: Req) => r.body.markdown?.text ?? '';
  const rowSel = (n: number, part: string) => `#rn-targets .rn-target:nth-child(${n}) ${part}`;
  const setChecked = (sel: string, on: boolean) => app.eval(`(() => { const el = document.querySelector(${q(sel)});
    el.checked = ${on}; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const setSelect = (sel: string, v: string) => app.eval(`(() => { const el = document.querySelector(${q(sel)});
    el.value = ${q(v)}; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const waitCount = (n: number, message: string) => app.until(() => (reqs().length >= n ? true : null), { message, timeout: 15_000 });
  const waitLog = (text: string, message: string) => app.until(() => (app.logs().includes(text) ? true : null), { message });
  const settle = (ms = 1500) => new Promise(r => setTimeout(r, ms));
  const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const value = (sel: string) => app.eval<string>(`document.querySelector(${q(sel)}).value`);

  async function openDialog(): Promise<void> {
    await app.blur();
    await app.press('Control+K');
    await app.waitVisible('#palette-backdrop');
    await app.type('远程通知');
    await app.waitFor(`document.querySelector('#palette-list .pal-i.on .pt')?.textContent === '远程通知设置'`,
      { message: '命令面板选中「远程通知设置」' });
    await app.press('Enter');
    await app.waitHidden('#palette-backdrop');
    await app.waitVisible('#rn-backdrop');
  }
  async function save(): Promise<void> {
    await app.click('#rn-save');
    await app.waitHidden('#rn-backdrop');
  }
  async function cancel(): Promise<void> {
    await app.click('#rn-cancel');
    await app.waitHidden('#rn-backdrop');
  }

  it('添加钉钉目标并保存：重新打开时地址脱敏、secret 不回显，磁盘不含明文', async () => {
    await openDialog();
    expect(await app.count('#rn-targets .rn-target')).toBe(0);
    expect(await app.eval<boolean>(`document.querySelector('#rn-enabled').checked`)).toBe(false);
    // 默认勾选：等待批准、本轮结束、出错、上下文告警
    const evs = await app.eval<Record<string, boolean>>(`Object.fromEntries([...document.querySelectorAll('.rn-events input')]
      .map(i => [i.dataset.group, i.checked]))`);
    expect(evs).toEqual({ permission: true, input: false, turn: true, error: true, budget: true, overdue: false });

    // 非 https 的外部地址给出即时提示，粘贴钉钉地址自动选平台
    await app.click('#rn-add');
    await app.fill(rowSel(1, '.rn-t-url'), 'http://example.com/hook');
    await app.waitFor(`document.querySelector(${q(rowSel(1, '.rn-hint'))}).textContent.includes('只允许 https')`, { message: '即时提示' });
    await app.fill(rowSel(1, '.rn-t-url'), 'https://oapi.dingtalk.com/robot/send?access_token=x');
    expect(await value(rowSel(1, '.rn-t-platform'))).toBe('dingtalk');
    await setSelect(rowSel(1, '.rn-t-platform'), 'wecom');
    expect(await app.visible(rowSel(1, '.rn-t-secret'))).toBe(false);

    await setChecked('#rn-enabled', true);
    await app.fill(rowSel(1, '.rn-t-name'), '研发群');
    await app.fill(rowSel(1, '.rn-t-url'), `${fake.url}/robot/send?access_token=${TOKEN}`);
    await setSelect(rowSel(1, '.rn-t-platform'), 'dingtalk');
    expect(await app.visible(rowSel(1, '.rn-t-secret'))).toBe(true);
    await app.fill(rowSel(1, '.rn-t-secret'), SECRET);
    await setChecked('#rn-when-always', true);
    await save();

    await openDialog();
    const url = await value(rowSel(1, '.rn-t-url'));
    expect(url).toContain('access_token=****');
    expect(url).not.toContain(TOKEN);
    expect(await value(rowSel(1, '.rn-t-secret'))).toBe('');
    expect(await app.eval<string>(`document.querySelector(${q(rowSel(1, '.rn-t-secret'))}).placeholder`)).toBe('已设置，留空不修改');
    expect(await app.visible('#rn-enc-warn')).toBe(false);
    const view = JSON.stringify(await app.eval('window.panelApi.webhook.getConfig()'));
    expect(view).not.toContain(TOKEN);
    expect(view).not.toContain(SECRET);
    const disk = fs.readFileSync(path.join(app.home, 'webhook.json'), 'utf8');
    expect(disk).not.toContain(TOKEN);
    expect(disk).not.toContain(SECRET);
    expect(disk).toContain('enc:v1:');
  });

  it('发送测试消息：请求带 timestamp 与 sign，目标行显示成功与耗时', async () => {
    const before = reqs().length;
    await app.click('#rn-test-all');
    await waitCount(before + 1, '假机器人收到测试消息');
    const r = reqs().at(-1)!;
    expect(r.url).toContain(`access_token=${TOKEN}`);
    expect(r.url).toMatch(/timestamp=\d+&sign=/);
    expect(textOf(r)).toContain('Claude Nexus · 测试消息');
    await app.waitFor(`/最近：\\d\\d:\\d\\d 成功 · \\d+ms/.test(document.querySelector(${q(rowSel(1, '.rn-t-last'))}).textContent)`,
      { message: '目标行显示成功与耗时' });
    expect(await app.eval<boolean>(`document.querySelector('#rn-test-all').disabled`)).toBe(false);
    await cancel();
  });

  it('等待批准推送内容完整；同会话 60 秒内的回合结束被节流', async () => {
    A = await createSessionViaForm(app, '网钩甲', mkWorkDir(app, 'wh-a'));
    await waitOutput(app, A, 'mock-claude 已启动');
    const before = reqs().length;
    await runTurn(app, A, 'wh-task');
    await waitCount(before + 1, '收到等待批准推送');
    const r = reqs()[before];
    const t = textOf(r);
    expect(r.body.markdown?.title).toBe('Claude Nexus · 🔐 等待批准');
    expect(t).toContain('> 会话：网钩甲');
    expect(t).toContain('> 状态：等待批准（Bash）');
    expect(t).toContain('> 目录：wh-a');
    expect(t).toContain('> 摘要：echo wh-task');
    expect(t).not.toContain(app.work);
    await waitLog('skip throttle：turn', '回合结束被节流');
    await settle();
    expect(reqs().length).toBe(before + 1);
  });

  it('关闭本轮结束后不推送；静默时段内不推送并记日志', async () => {
    await openDialog();
    await setChecked('#rn-ev-turn', false);
    await app.fill('#rn-throttle', '0');
    await save();
    B = await createSessionViaForm(app, '网钩乙', mkWorkDir(app, 'wh-b'));
    await waitOutput(app, B, 'mock-claude 已启动');
    let before = reqs().length;
    await runTurn(app, B, 'wh-two');
    await waitCount(before + 1, '等待批准仍推送');
    await waitLog('skip event-off：turn', '本轮结束未勾选');
    await settle();
    expect(reqs().length).toBe(before + 1);

    // 时间框即时提示格式错误；静默时段覆盖当前时间
    await openDialog();
    await setChecked('#rn-quiet-on', true);
    await app.fill('#rn-quiet-start', '25:00');
    await app.waitFor(`document.querySelector('[data-field="quiet.start"]').textContent.includes('HH:mm')`, { message: '时间格式提示' });
    const now = Date.now();
    await app.fill('#rn-quiet-start', hm(new Date(now - 3600_000)));
    await app.fill('#rn-quiet-end', hm(new Date(now + 3600_000)));
    await save();
    before = reqs().length;
    await runTurn(app, B, 'wh-three');
    await waitLog('skip quiet：permission', '静默跳过');
    await settle();
    expect(reqs().length).toBe(before);

    await openDialog();
    await setChecked('#rn-quiet-on', false);
    await save();
  });

  it('保存失败逐字段显示，弹窗不关闭', async () => {
    await openDialog();
    await app.fill('#rn-away-min', '0');
    await app.fill(rowSel(1, '.rn-t-url'), 'ftp://127.0.0.1/x');
    await app.click('#rn-save');
    await app.waitFor(`document.querySelector('[data-field="awayMinutes"]').textContent.includes('1–240')`, { message: '离开分钟报错' });
    expect(await app.text(rowSel(1, '.rn-hint'))).toContain('只允许 https');
    expect(await app.visible('#rn-backdrop')).toBe(true);
    await cancel();
  });

  it('外部地址可保存，但投递被拒且不发请求，日志不含令牌', async () => {
    await openDialog();
    await app.click('#rn-add');
    await app.fill(rowSel(2, '.rn-t-name'), '外部');
    await app.fill(rowSel(2, '.rn-t-url'), `https://example.com/hook?token=${EXT_TOKEN}`);
    await save();
    await openDialog();
    const before = reqs().length;
    await app.click(rowSel(2, '.rn-t-test'));
    await app.waitFor(`document.querySelector(${q(rowSel(2, '.rn-t-last'))}).textContent.includes('loopback only')`,
      { message: '外部目标被拒' });
    expect(reqs().length).toBe(before);
    expect(app.logs()).toContain('skip loopback only');
    for (const s of [EXT_TOKEN, TOKEN, SECRET]) expect(app.logs()).not.toContain(s);
    await app.click(rowSel(2, '.rn-t-del'));
    expect(await app.count('#rn-targets .rn-target')).toBe(1);
    await save();
  });

  it('用户结束会话不产生出错或失联推送', async () => {
    const before = reqs().length;
    await app.eval(`window.panelApi.kill(${q(A)})`);
    await app.until(async () => {
      const s = await app.session(A);
      return !s || (s.status !== 'completed' && s.status !== 'running') || s.exitCode !== undefined ? true : null;
    }, { message: '会话甲已结束' });
    await settle(2000);
    expect(reqs().slice(before).filter(r => /异常退出|失联/.test(textOf(r)))).toEqual([]);
  });

  it('连续失败 5 次熔断，第 6 条不再发请求，设置页显示熔断提示', async () => {
    fake.set({ errcode: 310000 });
    const before = reqs().length;
    const list = Array.from({ length: 6 }, (_, i) => ({
      type: 'budget.alert', source: 'usage', level: 'warning', title: `上下文已用 ${80 + i}%`,
      detail: `${800 + i * 10}k / 1M`, dedupeKey: `e2e-context-${i}`,
    }));
    await app.eval(`window.panelApi.activity.testReport(${JSON.stringify(list)})`);
    await waitCount(before + 5, '前 5 条请求发出');
    await waitLog('skip circuit-open', '第 6 条被熔断');
    await settle();
    expect(reqs().length).toBe(before + 5);
    expect(textOf(reqs()[before])).toContain('上下文告警');
    fake.set({ errcode: 0 });
    await openDialog();
    const last = await app.text(rowSel(1, '.rn-t-last'));
    expect(last).toContain('失败');
    expect(last).toContain('310000');
    expect(last).toContain('熔断');
    await cancel();
  });

  it('退出面板过程中不推送；重启后配置仍在', async () => {
    const before = reqs().length;
    await app.restart();
    await settle();
    expect(reqs().length).toBe(before);
    await openDialog();
    expect(await app.count('#rn-targets .rn-target')).toBe(1);
    expect(await value(rowSel(1, '.rn-t-name'))).toBe('研发群');
    expect(await app.eval<boolean>(`document.querySelector('#rn-enabled').checked`)).toBe(true);
    await cancel();
  });
});
