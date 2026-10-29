import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import type { LaunchedApp } from './harness';

/**
 * 清理逻辑本身的回归：不走 useApp，直接调用启动器。
 * 启动后先建一个 mock 会话，让进程树里带上 PTY 与 mock-claude 子进程，再关闭，
 * 断言快照中的进程全部退出、调试端口释放、临时根目录已删除。
 */

const require = createRequire(import.meta.url);
const { launch } = require('../../scripts/e2e/launch.js');
const procs = require('../../scripts/e2e/procs.js');

describe('残留自检', () => {
  let app: (LaunchedApp & { exited: boolean }) | null = null;

  afterAll(async () => {
    // 断言失败时兜底清理
    if (app) await app.close().catch(() => null);
  });

  it('关闭后快照进程全部退出、端口释放、临时根目录删除', async () => {
    const port = Number(process.env.E2E_PORT || 9335);
    app = await launch({ port, exe: process.env.E2E_EXE || undefined });
    const a = app!;
    const page = a.page!;

    const created = await page.evaluate(
      `window.panelApi.create('残留自检', ${JSON.stringify(a.work)}).then(s => s.id)`) as string;
    const end = Date.now() + 15_000;
    while (!String(await page.evaluate(`window.panelApi.output(${JSON.stringify(created)})`)).includes('mock-claude 已启动')) {
      if (Date.now() > end) throw new Error('mock 会话未在 15s 内启动');
      await new Promise(r => setTimeout(r, 100));
    }

    const snapshot = await a.snapshot();
    expect(snapshot.length).toBeGreaterThan(1);
    expect(snapshot[0].pid).toBe(a.pid);
    const root = a.root;
    const report = await a.close();
    app = null;

    expect(report.portReleased).toBe(true);
    expect(report.removed).toBe(true);
    expect(await procs.aliveFromSnapshot(snapshot)).toEqual([]);
    expect(await procs.portInUse(port)).toBe(false);
    expect(fs.existsSync(root)).toBe(false);
  });
});
