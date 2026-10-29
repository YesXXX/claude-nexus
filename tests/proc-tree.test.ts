import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { isPidAlive, killTree, killTreeSync } from '../src/main/proc-tree';

/**
 * 用真实的 node 进程搭三层进程树（父 → 子 → 孙，孙进程无限等待），确认按父 pid 结束时子孙一并结束。
 * 脚本全部写在临时目录，只结束本测试自己启动的进程。
 */

function tmpDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-proc-')));
}

function writeTree(dir: string): string {
  const grand = path.join(dir, 'grand.js');
  const child = path.join(dir, 'child.js');
  const parent = path.join(dir, 'parent.js');
  fs.writeFileSync(grand, 'console.log("grand " + process.pid); setInterval(() => {}, 1000);\n');
  fs.writeFileSync(child, [
    'const { spawn } = require("child_process");',
    `const g = spawn(process.execPath, [${JSON.stringify(grand)}], { stdio: ["ignore", "inherit", "inherit"] });`,
    'console.log("child " + process.pid);',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  fs.writeFileSync(parent, [
    'const { spawn } = require("child_process");',
    `spawn(process.execPath, [${JSON.stringify(child)}], { stdio: ["ignore", "inherit", "inherit"] });`,
    'console.log("parent " + process.pid);',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  return parent;
}

/** 启动进程树并等到三层 pid 都报上来 */
function startTree(dir: string): Promise<{ parent: number; child: number; grand: number }> {
  const script = writeTree(dir);
  const p = spawn(process.execPath, [script], {
    cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32',
  });
  return new Promise((resolve, reject) => {
    const pids: Record<string, number> = {};
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`进程树未就绪：${buf}`)), 15000);
    p.stdout!.on('data', (c: Buffer) => {
      buf += c.toString();
      for (const m of buf.matchAll(/(parent|child|grand) (\d+)/g)) pids[m[1]] = Number(m[2]);
      if (pids.parent && pids.child && pids.grand) {
        clearTimeout(timer);
        resolve({ parent: pids.parent, child: pids.child, grand: pids.grand });
      }
    });
    p.on('error', reject);
  });
}

async function waitDead(pids: number[], ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pids.every(p => !isPidAlive(p))) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return pids.every(p => !isPidAlive(p));
}

describe('proc-tree', () => {
  it('isPidAlive：本进程存活，不存在的 pid 不存活', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
  });

  it('killTree 结束父、子、孙三层进程', async () => {
    const tree = await startTree(tmpDir());
    const all = [tree.parent, tree.child, tree.grand];
    expect(all.every(isPidAlive)).toBe(true);
    await killTree(tree.parent);
    expect(await waitDead(all)).toBe(true);
  }, 30000);

  it('killTreeSync 同步结束整个进程树', async () => {
    const tree = await startTree(tmpDir());
    const all = [tree.parent, tree.child, tree.grand];
    killTreeSync(tree.parent);
    expect(await waitDead(all)).toBe(true);
  }, 30000);

  it('非法或已退出的 pid 不抛出', async () => {
    await expect(killTree(0)).resolves.toBeUndefined();
    await expect(killTree(-5)).resolves.toBeUndefined();
    expect(() => killTreeSync(0)).not.toThrow();
  });
});
