'use strict';

/**
 * 生成 Claude Nexus 全尺寸图标
 *
 * 图标设计：一笔连成的 N 字形（四节点三段折线），白色/浅灰渐变笔画，
 * 圆角深色底板上绘制。代表 Nexus（中枢连结点）。
 *
 * 产出：
 *   assets/tray.png       — 32×32 托盘图标（白色笔画，透明底）
 *   build/icon.png        — 512×512 应用图标（深色底板 + 白色 N）
 *   build/icon.ico        — 多尺寸 Windows ICO（16/32/48/64/128/256）
 *
 * 用法：node scripts/gen-icon.js
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { imagesToIco } = require('png-to-ico');

const root = path.join(__dirname, '..');
const assetsDir = path.join(root, 'assets');
const buildDir = path.join(root, 'build');
fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(buildDir, { recursive: true });

/**
 * 应用图标 SVG：深色圆角底板 + 白色 N 字形笔画
 * @param {number} s 画布尺寸（正方形边长）
 */
function appIconSvg(s) {
  const r = Math.round(s * 0.22);       // 圆角半径
  const sw = Math.round(s * 0.085);     // 笔画宽度
  const pad = Math.round(s * 0.22);     // 内边距
  const x1 = pad;
  const x2 = s - pad;
  const yTop = pad;
  const yBot = s - pad;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1e1e1e"/>
      <stop offset="1" stop-color="#0e0e0e"/>
    </linearGradient>
    <linearGradient id="stroke" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#b8b8b8"/>
    </linearGradient>
  </defs>
  <rect width="${s}" height="${s}" rx="${r}" fill="url(#bg)"/>
  <polyline points="${x1},${yBot} ${x1},${yTop} ${x2},${yBot} ${x2},${yTop}"
    fill="none" stroke="url(#stroke)" stroke-width="${sw}"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

/**
 * 托盘图标 SVG：无底板，白色 N 字形笔画，透明背景
 * @param {number} s 画布尺寸
 */
function traySvg(s) {
  const sw = Math.max(2, Math.round(s * 0.12));
  const pad = Math.round(s * 0.12);
  const x1 = pad;
  const x2 = s - pad;
  const yTop = pad;
  const yBot = s - pad;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <polyline points="${x1},${yBot} ${x1},${yTop} ${x2},${yBot} ${x2},${yTop}"
    fill="none" stroke="#e8e8e8" stroke-width="${sw}"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

async function main() {
  // 1. 托盘图标 32×32
  const trayBuf = await sharp(Buffer.from(traySvg(32))).png().toBuffer();
  fs.writeFileSync(path.join(assetsDir, 'tray.png'), trayBuf);
  console.log('[图标] assets/tray.png (32×32)');

  // 2. 应用图标 512×512
  const appBuf = await sharp(Buffer.from(appIconSvg(512))).png().toBuffer();
  fs.writeFileSync(path.join(buildDir, 'icon.png'), appBuf);
  console.log('[图标] build/icon.png (512×512)');

  // 3. 生成多尺寸原始 RGBA 图像用于 ICO（png-to-ico 需要 { data, width, height } 对象）
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = [];
  for (const sz of sizes) {
    const { data, info } = await sharp(Buffer.from(appIconSvg(sz)))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    images.push({ data, width: info.width, height: info.height });
  }
  const icoBuf = await imagesToIco(images);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), icoBuf);
  console.log(`[图标] build/icon.ico (${sizes.join('/')})`);

  console.log('[图标] 全部生成完成');
}

main().catch(err => { console.error(err); process.exit(1); });
