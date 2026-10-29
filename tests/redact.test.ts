import { describe, expect, it } from 'vitest';
import { redact, redactSecrets, truncateText } from '../src/shared/redact';

describe('redactSecrets', () => {
  const cases: Array<[string, string, string]> = [
    ['URL 内嵌账号', 'git clone https://user:p4ss@github.com/a/b.git', 'https://***@github.com/a/b.git'],
    ['Bearer 令牌', 'curl -H "Authorization: Bearer abcdef123456"', 'Bearer ***'],
    ['口令键值', 'mysql password=hunter2 db', 'password=***'],
    ['JSON 键值', '{"api_key": "abc123xyz"}', '"api_key": "***'],
    ['命令行参数', 'login --password s3cret now', '--password ***'],
    ['OpenAI 风格', 'key sk-abcdefghijklmnopqrstu', 'sk-***'],
    ['GitHub 令牌', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_***'],
    ['GitHub 细粒度令牌', 'github_pat_11ABCDEFG0123456789abcdef', 'github_pat_***'],
    ['AWS 访问键', 'AKIAABCDEFGHIJKLMNOP', 'AKIA***'],
    ['Slack 令牌', 'xoxb-1234567890-abcdef', 'xoxb-***'],
    ['JWT', 'eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSM', '***'],
    ['长十六进制', 'secret 0123456789abcdef0123456789abcdef!', '***!'],
  ];
  for (const [name, input, expected] of cases) {
    it(`${name}被打码`, () => {
      const out = redactSecrets(input);
      expect(out).toContain(expected);
    });
  }

  it('打码后不再包含原始密钥', () => {
    const secrets = ['p4ss', 'abcdef123456', 'hunter2', 'abc123xyz', 's3cret', 'abcdefghijklmnopqrstu', 'ABCDEFGHIJKLMNOP'];
    const text = 'https://u:p4ss@h Bearer abcdef123456 password=hunter2 api_key=abc123xyz --password s3cret sk-abcdefghijklmnopqrstu AKIAABCDEFGHIJKLMNOP';
    const out = redactSecrets(text);
    for (const s of secrets) expect(out).not.toContain(s);
  });

  it('长 base64 串同时含数字与大小写才打码，普通长单词与路径不受影响', () => {
    expect(redactSecrets('tok QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA=')).toBe('tok ***');
    const plain = 'src/renderer/features/changes/diff-view-control.ts';
    expect(redactSecrets(plain)).toBe(plain);
    expect(redactSecrets('internationalizationlocalizationxx')).toBe('internationalizationlocalizationxx');
  });

  it('普通文本原样保留', () => {
    const s = 'npm run build && git status -s; author: 张三';
    expect(redactSecrets(s)).toBe(s);
  });
});

describe('truncateText', () => {
  it('未超长原样返回，超长时含省略号不超过上限', () => {
    expect(truncateText('abc', 3)).toBe('abc');
    const t = truncateText('abcdefgh', 5);
    expect(t).toBe('abcd…');
    expect(t.length).toBe(5);
  });

  it('不切断代理对', () => {
    const s = 'ab😀cd';
    const t = truncateText(s, 4);
    expect(t).toBe('ab…');
    expect(/[\ud800-\udbff]$/.test(t.slice(0, -1))).toBe(false);
  });

  it('上限小于 1 返回空串', () => {
    expect(truncateText('abc', 0)).toBe('');
  });
});

describe('redact', () => {
  it('先打码再截断', () => {
    const out = redact(`token=${'x'.repeat(50)} tail`, 12);
    expect(out.startsWith('token=***')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(12);
  });
});
