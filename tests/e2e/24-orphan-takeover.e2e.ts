import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { useApp, q } from './harness';
import {
  clickButton, createSessionViaForm, exitSession, mkWorkDir, rowSel, runTurn, transcriptFile, waitOutput, waitStatus,
} from './fixtures';

/**
 * 接管认领的孤儿会话：重启面板前在会话目录写入指向存活进程的 metadata，模拟面板崩溃后 claude 仍在原终端运行。
 * 「原进程」由用例自己启动：真孤儿的命令行带着本会话的 --settings 路径；冒名的进程没有，接管时必须拒绝且不结束它。
 */
describe('接管孤儿会话', () => {
  const app = useApp();
  const IMPOSTER = 'e2e0orphan-imposter-0001';
  const procs: ChildProcess[] = [];
  let id = '';
  let claudeId = '';
  let workDir = '';
  let orphan: ChildProcess;
  let imposter: ChildProcess;

  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const longRunning = (extra: string[]): ChildProcess => {
    // -- 之后的参数交给脚本，命令行里能看到，node 也不会当成自己的选项报错
    const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...extra], { stdio: 'ignore', windowsHide: true });
    procs.push(p);
    return p;
  };
  const writeMeta = (home: string, sid: string, meta: Record<string, unknown>): void => {
    const dir = path.join(home, 'sessions', sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ id: sid, cwd: workDir, createdAt: Date.now(), ...meta }));
  };
  const toastTexts = () => app.eval<string[]>(`[...document.querySelectorAll('#toast-container .toast')].map(el => el.textContent ?? '')`);

  afterAll(() => {
    for (const p of procs) { try { p.kill(); } catch { /* 已退出 */ } }
  });

  it('会话跑完一轮后退出，重启面板时认领两个存活的「孤儿」', async () => {
    workDir = mkWorkDir(app, 'proj-orphan');
    id = await createSessionViaForm(app, '孤儿用例', workDir);
    claudeId = String((await app.session(id))?.claudeSessionId ?? '');
    await runTurn(app, id, 'orphan-e2e');
    await exitSession(app, id);

    // 两次启动之间实例已关闭，临时根目录与对话记录路径要先记下
    const home = app.home;
    const transcript = transcriptFile(app, claudeId)!;
    await app.restart({
      between: () => {
        orphan = longRunning(['--settings', path.join(home, 'sessions', id, 'settings.json')]);
        imposter = longRunning(['--unrelated']);
        writeMeta(home, id, { label: '孤儿用例', pid: orphan.pid, sessionId: claudeId });
        // 冒名会话也备一份对话记录，续接前检查能通过，拒绝只能来自命令行核对
        const fakeId = randomUUID();
        fs.copyFileSync(transcript, path.join(path.dirname(transcript), `${fakeId}.jsonl`));
        writeMeta(home, IMPOSTER, { label: '冒名孤儿', pid: imposter.pid, sessionId: fakeId });
      },
    });
    for (const sid of [id, IMPOSTER]) {
      await app.waitFor(`!!document.querySelector(${q(rowSel(sid))})`, { message: `认领会话 ${sid} 的列表行` });
      expect((await app.session(sid))?.readOnly).toBe(true);
    }
  });

  it('认领会话页头有「接管并续接」，底部说明指向它', async () => {
    await app.click(rowSel(id));
    await app.waitVisible('#pane-takeover');
    expect(await app.visible('#pane-ro')).toBe(true);
    expect(await app.text('#pane-footer')).toContain('接管并续接');
    await app.shot('orphan-takeover');
  });

  it('pid 的命令行不属于该会话：拒绝接管，不结束那个进程', async () => {
    await app.click(rowSel(IMPOSTER));
    await app.waitVisible('#pane-takeover');
    await app.click('#pane-takeover');
    await app.waitVisible('#confirm-backdrop');
    await clickButton(app, '#confirm-buttons', '接管并续接');
    await app.until(async () => (await toastTexts()).find(t => t.includes('未结束任何进程')), { timeout: 20_000, message: '拒绝原因提示' });
    expect(alive(imposter.pid!)).toBe(true);
    expect((await app.session(IMPOSTER))?.readOnly).toBe(true);
  });

  it('确认后结束原进程，在面板里续接同一段对话', async () => {
    await app.click(rowSel(id));
    await app.waitVisible('#pane-takeover');
    await app.click('#pane-takeover');
    await app.waitVisible('#confirm-backdrop');
    await clickButton(app, '#confirm-buttons', '接管并续接');
    await waitOutput(app, id, '已续接，历史 1 条', 30_000);
    const s = await waitStatus(app, id, 'running');
    expect(s.readOnly).toBeFalsy();
    expect(s.claudeSessionId).toBe(claudeId);
    await app.until(async () => !alive(orphan.pid!), { message: '原进程已结束' });
    expect(app.logs()).toContain(`--resume ${claudeId}`);
    expect(await app.exists('#pane-takeover')).toBe(false);
    expect(await app.visible('#pane-footer')).toBe(false);
    expect(await app.exceptions()).toEqual([]);
  });
});
