'use strict';

/**
 * 出包后生成带签名的更新清单 release/latest.json
 *
 * 读取 package.json 版本号，在 release/ 中定位本次构建的安装包，计算大小与 sha256，
 * 连同更新说明一起用 Ed25519 私钥签名后写入 release/latest.json。
 * 发版时把「安装包 + latest.json」放进更新目录即可（npm run publish-update）。
 *
 * 私钥路径：环境变量 CLAUDE_PANEL_SIGN_KEY，默认 %USERPROFILE%\.claude-panel-signing\update-ed25519.pem；
 * 私钥加了口令时从 CLAUDE_PANEL_SIGN_KEY_PASS 读取。
 * 找不到私钥时以非零退出码结束（避免发布出客户端会拒收的未签名清单）；
 * 仅本地验证出包时可加 --unsigned，生成 latest.unsigned.json（禁止发布）。
 *
 * 更新说明默认取 更新说明/v<版本号>.md，可用 --notes <文件> 指定。
 * 依赖 dist 下的编译产物（npm run dist 已先 build）。
 * 用法：node scripts/gen-update-manifest.js [--notes <更新说明文件>] [--unsigned]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  validateShape,
  verifySignature,
  signManifest,
  sha256File,
} = require('../dist/main/update-manifest');
const { UPDATE_PUBLIC_KEYS } = require('../dist/main/update-pubkey');

const root = path.join(__dirname, '..');
const releaseDir = path.join(root, 'release');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const productName = 'Claude Nexus';
// 必须与 electron-builder.yml 的 nsis.artifactName 保持一致
const installerName = `ClaudeNexus-Setup-v${version}.exe`;
const installerPath = path.join(releaseDir, installerName);

if (!fs.existsSync(installerPath)) {
  console.error(`[更新清单] 未找到安装包：${installerPath}`);
  console.error('[更新清单] 请确认已执行 electron-builder 出包，release/ 目录现有内容：');
  try {
    for (const f of fs.readdirSync(releaseDir)) console.error(`  - ${f}`);
  } catch {
    console.error('  （release/ 目录不存在）');
  }
  process.exit(1);
}

let notesFile = path.join(root, '更新说明', `v${version}.md`);
const notesIdx = process.argv.indexOf('--notes');
if (notesIdx !== -1 && process.argv[notesIdx + 1]) notesFile = path.resolve(process.argv[notesIdx + 1]);
const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim() : '';

const allowUnsigned = process.argv.includes('--unsigned');
const keyPath = process.env.CLAUDE_PANEL_SIGN_KEY
  || path.join(os.homedir(), '.claude-panel-signing', 'update-ed25519.pem');

(async () => {
  const manifest = {
    productName,
    version,
    file: installerName,
    size: fs.statSync(installerPath).size,
    sha256: await sha256File(installerPath),
    notes,
    pubDate: new Date().toISOString(),
  };

  if (!validateShape(manifest)) {
    console.error('[更新清单] 字段校验失败（版本号需为 x.y.z，安装包需为 .exe）');
    process.exit(1);
  }

  const manifestPath = path.join(releaseDir, 'latest.json');
  // 先删掉上次的清单：本次签名失败时 release/ 里不会留下可被误发布的旧清单
  fs.rmSync(manifestPath, { force: true });

  if (!fs.existsSync(keyPath)) {
    if (!allowUnsigned) {
      console.error(`[更新清单] 未找到签名私钥：${keyPath}`);
      console.error('[更新清单] 请设置 CLAUDE_PANEL_SIGN_KEY 或先运行 npm run keygen；仅本地验证出包可加 --unsigned');
      process.exit(1);
    }
    const unsignedPath = path.join(releaseDir, 'latest.unsigned.json');
    fs.writeFileSync(unsignedPath, JSON.stringify(manifest, null, 2), 'utf8');
    console.warn(`[更新清单] 已生成未签名清单 ${unsignedPath}（客户端会拒收，禁止发布）`);
    return;
  }

  const privateKey = crypto.createPrivateKey({
    key: fs.readFileSync(keyPath),
    passphrase: process.env.CLAUDE_PANEL_SIGN_KEY_PASS || undefined,
  });
  signManifest(manifest, privateKey);

  // 自检：签名必须能被内嵌公钥验证通过，否则说明私钥与 update-pubkey.ts 不匹配（或改完公钥没重新 build）
  if (!verifySignature(manifest, UPDATE_PUBLIC_KEYS)) {
    console.error('[更新清单] 签名自检失败：私钥与 src/main/update-pubkey.ts 中的公钥不匹配');
    process.exit(1);
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[更新清单] 已生成并签名 release/latest.json（keyId=${manifest.keyId}）`);
  console.log(`[更新清单] 版本 v${version}，安装包 ${installerName}（${(manifest.size / 1024 / 1024).toFixed(1)} MB）`);
  console.log(`[更新清单] 更新说明来源：${notes ? notesFile : '（无，留空）'}`);
})().catch(err => {
  console.error(`[更新清单] 生成失败：${err.message}`);
  process.exit(1);
});
