import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 更新清单结构校验与签名规范化。
 * 主进程更新模块与 scripts 下的出包、发布脚本（经 dist 编译产物）共用这一份规则，保证签名与验签一致。
 */

/** 签名域标识：防止同一把私钥签出的其他数据被当成更新清单 */
export const SIG_DOMAIN = 'claude-panel-update-v1';

export interface UpdateManifest {
  productName: string;
  version: string;
  /** 安装包文件名，必须直接位于更新目录内（不含路径） */
  file: string;
  size: number;
  sha256: string;
  notes?: string;
  pubDate: string;
  sigAlg?: string;
  keyId?: string;
  signature?: string;
}

export interface UpdatePublicKey {
  keyId: string;
  pem: string;
}

/** 结构与类型校验：任一字段不合法即视为无效清单 */
export function validateShape(m: unknown): m is UpdateManifest {
  if (!m || typeof m !== 'object') return false;
  const x = m as Record<string, unknown>;
  return typeof x.productName === 'string'
    && typeof x.version === 'string' && /^\d+\.\d+\.\d+$/.test(x.version)
    && typeof x.file === 'string' && x.file === path.basename(x.file) && /\.exe$/i.test(x.file)
    && Number.isSafeInteger(x.size) && (x.size as number) > 0
    && typeof x.sha256 === 'string' && /^[0-9a-f]{64}$/.test(x.sha256)
    && typeof x.pubDate === 'string'
    && (x.notes === undefined || typeof x.notes === 'string');
}

/**
 * 规范化签名载荷：固定顺序的数组避免对象键序歧义；
 * 更新说明一并签名，防止被篡改后用来诱导用户
 */
export function canonicalize(m: UpdateManifest): Buffer {
  return Buffer.from(JSON.stringify([
    SIG_DOMAIN, m.productName, m.version, m.file, m.size, m.sha256, m.notes ?? '', m.pubDate,
  ]), 'utf8');
}

/** 由公钥计算 keyId（SPKI DER 的 sha256 前 16 位十六进制） */
export function keyIdOf(publicKey: crypto.KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** 用公钥列表验签，只返回布尔值，不抛异常 */
export function verifySignature(m: UpdateManifest, publicKeys: readonly UpdatePublicKey[]): boolean {
  if (m.sigAlg !== 'ed25519' || typeof m.signature !== 'string' || typeof m.keyId !== 'string') return false;
  const entry = publicKeys.find(k => k.keyId === m.keyId);
  if (!entry) return false;
  try {
    return crypto.verify(null, canonicalize(m), crypto.createPublicKey(entry.pem), Buffer.from(m.signature, 'base64'));
  } catch {
    return false;
  }
}

/** 用私钥给清单签名（就地写入 sigAlg / keyId / signature） */
export function signManifest(m: UpdateManifest, privateKey: crypto.KeyObject): UpdateManifest {
  m.sigAlg = 'ed25519';
  m.keyId = keyIdOf(crypto.createPublicKey(privateKey));
  m.signature = crypto.sign(null, canonicalize(m), privateKey).toString('base64');
  return m;
}

/** 流式计算文件 sha256（十六进制） */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 比较两个 x.y.z 版本号：a > b 返回 1，a < b 返回 -1，相等返回 0。
 * 按段数值比较（1.0.9 < 1.0.10），缺少的段按 0 补齐
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i], 10) || 0;
    const nb = parseInt(pb[i], 10) || 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}
