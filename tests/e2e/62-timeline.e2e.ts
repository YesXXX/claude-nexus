import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { q, useApp } from './harness';
import {
  clickButton, createSessionViaForm, mkWorkDir, rowSel, runTurn, selectedSessionId, terminalFocusedExpr, waitOutput,
} from './fixtures';

/** 跨会话活动时间线：入口、合并、过滤、跳转、增量、持久化与清空 */
describe('活动时间线', () => {
  const app = useApp({ env: { CLAUDE_PANEL_TEST_HOOKS: '1' } });
  let A = '';
  let B = '';
  const SECRET = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  interface Row { id: string; type: string; session: string | null; text: string; ended: boolean; attn: boolean }
  const rows = () => app.eval<Row[]>(`[...document.querySelectorAll('#atl-list .atl-row')].map(r => ({
    id: r.dataset.id, type: r.dataset.type, session: r.dataset.session ?? null, text: r.textContent ?? '',
    ended: r.classList.contains('ended'), attn: r.classList.contains('attn') }))`);
  const report = (list: unknown[]) => app.eval(`window.panelApi.activity.testReport(${JSON.stringify(list)})`);
  const toastTexts = () => app.eval<string[]>(
    `[...document.querySelectorAll('#toast-container .toast-title')].map(el => el.textContent ?? '')`);
  const waitLoaded = () => app.waitFor(`document.querySelector('#atl-list')?.getAttribute('aria-busy') === 'false'`,
    { message: '时间线首屏就绪' });
  const openByHotkey = async () => {
    await app.blur();
    await app.press('Control+Shift+L');
    await app.waitVisible('#timeline-view');
    await waitLoaded();
  };
  const closeByEsc = async () => {
    await app.press('Escape');
    await app.waitHidden('#timeline-view');
  };

  it('三处入口均能打开时间线，焦点在终端时快捷键同样生效', async () => {
    A = await createSessionViaForm(app, '时间线甲', mkWorkDir(app, 'tl-a'));
    B = await createSessionViaForm(app, '时间线乙', mkWorkDir(app, 'tl-b'));
    await waitOutput(app, A, 'mock-claude 已启动');
    await waitOutput(app, B, 'mock-claude 已启动');
    await runTurn(app, A, 'timeline-task');
    for (const [tool, input] of [['Read', { file_path: 'a.ts' }], ['Edit', { file_path: 'b.ts' }], ['Bash', { command: 'npm run build' }]] as const) {
      expect(await app.postHook(B, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input })).toBe(200);
    }

    // 终端获得焦点时按 Ctrl+Shift+L
    await app.click(rowSel(B));
    await app.eval(`(() => { const t = [...document.querySelectorAll('.xterm-helper-textarea')]
      .find(x => x.closest('.xterm')?.getClientRects().length > 0); t?.focus(); return !!t; })()`);
    await app.waitFor(terminalFocusedExpr(), { message: '终端获得焦点' });
    await app.press('Control+Shift+L');
    await app.waitVisible('#timeline-view');
    expect(await app.eval<boolean>(`document.querySelector('#main').classList.contains('atl-open')`)).toBe(true);
    expect(await app.eval<boolean>(`document.querySelector('#rail-timeline').classList.contains('on')`)).toBe(true);

    const r = await app.until(async () => {
      const list = await rows();
      const a = list.filter(x => x.session === A).map(x => x.type);
      const b = list.filter(x => x.session === B);
      const ok = ['session.start', 'turn.start', 'wait.permission', 'turn.end'].every(t => a.includes(t))
        && b.some(x => x.type === 'session.start') && b.some(x => x.type === 'tool.batch' && x.text.includes('调用 3 次工具'));
      return ok ? list : null;
    }, { message: '两个会话的生命周期、回合与合并工具调用均出现' });
    // 同一会话的三次工具调用合并为一行
    expect(r.filter(x => x.session === B && x.type === 'tool.batch')).toHaveLength(1);
    // 与主进程查询的倒序一致，并按天分组
    const ids = await app.eval<string[]>(`window.panelApi.activity.query({ limit: 200 }).then(r => r.events.map(e => e.id))`);
    expect(r.map(x => x.id)).toEqual(ids.slice(0, r.length));
    expect(await app.text('#atl-list .atl-day')).toBe('今天');

    await closeByEsc();
    expect(await app.eval<boolean>(`document.querySelector('#main').classList.contains('atl-open')`)).toBe(false);

    await app.click('#rail-timeline');
    await app.waitVisible('#timeline-view');
    await app.click('#atl-close');
    await app.waitHidden('#timeline-view');

    await app.blur();
    await app.press('Control+K');
    await app.waitVisible('#palette-backdrop');
    await app.type('活动时间线');
    await app.waitFor(`document.querySelector('#palette-list .pal-i.on .pt')?.textContent === '打开活动时间线'`,
      { message: '命令面板选中「打开活动时间线」' });
    await app.press('Enter');
    await app.waitHidden('#palette-backdrop');
    await app.waitVisible('#timeline-view');
    await waitLoaded();
  });

  it('新的工具调用原地更新合并行，不整表重绘；展开显示最近 3 条摘要', async () => {
    const batchSel = `#atl-list .atl-row[data-session="${B}"][data-type="tool.batch"]`;
    const batchId = await app.eval<string>(`document.querySelector(${q(batchSel)}).dataset.id`);
    const before = (await rows()).length;
    // 会话开始事件不会再被原地更新，用它检验推送没有整表重绘
    await app.eval(`document.querySelector('#atl-list .atl-day').dataset.mark = 'keep';
      document.querySelector(${q(`#atl-list .atl-row[data-session="${A}"][data-type="session.start"]`)}).dataset.mark = 'keep'`);
    const t0 = Date.now();
    expect(await app.postHook(B, { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'todo' } })).toBe(200);
    await app.waitFor(`document.querySelector(${q(batchSel)})?.textContent.includes('调用 4 次工具')`, { message: '计数原地更新为 4' });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await app.eval<string>(`document.querySelector(${q(batchSel)}).dataset.id`)).toBe(batchId);
    expect((await rows()).length).toBe(before);
    expect(await app.exists('#atl-list .atl-row[data-mark="keep"]')).toBe(true);
    expect(await app.exists('#atl-list .atl-day[data-mark="keep"]')).toBe(true);

    await app.click(`${batchSel} .atl-exp`);
    await app.waitVisible(`${batchSel} .atl-recent`);
    expect(await app.count(`${batchSel} .atl-recent .atl-rl`)).toBe(3);
  });

  it('按类别、仅需关注、会话过滤；Esc 先收起下拉', async () => {
    await app.click('#atl-attn');
    await app.until(async () => {
      const list = await rows();
      return list.length > 0 && list.every(x => x.attn) && list.some(x => x.type === 'wait.permission');
    }, { message: '仅需关注只剩需关注的事件' });
    await app.click('#atl-attn');

    await app.click('#atl-cats > summary');
    await app.eval(`[...document.querySelectorAll('#atl-cats label')].find(l => l.textContent.trim() === 'Git').querySelector('input').click()`);
    await app.waitVisible('#atl-empty');
    expect(await app.text('#atl-empty')).toBe('没有符合过滤条件的事件');
    expect(await app.text('#atl-cats > summary')).toBe('类别：Git');
    await clickButton(app, '#atl-cats', '全部');
    await app.waitFor(`document.querySelectorAll('#atl-list .atl-row').length > 3`, { message: '类别恢复全部' });

    await app.click('#atl-sessions > summary');
    await app.waitFor(`[...document.querySelectorAll('#atl-sessions label')].some(l => l.textContent.includes('时间线乙'))`,
      { message: '会话下拉列出会话' });
    await app.eval(`[...document.querySelectorAll('#atl-sessions label')].find(l => l.textContent.includes('时间线乙')).querySelector('input').click()`);
    await app.until(async () => {
      const list = await rows();
      return list.length > 0 && list.every(x => x.session === B);
    }, { message: '只剩会话乙的事件' });
    expect(await app.text('#atl-sessions > summary')).toBe('会话：时间线乙');
    await app.press('Escape');
    await app.waitFor(`!document.querySelector('#atl-sessions').open`, { message: 'Esc 收起下拉' });
    expect(await app.visible('#timeline-view')).toBe(true);
    await app.click('#atl-sessions > summary');
    await clickButton(app, '#atl-sessions', '全部');
    await app.until(async () => (await rows()).some(x => x.session === A), { message: '会话过滤恢复全部' });
  });

  it('外部模块上报的事件出现且已打码；已结束会话提示，点行跳到会话', async () => {
    await report([
      { type: 'verify.result', source: 'e2e', sessionId: A, data: { ok: false, name: 'npm test', summary: '2 failed' } },
      { type: 'git.commit', source: 'e2e', sessionId: A, data: { sha: 'abc1234def', subject: 'feat: 时间线' } },
      { type: 'budget.alert', source: 'e2e', detail: `密钥 ${SECRET}`, data: { scope: 'daily', used: 5, limit: 5, unit: 'usd', threshold: 100 } },
      { type: 'session.error', source: 'e2e', sessionId: 'gone-session-0001', title: '早已结束的会话出错' },
    ]);
    const list = await app.until(async () => {
      const l = await rows();
      return ['verify.result', 'git.commit', 'budget.alert', 'session.error'].every(t => l.some(x => x.type === t)) ? l : null;
    }, { message: '四类外部事件出现' });
    expect(list.every(x => !x.text.includes('ABCDEFGHIJKLMNOP'))).toBe(true);
    expect(list.find(x => x.type === 'budget.alert')!.text).toContain('***');

    const gone = list.find(x => x.type === 'session.error')!;
    expect(gone.ended).toBe(true);
    await app.click(`#atl-list .atl-row[data-id="${gone.id}"]`);
    await app.until(async () => (await toastTexts()).some(t => t.includes('会话已结束，无法跳转')), { message: '提示会话已结束' });
    expect(await app.visible('#timeline-view')).toBe(true);

    await app.click(`#atl-list .atl-row[data-session="${A}"][data-type="turn.end"]`);
    await app.waitHidden('#timeline-view');
    await app.until(async () => (await selectedSessionId(app)) === A, { message: '跳到会话甲' });
  });

  it('属性面板「最近活动」显示 3 条并随推送更新，标题旁「全部」打开按会话过滤的时间线', async () => {
    await app.waitVisible('#insp-activity');
    await app.waitFor(`document.querySelectorAll('#insp-activity .atl-ri').length === 3`, { message: '最近 3 条' });
    await report([{ type: 'git.merge', source: 'e2e', sessionId: A, title: '合并进 master（面板测试）', data: { from: 'x', into: 'master', ok: true } }]);
    await app.waitFor(`document.querySelector('#insp-activity .atl-ri .atl-ri-x')?.textContent === '合并进 master（面板测试）'`,
      { message: '最新事件出现在第一条' });
    expect(await app.count('#insp-activity .atl-ri')).toBe(3);

    await app.click('#insp-activity .atl-ri-all');
    await app.waitVisible('#timeline-view');
    expect(await app.text('#atl-sessions > summary')).toBe('会话：时间线甲');
    await app.until(async () => {
      const l = await rows();
      return l.length > 0 && l.every(x => x.session === A);
    }, { message: '只显示会话甲' });
    // 过滤条件在视图内保留：关掉再用快捷键打开仍是会话甲
    await closeByEsc();
    await openByHotkey();
    expect(await app.text('#atl-sessions > summary')).toBe('会话：时间线甲');
  });

  it('翻页加载更早；列表不在顶部时新事件排队，点按钮回到顶部', async () => {
    await closeByEsc();
    await report(Array.from({ length: 250 }, (_, i) => ({ type: 'git.commit', source: 'e2e', sessionId: A, title: `批量提交 ${i}` })));
    await openByHotkey();
    await app.waitFor(`document.querySelectorAll('#atl-list .atl-row').length === 200`, { message: '首屏 200 条' });
    expect(await app.visible('#atl-load-more')).toBe(true);
    await app.eval(`(() => { const l = document.querySelector('#atl-list'); l.scrollTop = l.scrollHeight; return true; })()`);
    await app.waitFor(`document.querySelectorAll('#atl-list .atl-row').length > 200`, { message: '滚到底部加载更早' });

    await app.eval(`(() => { document.querySelector('#atl-list').scrollTop = 800; return true; })()`);
    await report([{ type: 'git.commit', source: 'e2e', sessionId: A, title: '排队中的新提交' }]);
    await app.waitVisible('#atl-new');
    expect(await app.text('#atl-new')).toBe('↑ 1 条新事件');
    expect((await rows()).some(x => x.text.includes('排队中的新提交'))).toBe(false);
    await app.click('#atl-new');
    await app.waitHidden('#atl-new');
    expect(await app.eval<number>(`document.querySelector('#atl-list').scrollTop`)).toBe(0);
    expect((await rows())[0].text).toContain('排队中的新提交');
    await closeByEsc();
  });

  it('事件落盘且已打码，重启后历史仍在', async () => {
    const file = path.join(app.home, 'activity', 'events.jsonl');
    await app.until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('排队中的新提交'),
      { message: '事件写入 events.jsonl' });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('ABCDEFGHIJKLMNOP');
    await app.restart();
    const titles = await app.eval<string[]>(`window.panelApi.activity.query({ limit: 500 }).then(r => r.events.map(e => e.title))`);
    expect(titles).toContain('排队中的新提交');
    expect(titles).toContain('早已结束的会话出错');
  });

  it('清空时间线需二次确认', async () => {
    await app.waitFor(`document.documentElement.dataset.panelReady === '1'`, { message: '重启后就绪' });
    await openByHotkey();
    await app.click('#atl-menu > summary');
    await app.click('#atl-clear');
    await app.waitVisible('#confirm-buttons');
    await clickButton(app, '#confirm-buttons', '清空');
    await app.waitVisible('#atl-empty');
    expect(await app.count('#atl-list .atl-row')).toBe(0);
    const left = await app.eval<number>(`window.panelApi.activity.query({}).then(r => r.events.length)`);
    expect(left).toBe(0);
    await closeByEsc();
  });

  it('5000 条事件重启后完整载入，损坏行跳过，打开时间线 300ms 内完成首屏', async () => {
    await report(Array.from({ length: 5000 }, (_, i) => ({
      type: 'git.commit', source: 'e2e', sessionId: A, title: `压测提交 ${i}`, data: { sha: `s${i}`, subject: `第 ${i} 次` },
    })));
    const file = path.join(app.home, 'activity', 'events.jsonl');
    await app.restart({
      between: () => {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.splice(Math.floor(lines.length / 2), 0, '{这一行损坏了');
        fs.writeFileSync(file, lines.join('\n'));
      },
    });
    await app.waitFor(`document.documentElement.dataset.panelReady === '1'`, { message: '重启后就绪' });
    expect(app.logs()).toMatch(/跳过损坏 1 行/);
    const total = await app.eval<number>(`(async () => {
      let n = 0; let before;
      for (;;) {
        const r = await window.panelApi.activity.query(before ? { limit: 500, beforeSeq: before } : { limit: 500 });
        n += r.events.filter(e => e.title.startsWith('压测提交')).length;
        if (!r.hasMore || r.events.length === 0) return n;
        before = r.events[r.events.length - 1].seq;
      }
    })()`);
    expect(total).toBe(5000);

    await app.blur();
    const ms = await app.eval<number>(`(async () => {
      const t = performance.now();
      document.querySelector('#rail-timeline').click();
      await new Promise(resolve => {
        const check = () => (document.querySelector('#atl-list').getAttribute('aria-busy') === 'false'
          && document.querySelector('#atl-list .atl-row')) ? resolve() : requestAnimationFrame(check);
        check();
      });
      return performance.now() - t;
    })()`);
    expect(await app.count('#atl-list .atl-row')).toBe(200);
    expect(ms).toBeLessThan(300);
    await closeByEsc();
  });
});
