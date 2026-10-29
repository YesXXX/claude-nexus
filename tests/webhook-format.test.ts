import { describe, expect, it } from 'vitest';
import type { NotificationPayload } from '../src/shared/types';
import {
  buildMessage, buildRequest, cwdTailOf, detectPlatform, dingtalkSign, feishuSign, isLoopbackUrl, judgeResponse,
  maskWebhookUrl, markdownText, plainText, testMessage, validateWebhookUrl,
} from '../src/main/webhook-format';

const AT = new Date(2026, 9, 17, 14, 2, 31).getTime();
const SECRET = 'SEC0123456789abcdef';

function perm(extra: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    id: 'n1', sessionId: 's1', title: '🔐 「重构用户模块」请求授权', body: '...', level: 'warning', createdAt: AT,
    kind: 'permission',
    meta: { label: '重构用户模块', cwdTail: 'app', status: '等待批准（Bash）', toolName: 'Bash', summary: 'npm run build && npm test' },
    ...extra,
  };
}

describe('平台识别与 URL 规则', () => {
  it('按域名识别三平台，其余返回 null', () => {
    expect(detectPlatform('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc')).toBe('wecom');
    expect(detectPlatform('https://oapi.dingtalk.com/robot/send?access_token=x')).toBe('dingtalk');
    expect(detectPlatform('https://open.feishu.cn/open-apis/bot/v2/hook/x')).toBe('feishu');
    expect(detectPlatform('https://open.larksuite.com/open-apis/bot/v2/hook/x')).toBe('feishu');
    expect(detectPlatform('https://example.com/hook')).toBeNull();
    expect(detectPlatform('不是地址')).toBeNull();
  });

  it('必须 https，http 只允许回环地址', () => {
    expect(validateWebhookUrl('https://example.com/x')).toBeNull();
    expect(validateWebhookUrl('http://127.0.0.1:3000/robot')).toBeNull();
    expect(validateWebhookUrl('http://localhost/robot')).toBeNull();
    expect(validateWebhookUrl('http://[::1]:80/robot')).toBeNull();
    expect(validateWebhookUrl('http://example.com/x')).toMatch(/只允许 https/);
    expect(validateWebhookUrl('http://127.0.0.1.evil.com/x')).toMatch(/只允许 https/);
    expect(validateWebhookUrl('ftp://127.0.0.1/x')).toMatch(/只允许 https/);
    expect(validateWebhookUrl('')).toBe('请填写 webhook 地址');
    expect(validateWebhookUrl('abc')).toBe('地址格式不正确');
    expect(isLoopbackUrl('http://127.8.0.1/x')).toBe(true);
    expect(isLoopbackUrl('https://example.com')).toBe(false);
  });

  it('脱敏：查询参数与长路径段只留末 4 位', () => {
    expect(maskWebhookUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa'))
      .toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=****5aaa');
    expect(maskWebhookUrl('https://open.feishu.cn/open-apis/bot/v2/hook/2d4e8a1c-0000-1111-2222-3fa1'))
      .toBe('https://open.feishu.cn/open-apis/bot/v2/hook/****3fa1');
    expect(maskWebhookUrl('')).toBe('');
  });
});

describe('加签', () => {
  it('钉钉：HMAC-SHA256(secret, timestamp\\nsecret) 的 base64，固定时间戳向量', () => {
    expect(dingtalkSign(SECRET, 1_700_000_000_000)).toBe('TSZbRFUuvaSQaRKUpF970OPCb2/LcQAP3wOvwZIzBZk=');
  });

  it('飞书：以 timestamp\\nsecret 为密钥对空串签名，固定时间戳向量', () => {
    expect(feishuSign(SECRET, 1_700_000_000)).toBe('PiO7POLlSx/DM2qf8Dy/XCWeJK3exVnevp5G99LEN2M=');
  });

  it('钉钉签名放查询参数并做 URL 编码，飞书签名放消息体，企业微信不加签', () => {
    const msg = testMessage('PC-01', AT);
    const d = buildRequest({ platform: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=t', secret: SECRET }, msg, 1_700_000_000_000);
    const u = new URL(d.url);
    expect(u.searchParams.get('access_token')).toBe('t');
    expect(u.searchParams.get('timestamp')).toBe('1700000000000');
    expect(u.searchParams.get('sign')).toBe('TSZbRFUuvaSQaRKUpF970OPCb2/LcQAP3wOvwZIzBZk=');
    expect(d.url).toContain('sign=TSZbRFUuvaSQaRKUpF970OPCb2%2FLcQAP3wOvwZIzBZk%3D');
    const f = JSON.parse(buildRequest({ platform: 'feishu', url: 'https://open.feishu.cn/h', secret: SECRET }, msg, 1_700_000_000_123).body);
    expect(f).toMatchObject({ timestamp: '1700000000', sign: 'PiO7POLlSx/DM2qf8Dy/XCWeJK3exVnevp5G99LEN2M=' });
    const w = buildRequest({ platform: 'wecom', url: 'https://qyapi.weixin.qq.com/x?key=k', secret: SECRET }, msg, AT);
    expect(w.url).toBe('https://qyapi.weixin.qq.com/x?key=k');
  });
});

describe('消息内容', () => {
  it('三平台消息体', () => {
    const msg = buildMessage(perm(), { includeSummary: true, now: AT });
    const md = [
      '**Claude Nexus · 🔐 等待批准**',
      '> 会话：重构用户模块',
      '> 状态：等待批准（Bash）',
      '> 目录：app',
      '> 摘要：npm run build && npm test',
      '> 时间：10-17 14:02:31',
    ].join('\n');
    expect(markdownText(msg)).toBe(md);
    const t = { url: 'https://x.test/h' };
    expect(JSON.parse(buildRequest({ ...t, platform: 'wecom' }, msg, AT).body)).toEqual({ msgtype: 'markdown', markdown: { content: md } });
    expect(JSON.parse(buildRequest({ ...t, platform: 'dingtalk' }, msg, AT).body))
      .toEqual({ msgtype: 'markdown', markdown: { title: 'Claude Nexus · 🔐 等待批准', text: md } });
    expect(JSON.parse(buildRequest({ ...t, platform: 'feishu' }, msg, AT).body)).toEqual({
      msg_type: 'text',
      content: { text: 'Claude Nexus · 🔐 等待批准\n会话：重构用户模块\n状态：等待批准（Bash）\n目录：app\n摘要：npm run build && npm test\n时间：10-17 14:02:31' },
    });
  });

  it('摘要打码并截断到 80 字符；关闭摘要时不发；cwd 只取末段', () => {
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const long = `curl -H "Authorization: Bearer ${secret}" ${'x'.repeat(200)}`;
    const msg = buildMessage(perm({ meta: { label: '甲', cwdTail: 'D:\\work\\secret-project\\app', summary: long } }), { includeSummary: true, now: AT });
    const sum = msg.lines.find(l => l[0] === '摘要')![1];
    expect(sum).not.toContain('ABCDEFGHIJ');
    expect(sum).toContain('***');
    expect(sum.length).toBeLessThanOrEqual(81);
    expect(msg.lines.find(l => l[0] === '目录')![1]).toBe('app');
    expect(cwdTailOf('/home/u/proj/')).toBe('proj');
    const off = buildMessage(perm(), { includeSummary: false, now: AT });
    expect(off.lines.some(l => l[0] === '摘要')).toBe(false);
    expect(plainText(off)).not.toContain('npm run build');
  });

  it('等待超时标题带分钟数，限流丢弃附注在末尾，测试消息带计算机名', () => {
    const msg = buildMessage(perm({ kind: 'overdue', meta: { label: '甲', status: '仍在等待（7 分钟）' } }), { includeSummary: true, now: AT, dropped: 3 });
    expect(msg.heading).toBe('Claude Nexus · ⏰ 仍在等待（7 分钟）');
    expect(markdownText(msg).split('\n').at(-1)).toBe('（期间另有 3 条通知因限流未发送）');
    expect(plainText(testMessage('PC-01', AT))).toBe('Claude Nexus · 测试消息\n来自：PC-01\n时间：10-17 14:02:31\n结果：配置可用');
  });
});

describe('响应判定', () => {
  it('2xx 且 errcode / code 为 0 才算成功', () => {
    expect(judgeResponse('wecom', 200, '{"errcode":0,"errmsg":"ok"}')).toEqual({ ok: true });
    expect(judgeResponse('dingtalk', 200, '{"errcode":310000,"errmsg":"sign not match"}'))
      .toEqual({ ok: false, error: '平台返回 310000：sign not match' });
    expect(judgeResponse('feishu', 200, '{"code":0,"msg":"success"}')).toEqual({ ok: true });
    expect(judgeResponse('feishu', 200, '{"StatusCode":0,"StatusMessage":"success"}')).toEqual({ ok: true });
    expect(judgeResponse('feishu', 200, '{"code":19021,"msg":"sign match fail"}').ok).toBe(false);
    expect(judgeResponse('wecom', 500, 'oops')).toEqual({ ok: false, error: 'HTTP 500：oops' });
    expect(judgeResponse('wecom', 204, '')).toEqual({ ok: true });
  });
});
