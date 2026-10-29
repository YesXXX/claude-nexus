/**
 * tsc 不会复制 .html/.css/.png 等资源。Electron 运行时从 dist/web/renderer/ 加载，
 * 所以必须把 src/renderer 下（含子目录）除 .ts/.js 之外的资源原样复制到 dist/web/renderer/。
 * *.ts 由 tsc 编译为 *.js，无需此处处理。
 * 同时把浏览器端依赖（ansi_up、xterm）复制到 dist/web/renderer/vendor/，方便 renderer 用相对路径 import。
 */
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src', 'renderer');
const OUT_DIR = path.join(__dirname, '..', 'dist', 'web', 'renderer');
const VENDOR_DIR = path.join(OUT_DIR, 'vendor');

if (!fs.existsSync(SRC_DIR)) {
  console.error(`源目录不存在：${SRC_DIR}`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(VENDOR_DIR, { recursive: true });

const copy = (src, dst, label) => {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`已复制 ${label ?? path.basename(src)}`);
};

/** 递归复制资源文件，相对路径保持不变 */
const copyAssets = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const src = path.join(dir, ent.name);
    if (ent.isDirectory()) { copyAssets(src); continue; }
    if (!ent.isFile()) continue;
    if (ent.name.endsWith('.ts') || ent.name.endsWith('.js')) continue;
    const rel = path.relative(SRC_DIR, src);
    copy(src, path.join(OUT_DIR, rel), rel.split(path.sep).join('/'));
  }
};
copyAssets(SRC_DIR);

// 浏览器端依赖
const vendorModules = [
  { name: 'ansi_up', src: path.join(__dirname, '..', 'node_modules', 'ansi_up', 'ansi_up.js'),
    dst: path.join(VENDOR_DIR, 'ansi_up.js') },
  { name: '@xterm/xterm', src: path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.mjs'),
    dst: path.join(VENDOR_DIR, 'xterm.mjs') },
  { name: '@xterm/xterm css', src: path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
    dst: path.join(VENDOR_DIR, 'xterm.css') },
  { name: '@xterm/addon-fit', src: path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.mjs'),
    dst: path.join(VENDOR_DIR, 'addon-fit.mjs') },
  { name: '@xterm/addon-search', src: path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-search', 'lib', 'addon-search.mjs'),
    dst: path.join(VENDOR_DIR, 'addon-search.mjs') },
];
for (const m of vendorModules) {
  if (fs.existsSync(m.src)) {
    fs.copyFileSync(m.src, m.dst);
    console.log(`已复制 vendor/${path.basename(m.dst)}`);
  } else {
    console.warn(`vendor 模块缺失：${m.src}`);
  }
}

console.log(`资源复制完成 → ${OUT_DIR}`);
