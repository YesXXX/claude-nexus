'use strict';

/**
 * 把 release/ 中的安装包与签名清单发布到 GitHub Releases
 *
 * 0. 发布前校验与 publish-update 相同：清单字段合法、签名能被内嵌公钥验证、安装包大小与 sha256 和清单一致
 * 1. 要求 v<版本号> tag 已推送到 GitHub（Release 挂在已有 tag 上，不让 GitHub 在默认分支上自动打 tag）
 * 2. 同名 Release 不存在时新建，默认草稿，加 --publish 直接公开；Release 正文取清单里已签名的更新说明
 * 3. 上传安装包、latest.json 与 SHA256SUMS.txt；同名且大小一致的附件跳过，大小不一致的先删再传
 *
 * 认证：环境变量 GITHUB_TOKEN（需要该仓库 contents 写权限）。
 * 仓库：环境变量 GITHUB_REPOSITORY（owner/repo），缺省取 package.json 的 repository.url。
 * --dry-run 只做本地校验并打印将要执行的操作，不访问网络。
 *
 * 用法：npm run publish-github [-- --publish] [-- --dry-run]
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
const dryRun = process.argv.includes('--dry-run');
const publish = process.argv.includes('--publish');
const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

function abort(message) {
  console.error(`[GitHub 发布] ${message}，发布中止`);
  process.exit(1);
}

/** 从 owner/repo 或 git URL（https / ssh，带不带 .git）解析出 owner/repo */
function parseRepo(value) {
  const m = /(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(value || '');
  return m ? `${m[1]}/${m[2]}` : null;
}

function resolveRepo() {
  if (process.env.GITHUB_REPOSITORY) return parseRepo(process.env.GITHUB_REPOSITORY);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;
  return parseRepo(url);
}

async function api(token, method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'claude-nexus-publish',
      ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${url} → HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? {} : res.json();
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

  const exePath = path.join(releaseDir, manifest.file);
  if (!fs.existsSync(exePath)) abort(`release/ 中没有安装包 ${manifest.file}`);
  if (fs.statSync(exePath).size !== manifest.size) abort('安装包大小与清单不一致');
  if ((await sha256File(exePath)) !== manifest.sha256) abort('安装包 sha256 与清单不一致');

  const repo = resolveRepo();
  if (!repo) abort('无法确定仓库：请设置 GITHUB_REPOSITORY=owner/repo 或在 package.json 填写 repository.url');
  const tag = `v${manifest.version}`;
  const sums = Buffer.from(`${manifest.sha256}  ${manifest.file}\n`, 'utf8');
  const assets = [
    { name: manifest.file, data: () => fs.readFileSync(exePath), size: manifest.size, type: 'application/octet-stream' },
    { name: 'latest.json', data: () => fs.readFileSync(manifestPath), size: fs.statSync(manifestPath).size, type: 'application/json' },
    { name: 'SHA256SUMS.txt', data: () => sums, size: sums.length, type: 'text/plain' },
  ];

  console.log(`[GitHub 发布] 仓库 ${repo}，tag ${tag}，${publish ? '直接公开' : '草稿'}`);
  for (const a of assets) console.log(`[GitHub 发布] 附件 ${a.name}（${(a.size / 1024 / 1024).toFixed(1)} MB）`);
  if (dryRun) {
    console.log('[GitHub 发布] --dry-run：本地校验通过，未访问网络');
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) abort('未设置 GITHUB_TOKEN');

  if (!(await api(token, 'GET', `${API}/repos/${repo}/git/ref/tags/${tag}`))) {
    abort(`GitHub 上没有 tag ${tag}，请先 git push <远端> ${tag}`);
  }

  let release = await api(token, 'GET', `${API}/repos/${repo}/releases/tags/${tag}`);
  if (!release) {
    // 草稿 Release 按 tag 查不到，再从列表里找同名草稿，避免重复执行时建出多个草稿
    const list = (await api(token, 'GET', `${API}/repos/${repo}/releases?per_page=30`)) || [];
    release = list.find(r => r.tag_name === tag) || null;
  }
  if (release) {
    console.log(`[GitHub 发布] 沿用已有 Release #${release.id}`);
  } else {
    release = await api(token, 'POST', `${API}/repos/${repo}/releases`, {
      tag_name: tag,
      name: `Claude Nexus ${tag}`,
      body: manifest.notes || '',
      draft: !publish,
    });
    console.log(`[GitHub 发布] 已创建 Release #${release.id}`);
  }

  const existing = (await api(token, 'GET', `${API}/repos/${repo}/releases/${release.id}/assets?per_page=100`)) || [];
  for (const a of assets) {
    const old = existing.find(e => e.name === a.name);
    if (old && old.size === a.size) {
      console.log(`[GitHub 发布] ${a.name} 已存在且大小一致，跳过`);
      continue;
    }
    if (old) await api(token, 'DELETE', `${API}/repos/${repo}/releases/assets/${old.id}`);
    await api(
      token,
      'POST',
      `${UPLOADS}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(a.name)}`,
      a.data(),
      { 'Content-Type': a.type },
    );
    console.log(`[GitHub 发布] 已上传 ${a.name}`);
  }

  if (publish && release.draft) {
    await api(token, 'PATCH', `${API}/repos/${repo}/releases/${release.id}`, { draft: false });
    console.log('[GitHub 发布] 草稿已公开');
  }
  console.log(`[GitHub 发布] 完成：${release.html_url}`);
})().catch(err => {
  console.error(`[GitHub 发布] 失败：${err.message}`);
  process.exit(1);
});
