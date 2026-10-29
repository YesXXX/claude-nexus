// @ts-check
'use strict';
/**
 * 渲染层静态检查：npm run check
 *
 * 渲染层没有打包器，浏览器按相对路径逐个加载 ESM 模块，下面这些问题只会在运行时以白屏暴露，
 * 所以在构建之外单独拦截：
 *   1. 相对路径的运行时导入必须带 .js 后缀（漏写会 404）
 *   2. 只用于类型的导入必须写 import type（借 tsc 的 verbatimModuleSyntax 诊断，只统计渲染层文件）
 *   3. 运行时导入不得成环（ESM 环会导致顶层变量在初始化前被读取）
 *   4. 分层规则：低层不导入高层（含类型导入）
 *   5. 行数上限：每个文件不超过 500 行，入口 renderer.ts 不超过 300 行
 *   6. tests/e2e 不得导入 src/renderer 下的模块（用例只做黑盒断言）
 *   7. 样式表 :root 与皮肤块之外、index.html 里不得写颜色字面量（换肤只换变量）
 * 另有注释规范检查（HTML 标签、任务编号），只输出警告，不影响退出码。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const RENDERER = path.join(SRC, 'renderer');
const SHARED = path.join(SRC, 'shared');
const E2E = path.join(ROOT, 'tests', 'e2e');

const MAX_LINES = 500;
const ENTRY_MAX_LINES = 300;
/**
 * 行数临时豁免（相对 src/renderer 的路径）：只用于大文件拆分过程中，拆完即从这里移除，平时应为空。
 * @type {Set<string>}
 */
const LINE_EXEMPT = new Set();

/**
 * 分层表：每层可导入的层。同层之间允许导入（由成环检测保证无环）。
 * features 只依赖 core 与 ui，通过注入的 api 与回调工作，保持可以单独搬走。
 */
/** @type {Record<string, string[]>} */
const ALLOWED = {
  shared: ['shared'],
  core: ['shared', 'core'],
  ui: ['shared', 'core', 'ui'],
  term: ['shared', 'core', 'ui', 'term'],
  actions: ['shared', 'core', 'ui', 'term', 'actions'],
  features: ['shared', 'core', 'ui', 'features'],
  views: ['shared', 'core', 'ui', 'term', 'actions', 'features', 'views', 'input'],
  input: ['shared', 'core', 'ui', 'term', 'actions', 'features', 'views', 'input'],
  builtin: ['shared', 'core', 'ui', 'term', 'actions', 'features', 'views', 'input', 'builtin'],
  entry: ['shared', 'core', 'ui', 'term', 'actions', 'features', 'views', 'input', 'builtin'],
};
const LAYER_DIRS = new Set(['core', 'ui', 'term', 'actions', 'features', 'views', 'input', 'builtin']);

/** @param {string} p */
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');

/** @param {string} dir @returns {string[]} */
function listTs(dir) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'vendor' || ent.name === 'node_modules') continue;
      out.push(...listTs(p));
    } else if (ent.isFile() && /\.ts$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 文件所属层；无法归类时返回 null。
 * 渲染层根目录只允许入口 renderer.ts，其余模块必须放进分层目录。
 * @param {string} file
 */
function layerOf(file) {
  if (file.startsWith(SHARED + path.sep)) return 'shared';
  if (!file.startsWith(RENDERER + path.sep)) return null;
  const parts = path.relative(RENDERER, file).split(path.sep);
  if (parts.length === 1) return parts[0] === 'renderer.ts' ? 'entry' : null;
  return LAYER_DIRS.has(parts[0]) ? parts[0] : null;
}

/**
 * @typedef {{ spec: string, typeOnly: boolean, line: number }} ImportRef
 */

/**
 * 解析 import / export ... from 与副作用导入、动态导入。
 * 只认行首的语句，注释掉的导入不会被当真。
 * @param {string} text
 * @returns {ImportRef[]}
 */
function parseImports(text) {
  /** @type {ImportRef[]} */
  const out = [];
  const lineAt = (/** @type {number} */ idx) => text.slice(0, idx).split('\n').length;
  const fromRe = /^[ \t]*(import|export)\s+(type\s+)?([^;'"`]*?)\s*from\s*['"]([^'"]+)['"]/gm;
  let m;
  while ((m = fromRe.exec(text))) {
    const clause = m[3].trim();
    let typeOnly = Boolean(m[2]);
    if (!typeOnly) {
      // 花括号内全部是 type 修饰的具名导入且没有默认或命名空间导入时，编译后整条语句被擦除
      const braces = clause.match(/^\{([\s\S]*)\}$/);
      if (braces) {
        const names = braces[1].split(',').map(s => s.trim()).filter(Boolean);
        typeOnly = names.length > 0 && names.every(n => /^type\s/.test(n));
      }
    }
    out.push({ spec: m[4], typeOnly, line: lineAt(m.index) });
  }
  const bareRe = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
  while ((m = bareRe.exec(text))) out.push({ spec: m[1], typeOnly: false, line: lineAt(m.index) });
  const dynRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(text))) out.push({ spec: m[1], typeOnly: false, line: lineAt(m.index) });
  return out;
}

/**
 * 相对导入解析到源文件：x.js → x.ts；无后缀时按 x.ts、x/index.ts 尝试（只用于定位，不代表允许省略后缀）
 * @param {string} from @param {string} spec
 */
function resolveSpec(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  const candidates = spec.endsWith('.js')
    ? [base.slice(0, -3) + '.ts']
    : [base + '.ts', path.join(base, 'index.ts'), base];
  return candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

/** @type {string[]} */
const errors = [];
/** @type {string[]} */
const warnings = [];

const files = [...listTs(RENDERER), ...listTs(SHARED)];
/** @type {Map<string, string[]>} 运行时依赖图（只含渲染层与 shared 内部的相对导入） */
const graph = new Map();

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const isRenderer = file.startsWith(RENDERER + path.sep);
  const layer = layerOf(file);
  if (isRenderer && !layer) errors.push(`${rel(file)}：所在目录不在分层表中（允许 core / ui / term / actions / features / views / input / builtin）`);

  /** @type {string[]} */
  const deps = [];
  for (const imp of parseImports(text)) {
    if (!imp.spec.startsWith('.')) continue;
    const where = `${rel(file)}:${imp.line}`;
    if (isRenderer && !imp.typeOnly && !imp.spec.endsWith('.js')) {
      errors.push(`${where}：相对路径的运行时导入必须带 .js 后缀（'${imp.spec}'），否则浏览器加载时 404`);
    }
    const target = resolveSpec(file, imp.spec);
    if (!target) {
      if (isRenderer) errors.push(`${where}：导入目标不存在（'${imp.spec}'）`);
      continue;
    }
    const targetLayer = layerOf(target);
    if (layer && targetLayer && !(ALLOWED[layer] ?? []).includes(targetLayer)) {
      errors.push(`${where}：分层违规，${layer} 层不能导入 ${targetLayer} 层（${rel(target)}）`);
    }
    if (!imp.typeOnly) deps.push(target);
  }
  graph.set(file, deps);

  if (isRenderer) {
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    const name = path.relative(RENDERER, file).split(path.sep).join('/');
    const limit = name === 'renderer.ts' ? ENTRY_MAX_LINES : MAX_LINES;
    if (lines > limit && !LINE_EXEMPT.has(name)) errors.push(`${rel(file)}：${lines} 行，超过上限 ${limit} 行`);
    checkComments(file, text);
  }
}

// ---- 依赖环：Tarjan 强连通分量，大小 > 1 或自环即为环 ----
{
  let index = 0;
  /** @type {Map<string, number>} */ const idx = new Map();
  /** @type {Map<string, number>} */ const low = new Map();
  /** @type {string[]} */ const stack = [];
  const onStack = new Set();
  /** @type {string[][]} */ const cycles = [];
  /** @param {string} v */
  const strong = v => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v) ?? 0, idx.get(w) ?? 0));
    }
    if (low.get(v) === idx.get(v)) {
      /** @type {string[]} */ const comp = [];
      let w;
      do { w = /** @type {string} */ (stack.pop()); onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || (graph.get(v) ?? []).includes(v)) cycles.push(comp);
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) strong(v);
  for (const c of cycles) errors.push(`运行时导入成环：${c.map(rel).sort().join(' ↔ ')}`);
}

// ---- 只用于类型的导入：tsc 以 verbatimModuleSyntax 诊断，只统计渲染层文件 ----
{
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.renderer.json', '--noEmit', '--verbatimModuleSyntax', '--pretty', 'false'],
    { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error) errors.push(`无法运行 tsc：${r.error.message}`);
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(src[\\/]renderer[\\/][^(]+)\((\d+),\d+\): error TS148[45]: '([^']+)'/);
    if (m) errors.push(`${m[1].split('\\').join('/')}:${m[2]}：'${m[3]}' 只用于类型，应写 import type`);
  }
}

// ---- 用例只做黑盒：tests/e2e 不导入渲染层模块 ----
for (const file of listTs(E2E)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const imp of parseImports(text)) {
    if (!imp.spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), imp.spec);
    if (target === RENDERER || target.startsWith(RENDERER + path.sep)) {
      errors.push(`${rel(file)}:${imp.line}：e2e 用例不能导入渲染层模块（'${imp.spec}'），只能通过 DOM 与 window.panelApi 断言`);
    }
  }
}

/**
 * 注释规范（只警告）：不写 HTML 标签与任务、计划编号，注释只描述功能与逻辑。
 * 只做粗略提取：块注释与行尾注释，字符串里的 // 可能误报，所以不阻断。
 * @param {string} file @param {string} text
 */
function checkComments(file, text) {
  const html = /<\/?(b|i|p|br|ul|ol|li|em|strong|code|pre|div|span)\b[^>]*>/i;
  const plan = /(\b[PBCDEGST]\d{1,2}(?:-\d+)?\b|计划\s*\d|阶段[一二三四五六七八九十]|防线[①②③④⑤])/;
  const lines = text.split('\n');
  let inBlock = false;
  lines.forEach((line, i) => {
    /** @type {string[]} */
    const parts = [];
    let rest = line;
    if (inBlock) {
      const end = rest.indexOf('*/');
      if (end < 0) { parts.push(rest); rest = ''; } else { parts.push(rest.slice(0, end)); rest = rest.slice(end + 2); inBlock = false; }
    }
    const start = rest.search(/\/\*/);
    if (start >= 0) {
      const end = rest.indexOf('*/', start + 2);
      if (end < 0) { parts.push(rest.slice(start + 2)); inBlock = true; } else parts.push(rest.slice(start + 2, end));
    }
    const lc = rest.match(/(?:^|\s)\/\/(.*)$/);
    if (lc) parts.push(lc[1]);
    for (const c of parts) {
      if (html.test(c)) warnings.push(`${rel(file)}:${i + 1}：注释中出现 HTML 标签`);
      if (plan.test(c)) warnings.push(`${rel(file)}:${i + 1}：注释中出现任务或计划编号`);
    }
  });
}

/**
 * 颜色只写成变量：渲染层样式表里 :root 块之外不得出现 #hex 与 rgb()/rgba() 数字字面量，
 * 换肤时只需替换变量值（renderer.css 的 :root 默认值与 skins.css 的各皮肤块）。rgb(var(--x-rgb) / 透明度) 这种引用变量的写法不算字面量。
 */
/** @param {string} dir @returns {string[]} */
function listCss(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') out.push(...listCss(p)); } else if (e.name.endsWith('.css')) out.push(p);
  }
  return out;
}
for (const file of listCss(RENDERER)) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  // 注释与 :root、:root[data-skin="…"] 块替换成等长空白，保留行号
  const blank = (/** @type {string} */ s) => s.replace(/[^\n]/g, ' ');
  const body = text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|\n):root(\[[^\]\n]*\])?\s*\{[\s\S]*?\n\}/g, blank);
  body.split('\n').forEach((line, i) => {
    const m = line.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/);
    if (m) errors.push(`${rel(file)}:${i + 1}：颜色字面量（${m[0]}…）应改成 renderer.css :root 里的变量`);
  });
}
// index.html 的内联 SVG 同样只用变量（style="stroke:var(--…)" 或 currentColor）；HTML 注释不查
{
  const file = path.join(RENDERER, 'index.html');
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, s => s.replace(/[^\n]/g, ' '));
  text.split('\n').forEach((line, i) => {
    const m = line.match(/(?:fill|stroke|color|style)\s*=\s*"[^"]*(#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d)/);
    if (m) errors.push(`${rel(file)}:${i + 1}：颜色字面量（${m[1]}…）应改成 renderer.css :root 里的变量`);
  });
}

for (const w of warnings) console.warn(`[check] 警告 ${w}`);
for (const e of errors) console.error(`[check] ${e}`);
const rendererCount = files.filter(f => f.startsWith(RENDERER + path.sep)).length;
if (errors.length) {
  console.error(`[check] 失败：${errors.length} 个问题（渲染层 ${rendererCount} 个文件）`);
  process.exit(1);
}
console.log(`[check] 通过：渲染层 ${rendererCount} 个文件，依赖环 0，警告 ${warnings.length}`);
