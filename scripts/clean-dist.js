/**
 * 构建前清空 dist/，避免旧产物残留：
 * 渲染层输出目录调整、模块改名或删除后，旧的 .js 仍会留在 dist 里被误加载或打进安装包。
 * 只删除仓库根目录下的 dist，不触碰其他路径。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

if (path.dirname(DIST) !== ROOT || path.basename(DIST) !== 'dist') {
  console.error(`拒绝清理异常路径：${DIST}`);
  process.exit(1);
}

if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  console.log(`已清理 ${DIST}`);
}
