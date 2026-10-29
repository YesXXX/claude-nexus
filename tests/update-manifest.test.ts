import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  UpdateManifest, canonicalize, compareVersions, keyIdOf, sha256File, signManifest, validateShape, verifySignature,
} from '../src/main/update-manifest';

const sample = (): UpdateManifest => ({
  productName: 'Claude 会话面板',
  version: '0.2.0',
  file: 'ClaudePanel-Setup-v0.2.0.exe',
  size: 1234,
  sha256: 'a'.repeat(64),
  notes: '- 修复若干问题',
  pubDate: '2026-10-16T00:00:00.000Z',
});

function keyPair(): { privateKey: crypto.KeyObject; keys: { keyId: string; pem: string }[] } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey,
    keys: [{ keyId: keyIdOf(publicKey), pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
  };
}

describe('validateShape', () => {
  it('合法清单通过；notes 可省略', () => {
    expect(validateShape(sample())).toBe(true);
    const { notes: _n, ...noNotes } = sample();
    expect(validateShape(noNotes)).toBe(true);
  });

  it('非法字段一律拒绝：版本格式、带路径或非 exe 的文件名、非正整数大小、sha256 格式', () => {
    expect(validateShape(null)).toBe(false);
    expect(validateShape({ ...sample(), version: '0.2' })).toBe(false);
    expect(validateShape({ ...sample(), version: 'v0.2.0' })).toBe(false);
    expect(validateShape({ ...sample(), file: '..\\evil.exe' })).toBe(false);
    expect(validateShape({ ...sample(), file: 'sub/a.exe' })).toBe(false);
    expect(validateShape({ ...sample(), file: 'a.bat' })).toBe(false);
    expect(validateShape({ ...sample(), size: 0 })).toBe(false);
    expect(validateShape({ ...sample(), size: 1.5 })).toBe(false);
    expect(validateShape({ ...sample(), sha256: 'A'.repeat(64) })).toBe(false);
    expect(validateShape({ ...sample(), notes: 1 })).toBe(false);
  });
});

describe('签名与验签', () => {
  it('签名后可被对应公钥验证', () => {
    const { privateKey, keys } = keyPair();
    const m = signManifest(sample(), privateKey);
    expect(m.sigAlg).toBe('ed25519');
    expect(m.keyId).toBe(keys[0].keyId);
    expect(verifySignature(m, keys)).toBe(true);
  });

  it('任一签名字段被篡改（含更新说明）都验签失败', () => {
    const { privateKey, keys } = keyPair();
    const m = signManifest(sample(), privateKey);
    for (const patch of [
      { version: '9.9.9' }, { file: 'other.exe' }, { size: 999 }, { sha256: 'b'.repeat(64) },
      { notes: '诱导文案' }, { pubDate: 'x' }, { productName: 'y' },
    ]) {
      expect(verifySignature({ ...m, ...patch }, keys)).toBe(false);
    }
  });

  it('未知 keyId、非 ed25519、缺签名、签名乱码、换一把钥匙都失败且不抛错', () => {
    const { privateKey, keys } = keyPair();
    const other = keyPair();
    const m = signManifest(sample(), privateKey);
    expect(verifySignature({ ...m, keyId: 'ffffffffffffffff' }, keys)).toBe(false);
    expect(verifySignature({ ...m, sigAlg: 'rsa' }, keys)).toBe(false);
    expect(verifySignature({ ...m, signature: undefined }, keys)).toBe(false);
    expect(verifySignature({ ...m, signature: '!!!' }, keys)).toBe(false);
    expect(verifySignature(m, [])).toBe(false);
    // 另一把公钥冒用同一 keyId
    expect(verifySignature(m, [{ keyId: m.keyId!, pem: other.keys[0].pem }])).toBe(false);
  });

  it('notes 缺省与空串的签名载荷一致', () => {
    const { notes: _n, ...noNotes } = sample();
    expect(canonicalize(noNotes).equals(canonicalize({ ...sample(), notes: '' }))).toBe(true);
  });
});

describe('compareVersions', () => {
  it('按段数值比较，缺段补 0', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('0.1.9', '0.1.10')).toBe(-1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});

describe('sha256File', () => {
  it('与一次性计算的摘要一致', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-sha-'));
    const file = path.join(dir, 'a.bin');
    const data = crypto.randomBytes(3 * 1024 * 1024 + 7);
    fs.writeFileSync(file, data);
    expect(await sha256File(file)).toBe(crypto.createHash('sha256').update(data).digest('hex'));
  });
});
