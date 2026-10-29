'use strict';

/**
 * 生成更新清单签名用的 Ed25519 密钥对
 *
 * 私钥写到仓库之外：路径由环境变量 CLAUDE_PANEL_SIGN_KEY 指定，默认 %USERPROFILE%\.claude-panel-signing\update-ed25519.pem
 * 公钥写入 src/main/update-pubkey.ts（公钥不是秘密，随安装包分发，客户端用它验签）。
 *
 * 私钥已存在时拒绝覆盖；确需重新生成时加 --force。
 * 注意：重新生成后，内嵌旧公钥的客户端无法验证新签名，只能手动安装新版本。
 *
 * 依赖 dist 下的编译产物（npm run keygen 会先 build）。
 * 用法：npm run keygen [-- --force]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { keyIdOf } = require('../dist/main/update-manifest');

const keyPath = process.env.CLAUDE_PANEL_SIGN_KEY
  || path.join(os.homedir(), '.claude-panel-signing', 'update-ed25519.pem');
const pubkeyModule = path.join(__dirname, '..', 'src', 'main', 'update-pubkey.ts');
const force = process.argv.includes('--force');

if (fs.existsSync(keyPath) && !force) {
  console.error(`[密钥] 私钥已存在：${keyPath}`);
  console.error('[密钥] 拒绝覆盖。确需重新生成请加 --force（旧客户端将无法验证新签名）');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const keyId = keyIdOf(publicKey);

fs.mkdirSync(path.dirname(keyPath), { recursive: true });
fs.writeFileSync(keyPath, privatePem, { mode: 0o600 });

/**
 * Windows 上 mode 0o600 不生效，改用 icacls 收紧为仅当前用户可访问。
 * 目录授权必须带 (OI)(CI) 继承标记，否则断开继承后目录下的文件没有任何 ACE，连本人都读不了
 */
function restrictAclOnWindows() {
  if (process.platform !== 'win32') return true;
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const dir = path.dirname(keyPath);
  const steps = [
    [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`],
    [keyPath, '/inheritance:r', '/grant:r', `${user}:F`],
  ];
  for (const args of steps) {
    const r = spawnSync('icacls', args, { stdio: 'ignore' });
    if (r.status !== 0) return false;
  }
  try {
    crypto.createPrivateKey(fs.readFileSync(keyPath));
    return true;
  } catch {
    return false;
  }
}
const aclOk = restrictAclOnWindows();

const moduleSource = `import type { UpdatePublicKey } from './update-manifest';

/**
 * 更新清单验签公钥（由 npm run keygen 生成）。
 * 公钥不是秘密，可以提交、打包。支持多把以便轮换：
 * 先发布一个用旧私钥签名、同时内嵌新旧两把公钥的版本，下一个版本再移除旧公钥。
 */
export const UPDATE_PUBLIC_KEYS: UpdatePublicKey[] = [
  {
    keyId: '${keyId}',
    pem: ${JSON.stringify(publicPem)},
  },
];
`;
fs.writeFileSync(pubkeyModule, moduleSource, 'utf8');

console.log(`[密钥] 私钥已写入：${keyPath}`);
console.log(`[密钥] 公钥已写入：${pubkeyModule}（keyId=${keyId}）`);
if (aclOk) {
  console.log('[密钥] 私钥目录已收紧为仅当前用户可访问');
} else {
  console.warn('[密钥] 收紧私钥目录权限失败，请手动处理：');
  console.warn(`  icacls "${path.dirname(keyPath)}" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" /T`);
}
console.log('[密钥] 请把私钥离线备份两份。私钥丢失后，已安装的客户端无法再自动更新');
