import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { q, useApp } from './harness';
import { createSessionViaForm, initGitRepo, sendLine, waitOutput, waitStatus } from './fixtures';

/**
 * 每轮自动验证：配置对话框、一轮结束后自动运行、通过与失败徽标、输出弹窗（颜色、GBK 解码）、
 * 工作区未变化时沿用上次结果、新一轮开始时取消并结束进程树、并发上限下排队、
 * 失败输出发给 Claude 修复。验证命令只是临时仓库里的 check.js，按同目录的 mode.txt 决定行为。
 */

const PS = '\x1b[200~';

interface Summary { status: string; command: string; exitCode?: number | null; reused?: boolean; message?: string; finishedAt?: number }

function checkScript(pidFile: string): string {
  return [
    "const fs = require('fs');",
    "const path = require('path');",
    "const mode = fs.readFileSync(path.join(__dirname, 'mode.txt'), 'utf8').trim();",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "if (mode === 'pass') { console.log('\\x1b[32mall 3 tests passed\\x1b[0m'); process.exitCode = 0; }",
    "if (mode === 'fail') { console.log('\\x1b[31mFAIL\\x1b[0m sum.test.js'); console.error('expected 3 got 4'); process.exitCode = 2; }",
    "if (mode === 'gbk') { process.stdout.write(Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xca, 0xa7, 0xb0, 0xdc, 0x0d, 0x0a])); process.exitCode = 1; }",
    "if (mode === 'wait') { console.log('waiting'); setTimeout(() => { console.log('done'); }, 6000); }",
    "if (mode === 'slow') { console.log('slow started'); setTimeout(() => {}, 60000); }",
    '',
  ].join('\n');
}

/** 属性面板验证节里的徽标（会话被选中时存在） */
const badgeSel = (id: string): string => `.verify-sec[data-session-id="${id}"] .verify-badge`;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('自动验证', () => {
  const app = useApp({
    env: {
      CLAUDE_PANEL_MOCK_NO_PERMISSION: '1',
      CLAUDE_PANEL_MOCK_TURN_MS: '300',
      CLAUDE_PANEL_MOCK_INPUT_LOG: '{root}/mock-input.log',
    },
  });
  const inputs = (): string[] => {
    const f = path.join(app.root, 'mock-input.log');
    return fs.existsSync(f)
      ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => (JSON.parse(l) as { data: string }).data)
      : [];
  };
  const summary = async (id: string): Promise<Summary | undefined> => (await app.session(id))?.verify as Summary | undefined;
  const cmdLine = (): string => `"${process.execPath}" check.js`;
  let repo = '';
  let id = '';
  const setMode = (dir: string, mode: string): void => fs.writeFileSync(path.join(dir, 'mode.txt'), mode);
  /** 跑一轮 mock 任务（不请求权限），等到这一轮的验证有结果 */
  const turnThenVerify = async (sid: string, task: string, pred: (s: Summary) => boolean, msg: string): Promise<Summary> => {
    const before = (await summary(sid))?.finishedAt ?? 0;
    await sendLine(app, sid, task);
    await waitOutput(app, sid, `收到任务："${task}"`);
    return app.until(async () => {
      const s = await summary(sid);
      return s && (s.finishedAt ?? 0) > before && pred(s) ? s : undefined;
    }, { timeout: 30_000, message: msg });
  };

  it('配置对话框：空命令报错，保存后属性面板显示命令；一轮结束后自动运行并通过', async () => {
    repo = initGitRepo(app, 'proj-verify', { 'check.js': checkScript(path.join(app.root, 'verify-pid-1.txt')), 'README.md': 'x\n' });
    setMode(repo, 'pass');
    id = await createSessionViaForm(app, '验证用例', repo);
    await waitOutput(app, id, 'mock-claude 已启动');
    // 未配置时属性面板不显示验证节，从命令面板「配置验证命令」进入
    await app.waitVisible('#inspector .status-sec');
    expect(await app.exists('.verify-sec')).toBe(false);
    await app.blur();
    await app.press('Control+K');
    await app.waitVisible('#palette-backdrop');
    await app.fill('#palette-input', '配置验证命令');
    await app.waitFor(`document.querySelector('#palette-list .pal-i.on .pt')?.textContent === '配置验证命令'`, { message: '面板有配置验证命令' });
    await app.press('Enter');
    await app.waitVisible('#verify-cfg-backdrop');
    expect(await app.text('#verify-cfg-backdrop')).toContain('请勿配置会修改源码的命令');
    expect(await app.text('#verify-cfg-backdrop')).toContain('对此仓库下所有会话');
    await app.click('#verify-cfg-save');
    await app.waitFor(`document.querySelector('#verify-cfg-error')?.textContent === '验证命令不能为空'`, { message: '空命令报错' });
    await app.fill('#verify-cfg-cmd', cmdLine());
    await app.click('#verify-cfg-save');
    await app.waitHidden('#verify-cfg-backdrop');
    const view = await app.eval<{ config: { command: string; enabled: boolean; skipUnchanged: boolean } | null; isRepo: boolean }>(
      `window.panelApi.verify.getConfig(${q(id)})`);
    expect(view.isRepo).toBe(true);
    expect(view.config).toMatchObject({ command: cmdLine(), enabled: true, skipUnchanged: true });
    await app.waitFor(`document.querySelector('.verify-sec .verify-cmd')?.textContent === ${q(cmdLine())}`, { message: '属性面板显示命令' });

    const s = await turnThenVerify(id, '任务一', x => x.status === 'passed', '第一轮验证通过');
    expect(s.reused).toBeFalsy();
    await app.waitFor(`!!document.querySelector(${q(`${badgeSel(id)}[data-status="passed"]`)})`, { message: '验证节显示通过徽标' });
    await app.waitFor(`document.querySelector('.verify-sec .verify-last-text')?.textContent === '通过'`, { message: '属性面板显示通过' });
  });

  it('工作区未变化时沿用上次结果', async () => {
    // 沿用时摘要原样复制上次结果（含结束时间），只多一个 reused 标记
    const first = await summary(id);
    expect(first?.reused).toBeFalsy();
    await sendLine(app, id, '任务二');
    await waitOutput(app, id, '收到任务："任务二"');
    const s = await app.until(async () => {
      const x = await summary(id);
      return x?.reused ? x : undefined;
    }, { timeout: 20_000, message: '沿用上次结果' });
    expect(s.status).toBe('passed');
    expect(s.finishedAt).toBe(first?.finishedAt);
    await app.waitFor(`document.querySelector(${q(`${badgeSel(id)}`)})?.dataset.reused === '1'`, { message: '徽标标注沿用' });
    expect(await app.eval<string>(`document.querySelector(${q(`${badgeSel(id)}`)}).title`)).toContain('未变化，沿用上次结果');
  });

  it('失败：徽标、输出弹窗带颜色；发给 Claude 修复以一次粘贴提交', async () => {
    setMode(repo, 'fail');
    const s = await turnThenVerify(id, '任务三', x => x.status === 'failed', '验证失败');
    expect(s.exitCode).toBe(2);
    await app.waitFor(`!!document.querySelector(${q(`${badgeSel(id)}[data-status="failed"]`)})`, { message: '失败徽标' });
    await app.click(`${badgeSel(id)}`);
    await app.waitVisible('#verify-out-backdrop');
    await app.waitFor(`(document.querySelector('#verify-out-pre')?.textContent ?? '').includes('expected 3 got 4')`, { message: '输出弹窗显示输出' });
    expect(await app.text('#verify-out-pre')).toContain('FAIL sum.test.js');
    expect(await app.text('#verify-out-pre')).not.toContain('\x1b');
    expect(await app.count('#verify-out-pre span[style]')).toBeGreaterThan(0);
    expect(await app.text('#verify-out-backdrop h2')).toContain('失败（退出码 2）');
    await app.shot('verify-output-failed');
    await app.waitFor(`document.querySelector('#verify-out-fix')?.disabled === false`, { message: '修复按钮可用' });
    const before = inputs().length;
    await app.click('#verify-out-fix');
    await app.waitHidden('#verify-out-backdrop');
    await app.until(() => inputs().slice(before).some(d => d.startsWith(PS) && d.includes('自动验证没有通过') && d.includes('expected 3 got 4')),
      { message: '修复提示词以粘贴块送达' });
    await waitOutput(app, id, '"自动验证没有通过，请根据下面的输出找出原因并修复。"');
    await waitStatus(app, id, 'completed');
  });

  it('GBK 输出按 GBK 解码', async () => {
    setMode(repo, 'gbk');
    await turnThenVerify(id, '任务四', x => x.status === 'failed' && x.exitCode === 1, 'GBK 验证结束');
    const d = await app.eval<{ output: string; encoding?: string }>(`window.panelApi.verify.detail(${q(id)})`);
    expect(d.encoding).toBe('gbk');
    expect(d.output).toContain('测试失败');
    await app.click(`${badgeSel(id)}`);
    await app.waitVisible('#verify-out-backdrop');
    await app.waitFor(`(document.querySelector('#verify-out-pre')?.textContent ?? '').includes('测试失败')`, { message: '弹窗显示中文' });
    expect(await app.text('.verify-out-meta')).toContain('按 GBK 解码');
    await app.click('#verify-out-close');
    await app.waitHidden('#verify-out-backdrop');
  });

  it('新一轮开始时取消正在运行的验证并结束进程树', async () => {
    setMode(repo, 'slow');
    const pidFile = path.join(app.root, 'verify-pid-1.txt');
    fs.rmSync(pidFile, { force: true });
    await sendLine(app, id, '任务五');
    await app.until(async () => (await summary(id))?.status === 'running' && fs.existsSync(pidFile) ? true : undefined,
      { timeout: 20_000, message: '慢验证开始运行' });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    await app.waitFor(`!!document.querySelector(${q(`${badgeSel(id)}[data-status="running"]`)})`, { message: '运行中徽标' });
    await sendLine(app, id, '任务六');
    const s = await app.until(async () => {
      const x = await summary(id);
      return x?.status === 'cancelled' ? x : undefined;
    }, { message: '验证被新一轮取消' });
    expect(s.message).toBe('Claude 开始了新一轮');
    setMode(repo, 'pass');
    await app.until(() => !alive(pid), { timeout: 10_000, message: '验证进程树已结束' });
    await turnThenVerify(id, '任务七', x => x.status === 'passed', '恢复通过');
  });

  it('并发上限为 1 时第二个会话排队，前一个结束后再运行', async () => {
    await app.eval(`window.panelApi.verify.setGlobal({ maxConcurrent: 1 })`);
    const repo2 = initGitRepo(app, 'proj-verify-2', { 'check.js': checkScript(path.join(app.root, 'verify-pid-2.txt')), 'README.md': 'y\n' });
    setMode(repo2, 'pass');
    const id2 = await createSessionViaForm(app, '验证排队用例', repo2);
    await waitOutput(app, id2, 'mock-claude 已启动');
    const view = await app.eval<{ repoKey: string }>(`window.panelApi.verify.getConfig(${q(id2)})`);
    const saved = await app.eval<{ ok: boolean }>(`window.panelApi.verify.setConfig(${q(view.repoKey)},
      { command: ${q(cmdLine())}, enabled: true, timeoutSec: 60, skipUnchanged: true })`);
    expect(saved.ok).toBe(true);
    await app.eval(`(() => {
      window.__e2eVerify2 = [];
      window.panelApi.onSessions(list => {
        const v = list.find(x => x.id === ${q(id2)})?.verify;
        const arr = window.__e2eVerify2;
        if (v && arr[arr.length - 1] !== v.status) arr.push(v.status);
      });
      return true;
    })()`);
    setMode(repo, 'wait');
    await sendLine(app, id, '任务八');
    await app.until(async () => (await summary(id))?.status === 'running' ? true : undefined, { timeout: 20_000, message: '第一个会话验证运行中' });
    await sendLine(app, id2, '排队任务');
    await app.until(async () => (await summary(id2))?.status === 'queued' ? true : undefined, { timeout: 20_000, message: '第二个会话排队' });
    expect((await summary(id))?.status).toBe('running');
    await app.until(async () => (await summary(id2))?.status === 'passed' ? true : undefined, { timeout: 30_000, message: '排队的验证最终通过' });
    expect((await summary(id))?.status).toBe('passed');
    const seen = await app.eval<string[]>('window.__e2eVerify2');
    expect(seen.indexOf('queued')).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf('running')).toBeGreaterThan(seen.indexOf('queued'));
    await app.eval(`window.panelApi.verify.setGlobal({ maxConcurrent: 2 })`);
    await app.shot('verify-badges');
    expect(await app.exceptions()).toEqual([]);
  });
});
