import { describe, it, expect } from 'vitest';
import { useApp } from './harness';
import { createSessionViaForm, initGitRepo, switchChangesScope, waitOutput, writeFiles } from './fixtures';

/**
 * diff 语法高亮与词级差异：各语言着色、跨行结构、词级变化标记、纯文本扩展名、
 * 不可信内容按纯文本显示、超大文件关闭高亮、5000 行 diff 的首屏耗时与长任务、懒绘制。
 */

const TS_OLD = [
  '// 用户服务',
  'export class UserService {',
  '  private repo = getRepo();',
  '  private cache = new Map();',
  '  /* 多行注释',
  '     第二行 */',
  '  find(id: string) {',
  '    return repo.findAll();',
  '  }',
  '}',
  '',
].join('\n');

const TS_NEW = TS_OLD
  .replace('new Map()', 'new LruCache()')
  .replace('    return repo.findAll();', '    throw new Error("x");\n    const s = `a ${id} b`;');

// 全部行都改：删增各 2450 行，diff 共 4900 行，贴近 5000 行的截断上限
const PERF_N = 2450;
const perfLines = (bump: number): string =>
  Array.from({ length: PERF_N }, (_, i) => `const value${i} = compute(${i + bump}); // 注释 ${i}`).join('\n') + '\n';

const bigFile = (): string =>
  Array.from({ length: 4500 }, (_, i) => `export const item${String(i).padStart(5, '0')} = "${'x'.repeat(70)}";`).join('\n') + '\n';

describe('diff 语法高亮', () => {
  const app = useApp();
  let repo = '';
  let sid = '';

  const select = async (p: string): Promise<void> => {
    await app.click(`.chg-list .chg-row[title=${JSON.stringify(p)}]`);
    await app.waitFor(`(document.querySelector('.chg-diff-path')?.dataset.addr ?? '').replace(/\\\\/g, '/').endsWith(${JSON.stringify(`/${p}`)})
      && !!document.querySelector('.chg-diff-scroll .chg-code, .chg-diff-scroll .chg-placeholder')`, { message: `diff 显示 ${p}` });
  };

  /** 某类着色片段的文本 */
  const syn = (k: string) => app.eval<string[]>(
    `[...document.querySelectorAll('.chg-diff-scroll .syn-${k}')].map(e => e.textContent)`);
  const intra = (kind: 'add' | 'del') => app.eval<string[]>(
    `[...document.querySelectorAll('.chg-diff-scroll .chg-ln.${kind} .chg-intra')].map(e => e.textContent)`);

  it('准备仓库与会话，打开改动页', async () => {
    repo = initGitRepo(app, 'proj-syntax', {
      'a.ts': TS_OLD,
      'b.py': 'def f():\n    return 1\n',
      'c.vue': '<template>\n  <div>{{ msg }}</div>\n</template>\n<script setup lang="ts">\nconst msg = "hi"\n</script>\n',
      'd.md': '# 标题\n\n正文\n',
      'e.json': '{\n  "name": "a",\n  "n": 1\n}\n',
      'f.unknownext': 'alpha beta\n',
      'x.html': '<p>ok</p>\n',
      'perf.ts': perfLines(0),
    });
    writeFiles(repo, {
      'a.ts': TS_NEW,
      'b.py': 'def f():\n    s = """第一行\n    第二行 def\n    """\n    return 2\n',
      'c.vue': '<template>\n  <div class="box">{{ msg }}</div>\n</template>\n<script setup lang="ts">\nconst msg = "hello"\n</script>\n',
      'd.md': '# 新标题\n\n正文 `code`\n',
      'e.json': '{\n  "name": "a",\n  "n": 2\n}\n',
      'f.unknownext': 'alpha gamma\n',
      'x.html': '<p>ok</p>\n<img src=x onerror=alert(1)>\n',
      'perf.ts': perfLines(1),
      'big.ts': bigFile(),
    });
    const id = await createSessionViaForm(app, '高亮用例', repo);
    sid = id;
    await waitOutput(app, id, 'mock-claude 已启动');
    expect(await app.postHook(id, {
      hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'a.ts' },
    })).toBe(200);
    expect(await app.postHook(id, { hook_event_name: 'Stop' })).toBe(200);
    await app.until(async () => (await app.session(id))?.changes?.files === 9, { timeout: 20_000, message: '改动摘要为 9 个文件' });
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    await switchChangesScope(app, 'repo');
    await app.waitFor(`document.querySelectorAll('.chg-list .chg-row').length === 9`, { message: '改动列表 9 行' });
  });

  it('ts：关键字、类型、注释、模板字符串着色，跨行注释延续', async () => {
    await select('a.ts');
    await app.waitFor(`!!document.querySelector('.chg-diff-scroll .syn-kw')`, { message: '出现关键字着色' });
    expect(await syn('kw')).toEqual(expect.arrayContaining(['export', 'class', 'private', 'new', 'throw', 'const']));
    expect(await syn('com')).toEqual(expect.arrayContaining(['// 用户服务', '/* 多行注释', '     第二行 */']));
    expect((await syn('str')).join('')).toContain('`a ');
    expect(await syn('fn')).toEqual(expect.arrayContaining(['getRepo']));
    await app.shot('a-ts-highlight');
  });

  it('词级差异只覆盖变化的标识符，整行重写不做词级', async () => {
    expect(await intra('del')).toEqual(['Map']);
    expect(await intra('add')).toEqual(['LruCache']);
    const rewritten = await app.eval<number>(`[...document.querySelectorAll('.chg-diff-scroll .chg-ln')]
      .filter(r => (r.querySelector('.chg-txt')?.textContent ?? '').includes('throw new Error'))
      .reduce((n, r) => n + r.querySelectorAll('.chg-intra').length, 0)`);
    expect(rewritten).toBe(0);
  });

  it('python 三引号、vue、markdown、json 着色', async () => {
    await select('b.py');
    await app.waitFor(`!!document.querySelector('.chg-diff-scroll .syn-str')`, { message: 'py 字符串着色' });
    expect(await syn('str')).toEqual(expect.arrayContaining(['"""第一行', '    第二行 def', '    """']));
    expect(await syn('kw')).toEqual(expect.arrayContaining(['def', 'return']));

    await select('c.vue');
    await app.waitFor(`!!document.querySelector('.chg-diff-scroll .syn-tag')`, { message: 'vue 标签着色' });
    expect(await syn('tag')).toEqual(expect.arrayContaining(['template', 'div', 'script']));
    expect(await syn('kw')).toEqual(expect.arrayContaining(['const']));
    expect(await syn('attr')).toEqual(expect.arrayContaining(['class']));

    await select('d.md');
    await app.waitFor(`!!document.querySelector('.chg-diff-scroll .syn-head')`, { message: 'md 标题着色' });
    // 词级标记会把标题切成几段，按行拼回整段比较
    const heads = await app.eval<string[]>(`[...document.querySelectorAll('.chg-diff-scroll .chg-ln')]
      .map(r => [...r.querySelectorAll('.syn-head')].map(e => e.textContent).join('')).filter(Boolean)`);
    expect(heads).toEqual(['# 标题', '# 新标题']);
    // 「正文」改成「正文 `code`」相似度不足，整行视为重写，只有标题行做词级
    expect(await intra('add')).toEqual(['新']);
    expect(await syn('code')).toEqual(expect.arrayContaining(['`code`']));

    await select('e.json');
    await app.waitFor(`!!document.querySelector('.chg-diff-scroll .syn-prop')`, { message: 'json 键着色' });
    expect(await syn('prop')).toEqual(expect.arrayContaining(['"name"', '"n"']));
  });

  it('未识别扩展名不着色但保留词级差异', async () => {
    await select('f.unknownext');
    await app.waitFor(`document.querySelectorAll('.chg-diff-scroll .chg-intra').length > 0`, { message: '词级标记' });
    expect(await app.count('.chg-diff-scroll [class^="syn-"], .chg-diff-scroll [class*=" syn-"]')).toBe(0);
    expect(await intra('add')).toEqual(['gamma']);
  });

  it('文件里的标签按纯文本显示，不生成元素', async () => {
    await select('x.html');
    await app.waitFor(`!!document.querySelector('.chg-diff-scroll .syn-tag')`, { message: 'html 着色' });
    expect(await app.count('.chg-diff-scroll img')).toBe(0);
    const texts = await app.eval<string[]>(`[...document.querySelectorAll('.chg-diff-scroll .chg-ln.add .chg-txt')].map(e => e.textContent)`);
    expect(texts).toContain('<img src=x onerror=alert(1)>');
  });

  it('超过 400KB 的 diff 关闭高亮并提示', async () => {
    await select('big.ts');
    await app.waitFor(`[...document.querySelectorAll('.chg-diff-scroll .chg-notice.warn')].some(n => n.textContent.includes('文件过大，已关闭语法高亮'))`,
      { message: '超大文件提示' });
    expect(await app.count('.chg-diff-scroll [class^="syn-"]')).toBe(0);
  });

  it('5000 行 diff：首屏耗时、长任务与懒绘制', async () => {
    const r = await app.eval<{ firsts: number[]; tDom: number; ipc: number; maxLong: number; lastBefore: number; rows: number }>(`(async () => {
      const ipcOnce = async () => {
        const t = performance.now();
        await window.panelApi.fileDiff(${JSON.stringify(sid)}, 'perf.ts').catch(() => null);
        return performance.now() - t;
      };
      /** 点选文件，等可视区出现着色，返回耗时与行出现耗时 */
      const open = (p, needSyn) => new Promise((res, rej) => {
        const t0 = performance.now();
        let tDom = 0;
        document.querySelector('.chg-list .chg-row[title="' + p + '"]').click();
        const tick = () => {
          const shown = (document.querySelector('.chg-diff-path')?.dataset.addr ?? '').replace(/\\\\/g, '/').endsWith('/' + p)
            && document.querySelectorAll('.chg-diff-scroll .chg-ln').length > (needSyn ? 100 : 0);
          if (shown && !tDom) tDom = performance.now() - t0;
          const ok = shown && (!needSyn || document.querySelector('.chg-diff-scroll .chg-ln .syn-kw'));
          if (ok) res({ first: performance.now() - t0, tDom });
          else if (performance.now() - t0 > 15000) rej(new Error('首屏超时'));
          else requestAnimationFrame(tick);
        };
        tick();
      });
      const settle = () => new Promise(r => setTimeout(r, 400));
      const ipcBefore = await ipcOnce();
      const longs = [];
      const po = new PerformanceObserver(l => { for (const e of l.getEntries()) longs.push(e.duration); });
      po.observe({ type: 'longtask' });
      // 量两次取较好的一次，排除机器上偶发的整帧停顿
      const a = await open('perf.ts', true);
      await settle();
      await open('a.ts', false);
      await settle();
      const b = await open('perf.ts', true);
      const ipc = (ipcBefore + await ipcOnce()) / 2;
      // 大 diff 先挂首屏附近的行，其余分批补齐
      const t1 = performance.now();
      while (document.querySelectorAll('.chg-diff-scroll .chg-ln').length < ${PERF_N * 2} && performance.now() - t1 < 15000) {
        await new Promise(r => setTimeout(r, 30));
      }
      const rows = document.querySelectorAll('.chg-diff-scroll .chg-ln');
      const lastBefore = rows[rows.length - 1].querySelector('.chg-txt').children.length;
      const sc = document.querySelector('.chg-diff-scroll');
      for (let i = 1; i <= 10; i++) {
        sc.scrollTop = sc.scrollHeight * i / 10;
        await new Promise(r => setTimeout(r, 60));
      }
      await new Promise(r => setTimeout(r, 300));
      po.disconnect();
      return { firsts: [a.first, b.first], tDom: Math.min(a.tDom, b.tDom), ipc, maxLong: longs.length ? Math.max(...longs) : 0, lastBefore, rows: rows.length };
    })()`);
    const first = Math.min(...r.firsts);
    console.log(`[e2e] 5000 行 diff：首屏 ${r.firsts.map(x => x.toFixed(0)).join(' / ')}ms（行出现 ${r.tDom.toFixed(0)}ms，取 diff 约 ${r.ipc.toFixed(0)}ms，渲染侧约 ${(first - r.ipc).toFixed(0)}ms），最长任务 ${r.maxLong.toFixed(0)}ms，行数 ${r.rows}`);
    expect(r.rows).toBe(PERF_N * 2);
    // 首屏只绘制可视区附近，末尾的行在滚动前还是纯文本
    expect(r.lastBefore).toBe(0);
    await app.waitFor(`(() => { const rows = document.querySelectorAll('.chg-diff-scroll .chg-ln');
      return rows[rows.length - 1].querySelectorAll('.syn-kw').length > 0; })()`, { message: '滚到末尾后补画' });
    // 端到端含主进程跑 git 的耗时，机器负载下波动大，只设宽松上限；渲染侧（扣除取 diff）按 300ms 要求
    expect(first).toBeLessThan(1500);
    expect(first - r.ipc).toBeLessThan(300);
    expect(r.maxLong).toBeLessThan(200);
    await app.shot('perf-bottom');
  });
});
