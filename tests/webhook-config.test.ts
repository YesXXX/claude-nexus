import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultWebhookConfig, mergeDraft, WebhookConfigStore, type SecretCipher } from '../src/main/webhook-config';
import type { WebhookConfigDraft } from '../src/shared/webhook-types';

/** 假加密器：反转后 base64，足以验证落盘不含明文 */
function fakeCipher(available = true): SecretCipher & { calls: number } {
  const c = {
    calls: 0,
    available: () => available,
    encrypt: (s: string) => { c.calls++; return Buffer.from([...s].reverse().join(''), 'utf8').toString('base64'); },
    decrypt: (b: string) => [...Buffer.from(b, 'base64').toString('utf8')].reverse().join(''),
  };
  return c;
}

const URL1 = 'http://127.0.0.1:18080/robot/send?access_token=tok-0123456789abcdef';
const URL2 = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=wecom-key-998877';

function draft(over: Partial<WebhookConfigDraft> = {}): WebhookConfigDraft {
  const d = defaultWebhookConfig();
  return {
    enabled: true, events: d.events, when: 'always', awayMinutes: 5, quiet: d.quiet, throttleSec: 60, includeSummary: true,
    targets: [{ name: '研发群', platform: 'dingtalk', enabled: true, url: URL1, secret: 'SECabc' }],
    ...over,
  };
}

describe('webhook 配置', () => {
  let dir = '';
  let file = '';
  let oldHome: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
    oldHome = process.env.CLAUDE_PANEL_HOME;
    process.env.CLAUDE_PANEL_HOME = dir;
    file = WebhookConfigStore.fileIn(dir);
  });
  afterEach(() => {
    if (oldHome === undefined) delete process.env.CLAUDE_PANEL_HOME; else process.env.CLAUDE_PANEL_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('默认值：关闭；默认勾选等待批准、本轮结束、出错与上下文告警；仅离开时 5 分钟', () => {
    const c = new WebhookConfigStore(file, fakeCipher()).get();
    expect(c.enabled).toBe(false);
    expect(c.events).toMatchObject({ permission: true, input: false, turn: true, error: true, lost: true, budget: true, overdue: false });
    expect(c.when).toBe('away');
    expect(c.awayMinutes).toBe(5);
    expect(c.throttleSec).toBe(60);
  });

  it('加密往返：磁盘不含明文 URL 与 secret，重新载入后还原', () => {
    const cipher = fakeCipher();
    const s = new WebhookConfigStore(file, cipher);
    expect(s.save(draft()).ok).toBe(true);
    const disk = fs.readFileSync(file, 'utf8');
    expect(disk).not.toContain('tok-0123456789abcdef');
    expect(disk).not.toContain('SECabc');
    expect(disk).toContain('enc:v1:');
    const again = new WebhookConfigStore(file, cipher).get();
    expect(again.targets[0]).toMatchObject({ name: '研发群', platform: 'dingtalk', url: URL1, secret: 'SECabc' });
  });

  it('加密不可用时以 plain: 前缀保存', () => {
    const s = new WebhookConfigStore(file, fakeCipher(false));
    expect(s.save(draft()).ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain(`plain:${URL1}`);
    expect(s.encryptionAvailable()).toBe(false);
  });

  it('脱敏视图只给打码 URL 与是否已设置 secret', () => {
    const s = new WebhookConfigStore(file, fakeCipher());
    s.save(draft());
    const v = s.views()[0];
    expect(v.urlMasked).toBe('http://127.0.0.1:18080/robot/send?access_token=****cdef');
    expect(v.hasSecret).toBe(true);
    expect(JSON.stringify(v)).not.toContain('SECabc');
    expect(JSON.stringify(v)).not.toContain('tok-0123456789abcdef');
  });

  it('留空或等于脱敏值表示不修改；clearSecret 删除 secret；企业微信不存 secret', () => {
    const s = new WebhookConfigStore(file, fakeCipher());
    s.save(draft());
    const id = s.get().targets[0].id;
    const masked = s.views()[0].urlMasked;
    expect(s.save(draft({ targets: [{ id, name: '研发群', platform: 'dingtalk', enabled: true, url: masked, secret: '' }] })).ok).toBe(true);
    expect(s.get().targets[0]).toMatchObject({ id, url: URL1, secret: 'SECabc' });
    s.save(draft({ targets: [{ id, name: '研发群', platform: 'dingtalk', enabled: true, url: '', clearSecret: true }] }));
    expect(s.get().targets[0].url).toBe(URL1);
    expect(s.get().targets[0].secret).toBeUndefined();
    s.save(draft({ targets: [{ name: 'w', platform: 'wecom', enabled: true, url: URL2, secret: 'x' }] }));
    expect(s.get().targets[0].secret).toBeUndefined();
    expect(s.get().targets[0].id).not.toBe(id);
  });

  it('逐字段报错，不保存', () => {
    const s = new WebhookConfigStore(file, fakeCipher());
    const r = s.save(draft({
      awayMinutes: 0, throttleSec: -1, quiet: { enabled: true, start: '25:00', end: '8:00' },
      targets: [
        { name: 'a', platform: 'dingtalk', enabled: true, url: 'http://example.com/hook' },
        { name: 'b', platform: 'feishu', enabled: true, url: '' },
      ],
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(['awayMinutes', 'quiet.end', 'quiet.start', 'targets.0.url', 'targets.1.url', 'throttleSec']);
    expect(r.errors['targets.0.url']).toMatch(/只允许 https/);
    expect(fs.existsSync(file)).toBe(false);
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `t${i}`, platform: 'wecom' as const, enabled: true, url: URL2 }));
    const r2 = mergeDraft(defaultWebhookConfig(), draft({ targets: six }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors.targets).toBe('最多 5 个目标');
    const same = mergeDraft(defaultWebhookConfig(), draft({ quiet: { enabled: true, start: '22:00', end: '22:00' } }));
    expect(same.ok).toBe(false);
  });

  it('损坏文件回退默认值；解密失败的项按未设置处理', () => {
    fs.writeFileSync(file, '{坏了');
    expect(new WebhookConfigStore(file, fakeCipher()).get()).toEqual(defaultWebhookConfig());
    fs.writeFileSync(file, JSON.stringify({
      version: 1, enabled: true, when: 'nonsense', awayMinutes: 'x', throttleSec: 99999,
      targets: [{ id: 't1', name: 'x', platform: 'qq', url: 'enc:v1:@@@', secret: 'plain:s' }],
    }));
    const broken: SecretCipher = { available: () => true, encrypt: s => s, decrypt: () => { throw new Error('bad'); } };
    const c = new WebhookConfigStore(file, broken).get();
    expect(c).toMatchObject({ enabled: true, when: 'away', awayMinutes: 5, throttleSec: 3600 });
    expect(c.targets[0]).toMatchObject({ id: 't1', platform: 'wecom', url: '', secret: 's' });
  });
});
