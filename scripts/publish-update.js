'use strict';

/**
 * 把 release/ 中的安装包与签名清单发布到更新目录
 *
 * 目标目录：--to <目录>，或环境变量 CLAUDE_PANEL_UPDATE_DIR，默认项目根下的 update/（已忽略，不进仓库）。
 * 0. 发布前校验：清单字段合法、签名能被内嵌公钥验证、安装包大小与 sha256 和清单一致；任一项不通过就中止
 * 1. 先拷安装包并校验字节数，最后才写 latest.json：客户端任何时刻都不会看到指向缺失安装包的清单
 * 2. 删除更新目录里本程序的旧版本安装包（只认 ClaudeNexus-Setup-v*.exe 和 ClaudePanel-Setup-v*.exe，不动目录里的其他文件）
 *
 * 用法：npm run publish-update [-- --to \\server\share\claude-panel]
 */

const fs = require('fs');
const path = require('path');
const {
  validateShape,
  verifySignature,
  sha256File,
} = require('../dist/main/update-manifest');
const { UPDATE_PUBLIC_KEYS } = require('../dist/main/update-pubkey');

const root = path.join(__dirname, '..');
const releaseDir = path.join(root, 'release');
const toIdx = process.argv.indexOf('--to');
const updateDir = path.resolve(
  (toIdx !== -1 && process.argv[toIdx + 1]) || process.env.CLAUDE_PANEL_UPDATE_DIR || path.join(root, 'update'),
);
const INSTALLER_PATTERN = /^Claude(?:Nexus|Panel)-Setup-v\d+\.\d+\.\d+\.exe$/;

function abort(message) {
  console.error(`[发布] ${message}，发布中止`);
  process.exit(1);
}

(async () => {
  const manifestPath = path.join(releaseDir, 'latest.json');
  if (!fs.existsSync(manifestPath)) abort('release/latest.json 不存在（未签名的出包不能发布）');

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    abort('latest.json 不是有效的 JSON');
  }
  if (!validateShape(manifest)) abort('latest.json 字段校验失败');
  if (!verifySignature(manifest, UPDATE_PUBLIC_KEYS)) abort('latest.json 签名无效');

  const srcExe = path.join(releaseDir, manifest.file);
  const destExe = path.join(updateDir, manifest.file);
  fs.mkdirSync(updateDir, { recursive: true });

  // 已发布且内容一致时跳过拷贝，便于重复执行
  const published = fs.existsSync(destExe)
    && fs.statSync(destExe).size === manifest.size
    && (await sha256File(destExe)) === manifest.sha256;

  if (published) {
    console.log(`[发布] ${manifest.file} 已在更新目录且校验一致，跳过拷贝`);
  } else {
    if (!fs.existsSync(srcExe)) abort(`release/ 中没有安装包 ${manifest.file}`);
    if (fs.statSync(srcExe).size !== manifest.size) abort('安装包大小与清单不一致');
    if ((await sha256File(srcExe)) !== manifest.sha256) abort('安装包 sha256 与清单不一致');
    fs.copyFileSync(srcExe, destExe);
    if (fs.statSync(destExe).size !== manifest.size) abort('拷贝后字节数与清单不一致');
    console.log(`[发布] ${manifest.file}`);
  }

  fs.copyFileSync(manifestPath, path.join(updateDir, 'latest.json'));
  console.log('[发布] latest.json');

  for (const f of fs.readdirSync(updateDir)) {
    if (f !== manifest.file && INSTALLER_PATTERN.test(f)) {
      fs.rmSync(path.join(updateDir, f), { force: true });
      console.log(`[清理] 旧安装包 ${f}`);
    }
  }

  console.log(`[发布] 更新目录：${updateDir}`);
  console.log(`[发布] 版本 v${manifest.version}，大小 ${(manifest.size / 1024 / 1024).toFixed(1)} MB`);
})().catch(err => {
  console.error(`[发布] 失败：${err.message}`);
  process.exit(1);
});
