import { describe, it, expect } from 'vitest';
import { q, useApp } from './harness';
import {
  clickButton, clickPaneMenu, createSessionViaForm, mkWorkDir, rowSel, runTurn, selectedSessionId, sendLine, waitOutput, waitStatus,
} from './fixtures';

/**
 * 多窗格布局：命令面板与窗格头拆分、空占位选会话、每格独立交互、打开会话语义、分隔条、
 * Ctrl+Alt+方向键、非焦点窗格内联批准、最大化、改动页占满、终端搜索跟随焦点、关闭窗格回到单窗格、
 * 侧栏拖放拆分与替换、满四格只能替换、结束会话关闭窗格、重启恢复与坏数据回退、窗口过窄自动退化。
 * 用例顺序执行、共享同一实例与布局状态。
 */

const W = 2000;
const H = 1000;

describe('多窗格布局', () => {
  const app = useApp();
  const ids: Record<string, string> = {};
  const labels: Record<string, string> = { A: '窗格甲', B: '窗格乙', C: '窗格丙', D: '窗格丁', E: '窗格戊' };

  const pane = (k: string) => `.mp-pane[data-session-id="${ids[k]}"]`;
  const paneCount = () => app.count('#pane-area .mp-pane');
  const visiblePanes = () => app.eval<number>(`[...document.querySelectorAll('#pane-area .mp-pane')].filter(p => !p.closest('[hidden]')).length`);
  const layout = () => app.eval<any>(`JSON.parse(localStorage.getItem('nexus.paneLayout') ?? 'null')`);
  const focusPaneSid = () => app.eval<string | null>(`document.querySelector('#pane-area .mp-pane.focus')?.dataset.sessionId ?? null`);
  const activePaneSid = () => app.eval<string | null>(`document.activeElement?.closest('.mp-pane')?.dataset.sessionId ?? null`);
  const imeLeft = () => app.eval<string>(`document.querySelector('#app').style.getPropertyValue('--ime-left')`);
  const markOf = (k: string) => app.exists(`${rowSel(ids[k])} .mp-mark`);

  /** 在窗格里按下鼠标再点击，等同用户点进窗格的终端 */
  const clickPane = async (k: string) => {
    await app.eval(`(() => {
      const p = document.querySelector(${q(pane(k))});
      const host = p.querySelector('.terminal-host');
      const r = host.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const target = document.elementFromPoint(x, y) ?? host;
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1, clientX: x, clientY: y, pointerType: 'mouse', isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
      return true;
    })()`);
    await app.until(async () => (await selectedSessionId(app)) === ids[k], { message: `点击后选中 ${k}` });
  };

  /** 空占位点「选择会话」后在命令面板里按标签选中会话 */
  const pickInto = async (emptySel: string, k: string) => {
    await app.click(`${emptySel} .mp-empty-in`);
    await app.waitVisible('#palette-backdrop');
    await app.fill('#palette-input', labels[k]);
    await app.waitFor(`[...document.querySelectorAll('.pal-i')].some(r => r.textContent.includes(${q(labels[k])}))`, { message: `面板列出 ${k}` });
    await app.press('Enter');
    await app.waitVisible(pane(k));
  };

  it('准备五个会话；单窗格外观与现状一致', async () => {
    await app.viewport(W, H);
    for (const k of ['A', 'B', 'C', 'D', 'E']) {
      ids[k] = await createSessionViaForm(app, labels[k], mkWorkDir(app, `mp-${k.toLowerCase()}`));
      await waitOutput(app, ids[k], 'mock-claude 已启动');
    }
    await app.click(rowSel(ids.A));
    await app.until(async () => (await selectedSessionId(app)) === ids.A, { message: '选中 A' });
    await app.waitVisible('#term-card');
    expect(await app.visible('#pane-area')).toBe(false);
    expect(await app.visible('#pane-note')).toBe(false);
    expect(await app.count('.mp-h')).toBe(0);
    expect(await app.count('#session-list .mp-mark')).toBe(0);
    expect(await app.exists('#pane-foot')).toBe(false);
    expect(await app.text('#pane-tabs-hint')).toBe('');
    expect(await imeLeft()).toBe('');
    // 单窗格下切换会话不写布局：要么从未写入，要么是单个空占位
    const l = await layout();
    expect(l === null || JSON.stringify(l) === JSON.stringify({ v: 1, focus: 'p1', root: { t: 'leaf', id: 'p1', sid: null } })).toBe(true);
  });

  it('命令面板向右拆出空占位：属性面板自动收起，可临时展开', async () => {
    await app.press('Control+Shift+K');
    await app.waitVisible('#palette-backdrop');
    await app.fill('#palette-input', '向右拆出新窗格');
    await app.waitFor(`[...document.querySelectorAll('.pal-i')].some(r => r.textContent.includes('窗格：向右拆出新窗格'))`, { message: '面板有拆分命令' });
    await app.press('Enter');
    await app.waitVisible('#pane-area');
    expect(await paneCount()).toBe(2);
    expect(await app.text('.mp-pane.empty .mp-empty-in')).toContain('拖入会话或点此选择');
    expect(await app.text('.mp-pane.empty .mp-t')).toBe('（空窗格）');
    expect(await focusPaneSid()).toBe(ids.A);
    expect(await app.visible('#term-card')).toBe(false);
    await app.waitHidden('#inspector');
    expect(await app.eval(`document.querySelector('#btn-inspector').classList.contains('on')`)).toBe(false);
    await app.click('#btn-inspector');
    await app.waitVisible('#inspector');
    await app.click('#btn-inspector');
    await app.waitHidden('#inspector');
    expect(await markOf('A')).toBe(true);
    expect(await app.text('#pane-tabs-hint')).toBe('');
  });

  it('空占位点选会话：放入右窗格并成为焦点', async () => {
    await pickInto('.mp-pane.empty', 'B');
    await app.until(async () => (await selectedSessionId(app)) === ids.B, { message: '选中 B' });
    expect(await focusPaneSid()).toBe(ids.B);
    expect(await app.text('#pane-label')).toBe(labels.B);
    const l = await layout();
    expect(l.root.t).toBe('split');
    expect(l.root.dir).toBe('row');
    expect(l.root.children.map((c: any) => c.sid)).toEqual([ids.A, ids.B]);
  });

  it('每个窗格都能独立输入；连续推送期间 xterm 元素不迁移', async () => {
    await app.waitVisible(`${pane('A')} .xterm`);
    await app.waitVisible(`${pane('B')} .xterm`);
    await clickPane('A');
    await app.until(async () => (await activePaneSid()) === ids.A, { message: '键盘焦点在 A 窗格' });
    await app.type('hello-a');
    await waitOutput(app, ids.A, 'hello-a');
    await clickPane('B');
    await app.until(async () => (await activePaneSid()) === ids.B, { message: '键盘焦点在 B 窗格' });
    await app.type('hello-b');
    await waitOutput(app, ids.B, 'hello-b');
    expect(await app.output(ids.B)).not.toContain('hello-a');
    expect(await app.output(ids.A)).not.toContain('hello-b');
    for (const k of ['A', 'B']) {
      expect(await app.count(`${pane(k)} .xterm`)).toBe(1);
      expect(await app.eval<number>(`document.querySelector(${q(`${pane(k)} .xterm-rows`)}).children.length`)).toBeGreaterThanOrEqual(12);
    }
    await app.eval(`(() => {
      window.__mpMoves = 0;
      const mo = new MutationObserver(list => {
        for (const m of list) for (const n of [...m.addedNodes, ...m.removedNodes]) {
          if (n.nodeType === 1 && n.classList.contains('xterm')) window.__mpMoves++;
        }
      });
      mo.observe(document.querySelector('#pane-area'), { childList: true, subtree: true });
      window.__mpMo = mo;
      return true;
    })()`);
    // 只输入不回车：两边持续有输出与会话推送，但不提交任务
    for (let i = 0; i < 3; i++) {
      await app.eval(`window.panelApi.input(${q(ids.A)}, 'x')`);
      await app.eval(`window.panelApi.input(${q(ids.B)}, 'y')`);
      await new Promise(r => setTimeout(r, 1000));
    }
    expect(await app.eval<number>(`(() => { window.__mpMo.disconnect(); return window.__mpMoves; })()`)).toBe(0);
    await app.eval(`window.panelApi.input(${q(ids.A)}, '\\u0015')`);
    await app.eval(`window.panelApi.input(${q(ids.B)}, '\\u0015')`);
  });

  it('打开会话：未在窗格的替换焦点窗格，已在窗格的只移焦点', async () => {
    await app.click(rowSel(ids.C));
    await app.waitVisible(pane('C'));
    expect(await app.exists(pane('B'))).toBe(false);
    expect(await markOf('B')).toBe(false);
    expect(await markOf('C')).toBe(true);
    expect(await focusPaneSid()).toBe(ids.C);
    const before = JSON.stringify((await layout()).root.children.map((c: any) => c.id));
    const idxA = await app.eval<string>(`(document.querySelector(${q(rowSel(ids.A))})?.title.match(/Ctrl\\+(\\d)/) ?? [])[1] ?? ''`);
    expect(idxA).not.toBe('');
    await app.blur();
    await app.press(`Control+${idxA}`);
    await app.until(async () => (await focusPaneSid()) === ids.A, { message: 'Ctrl+数字后焦点在 A' });
    expect(JSON.stringify((await layout()).root.children.map((c: any) => c.id))).toBe(before);
    expect(await paneCount()).toBe(2);
  });

  it('窗格头向下拆分，再从空占位放入 D', async () => {
    await app.click(`${pane('C')} [data-act="split-down"]`);
    await app.until(async () => (await paneCount()) === 3, { message: '3 个窗格' });
    await pickInto('.mp-pane.empty', 'D');
    const l = await layout();
    expect(l.root.dir).toBe('row');
    expect(l.root.children[0].sid).toBe(ids.A);
    expect(l.root.children[1].dir).toBe('col');
    expect(l.root.children[1].children.map((c: any) => c.sid)).toEqual([ids.C, ids.D]);
  });

  it('拖动分隔条调比例并显示列数，双击恢复等分', async () => {
    const div = '#pane-area > .mp-split > .mp-div';
    const tip = await app.eval<string>(`(() => {
      const d = document.querySelector(${q(div)});
      const r = d.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + 200;
      const ev = (type, cx) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1, clientX: cx, clientY: y, pointerType: 'mouse', isPrimary: true });
      d.dispatchEvent(ev('pointerdown', x));
      d.dispatchEvent(ev('pointermove', x + 150));
      d.dispatchEvent(ev('pointermove', x + 300));
      const text = d.querySelector('.mp-tip')?.textContent ?? '';
      d.dispatchEvent(ev('pointerup', x + 300));
      return text;
    })()`);
    expect(tip).toContain('列');
    await app.until(async () => (await layout()).root.sizes[0] > 0.55, { message: '左侧占比变大' });
    expect(await app.exists('.mp-div.on')).toBe(false);
    await app.eval(`document.querySelector(${q(div)}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await app.until(async () => Math.abs((await layout()).root.sizes[0] - 0.5) < 0.01, { message: '双击恢复等分' });
  });

  it('按卡片矩形估算的列行与 xterm 实际列行相差不超过 1', async () => {
    // 与 DEFAULT_CELL_METRICS 的 padX、padY、chromeH 及 APPROVE_BAR_PX 保持一致
    const diffs = () => app.eval<{ id: string; est: number[]; real: number[] }[]>(`(() => {
      const cv = document.createElement('canvas').getContext('2d');
      cv.font = '13px "Cascadia Code", "Cascadia Mono", Consolas, monospace';
      const cw = cv.measureText('M'.repeat(100)).width / 100;
      return [...document.querySelectorAll('#pane-area .mp-pane:not(.empty)')].map(p => {
        const r = p.getBoundingClientRect();
        const row = p.querySelector('.xterm-rows > div');
        const lh = row ? row.offsetHeight : 15;
        const approve = p.querySelector('.mp-approve');
        const extra = approve && !approve.hidden ? 33 : 0;
        const scr = p.querySelector('.xterm-screen');
        return {
          id: p.dataset.sessionId,
          est: [Math.floor((r.width - 16) / cw), Math.floor((r.height - 32 - extra - 10) / lh)],
          real: [scr ? Math.round(scr.getBoundingClientRect().width / cw) : -1, p.querySelectorAll('.xterm-rows > div').length],
        };
      });
    })()`);
    let last: { id: string; est: number[]; real: number[] }[] = [];
    await app.until(async () => {
      last = await diffs();
      return last.length === 3 && last.every(d => Math.abs(d.est[0] - d.real[0]) <= 1 && Math.abs(d.est[1] - d.real[1]) <= 1);
    }, { timeout: 5000, message: '估算列行与实际一致' }).catch(() => {
      throw new Error(`估算与实际不符：${JSON.stringify(last)}`);
    });
  });

  it('Ctrl+Alt+方向键在窗格间移动焦点，输入法锚点跟随', async () => {
    await clickPane('A');
    const imeNear = async (k: string) => {
      const d = await app.eval<number>(`(() => {
        const left = parseFloat(document.querySelector('#app').style.getPropertyValue('--ime-left'));
        return left - document.querySelector(${q(`${pane(k)} .terminal-host`)}).getBoundingClientRect().left;
      })()`);
      return d >= 10 && d <= 30;
    };
    expect(await imeNear('A')).toBe(true);
    await app.press('Control+Alt+ArrowRight');
    await app.until(async () => (await selectedSessionId(app)) === ids.C, { message: '向右到 C' });
    expect(await focusPaneSid()).toBe(ids.C);
    await app.until(() => imeNear('C'), { message: '锚点跟到 C' });
    await app.press('Control+Alt+ArrowDown');
    await app.until(async () => (await selectedSessionId(app)) === ids.D, { message: '向下到 D' });
    await app.press('Control+Alt+ArrowLeft');
    await app.until(async () => (await selectedSessionId(app)) === ids.A, { message: '向左到 A' });
    await app.press('Control+Alt+ArrowLeft');
    await new Promise(r => setTimeout(r, 300));
    expect(await selectedSessionId(app)).toBe(ids.A);
    expect(await focusPaneSid()).toBe(ids.A);
  });

  it('非焦点窗格等批准：橙色头与内联批准条，允许后消失，焦点不动', async () => {
    await sendLine(app, ids.C, 'mp-perm-c');
    await waitStatus(app, ids.C, 'waiting_permission');
    await app.waitVisible(`${pane('C')} .mp-approve`);
    expect(await app.eval(`document.querySelector(${q(pane('C'))}).classList.contains('attn')`)).toBe(true);
    const text = await app.text(`${pane('C')} .mp-approve`);
    expect(text).toContain('Bash');
    expect(text).toContain('echo mp-perm-c');
    expect(await app.visible('#permission-bar')).toBe(false);
    await app.click(`${pane('C')} .mp-approve [data-choice="yes"]`);
    await waitStatus(app, ids.C, 'completed');
    await app.waitHidden(`${pane('C')} .mp-approve`);
    expect(await app.eval(`document.querySelector(${q(pane('C'))}).classList.contains('attn')`)).toBe(false);
    expect(await selectedSessionId(app)).toBe(ids.A);
  });

  it('焦点窗格等批准：走底部审批条，Y 批准', async () => {
    await sendLine(app, ids.A, 'mp-perm-a');
    await waitStatus(app, ids.A, 'waiting_permission');
    await app.waitVisible('#permission-bar');
    expect(await app.visible(`${pane('A')} .mp-approve`)).toBe(false);
    await app.blur();
    await app.press('y');
    await waitStatus(app, ids.A, 'completed');
    await app.waitHidden('#permission-bar');
  });

  it('最大化只留焦点窗格，提示条的会话标签可切回网格', async () => {
    await clickPane('A');
    await app.press('Control+Shift+M');
    await app.waitFor(`document.querySelector('#pane-area').dataset.mode === 'max'`, { message: '进入最大化' });
    expect(await visiblePanes()).toBe(1);
    expect(await app.visible(pane('A'))).toBe(true);
    await app.waitVisible('#pane-note');
    expect(await app.text('#pane-note')).toContain('已最大化');
    expect(await app.count('#pane-note .mp-chip')).toBe(2);
    await app.click(`#pane-note .mp-chip[data-session-id="${ids.C}"]`);
    await app.waitFor(`document.querySelector('#pane-area').dataset.mode === 'grid'`, { message: '回到网格' });
    await app.until(async () => (await selectedSessionId(app)) === ids.C, { message: '焦点到 C' });
    expect(await visiblePanes()).toBe(3);
    await app.waitHidden('#pane-note');
    await app.press('Control+Shift+M');
    await app.waitFor(`document.querySelector('#pane-area').dataset.mode === 'max'`, { message: '再次最大化' });
    await app.press('Control+Shift+M');
    await app.waitFor(`document.querySelector('#pane-area').dataset.mode === 'grid'`, { message: '还原' });
  });

  it('改动标签占满详情区，Esc 返回网格；提示条会话标签切焦点', async () => {
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    expect(await app.visible('#pane-area')).toBe(false);
    await app.waitVisible('#pane-note');
    expect(await app.text('#pane-note')).toContain('改动');
    expect(await app.count('#pane-note .mp-chip')).toBe(2);
    expect(await app.text('#pane-tabs-hint')).toBe('← 返回 3 个窗格');
    expect(await app.eval<string>(`document.querySelector('#pane-tabs-hint .mp-back').title`)).toContain('Esc');
    await app.focus('.chg-list');
    await app.press('Escape');
    await app.waitVisible('#pane-area');
    expect(await visiblePanes()).toBe(3);
    expect(await selectedSessionId(app)).toBe(ids.C);
    await app.press('Control+Shift+D');
    await app.waitVisible('#changes-host');
    await app.click(`#pane-note .mp-chip[data-session-id="${ids.D}"]`);
    await app.waitVisible('#pane-area');
    await app.until(async () => (await selectedSessionId(app)) === ids.D, { message: '焦点到 D' });
    expect(await focusPaneSid()).toBe(ids.D);
  });

  it('终端搜索挂在焦点窗格上，不压住窗格头', async () => {
    await clickPane('D');
    await app.press('Control+F');
    await app.waitVisible(`${pane('D')} .tsearch`);
    expect(await app.count('#pane-area .tsearch')).toBe(1);
    const gap = await app.eval<number>(`document.querySelector(${q(`${pane('D')} .tsearch`)}).getBoundingClientRect().top
      - document.querySelector(${q(`${pane('D')} .mp-h`)}).getBoundingClientRect().bottom`);
    expect(gap).toBeGreaterThanOrEqual(0);
    await app.press('Escape');
    await app.waitHidden(`${pane('D')} .tsearch`);
  });

  it('关闭窗格不结束会话；只剩一个窗格时回到单窗格外观', async () => {
    await app.click(`${pane('D')} [data-act="close"]`);
    await app.until(async () => (await paneCount()) === 2, { message: '剩 2 个窗格' });
    const d = await app.session(ids.D);
    expect(d).toBeTruthy();
    expect(d!.exitCode).toBeUndefined();
    expect(await markOf('D')).toBe(false);
    await app.click(`${pane('C')} [data-act="close"]`);
    await app.waitVisible('#term-card');
    expect(await app.visible('#pane-area')).toBe(false);
    expect(await app.count('.mp-h')).toBe(0);
    await app.waitVisible('#inspector');
    expect(await app.text('#pane-tabs-hint')).toBe('');
    expect(await imeLeft()).toBe('');
    expect(await selectedSessionId(app)).toBe(ids.A);
    expect(await app.exceptions()).toEqual([]);
  });

  /**
   * 从侧栏行开始拖到目标元素的某个区域。release 为 false 时停在目标上不松开，
   * 返回落点层各区域的类名快照，供断言禁用区、命中区与说明文字
   */
  const drag = async (k: string, targetSel: string, zone: 'left' | 'right' | 'top' | 'bottom' | 'center', release = true) =>
    app.eval<{ zones: Record<string, string>; texts: Record<string, string>; src: boolean; ghost: string }>(`(() => {
      const row = document.querySelector(${q(rowSel(ids[k]))});
      const rr = row.getBoundingClientRect();
      const ev = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1, clientX: x, clientY: y, pointerType: 'mouse', isPrimary: true });
      const sx = rr.left + 40, sy = rr.top + rr.height / 2;
      row.dispatchEvent(ev('pointerdown', sx, sy));
      window.dispatchEvent(ev('pointermove', sx + 10, sy + 10));
      const t = document.querySelector(${q(targetSel)});
      const r = t.getBoundingClientRect();
      const pos = {
        center: [r.left + r.width / 2, r.top + r.height / 2],
        right: [r.right - r.width * 0.08, r.top + r.height / 2],
        left: [r.left + r.width * 0.08, r.top + r.height / 2],
        top: [r.left + r.width / 2, r.top + r.height * 0.08],
        bottom: [r.left + r.width / 2, r.bottom - r.height * 0.08],
      }[${q(zone)}];
      window.dispatchEvent(ev('pointermove', pos[0], pos[1]));
      const zones = {}, texts = {};
      for (const z of document.querySelectorAll('.mp-drop .mp-zone')) { zones[z.dataset.zone] = z.className; texts[z.dataset.zone] = z.textContent; }
      const snap = {
        zones, texts,
        src: !!document.querySelector(${q(`${rowSel(ids[k])}.mp-src`)}),
        ghost: document.querySelector('.mp-ghost')?.textContent ?? '',
      };
      if (${release}) window.dispatchEvent(ev('pointerup', pos[0], pos[1]));
      return snap;
    })()`);
  const releaseDrag = () => app.eval(`(() => { window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 })); return true; })()`);
  const sids = async () => {
    const l = await layout();
    const out: string[] = [];
    const walk = (n: any) => { if (n.t === 'leaf') out.push(n.sid); else n.children.forEach(walk); };
    if (l) walk(l.root);
    return out;
  };

  it('从侧栏拖到右缘拆分，拖到中央替换，拖入已在布局中的会话为移动', async () => {
    const snap = await drag('B', '#term-card', 'right', false);
    expect(snap.zones.right).toContain('hot');
    expect(snap.zones.center).not.toContain('hot');
    expect(snap.src).toBe(true);
    expect(snap.ghost).toContain(labels.B);
    expect(await app.exists('.mp-drop')).toBe(true);
    await releaseDrag();
    await app.until(async () => (await paneCount()) === 2, { message: '拖入后 2 个窗格' });
    expect(await sids()).toEqual([ids.A, ids.B]);
    await app.until(async () => (await selectedSessionId(app)) === ids.B, { message: '放入的会话成为焦点' });
    expect(await app.exists('.mp-ghost')).toBe(false);
    expect(await app.exists('.row.mp-src')).toBe(false);
    expect(await app.exists('.mp-drop')).toBe(false);

    const rep = await drag('C', pane('B'), 'center');
    expect(rep.zones.center).toContain('rep');
    expect(rep.texts.center).toContain(`替换为「${labels.C}」`);
    await app.waitVisible(pane('C'));
    expect(await sids()).toEqual([ids.A, ids.C]);

    await drag('A', pane('C'), 'bottom');
    await app.until(async () => (await layout()).root.dir === 'col', { message: '移动后为上下排列' });
    expect(await sids()).toEqual([ids.C, ids.A]);
    expect(await paneCount()).toBe(2);
  });

  it('满 4 格时四边禁用只能替换；中央替换后原会话回到侧栏', async () => {
    await drag('B', pane('A'), 'right');
    await app.waitVisible(pane('B'));
    await drag('D', pane('C'), 'right');
    await app.waitVisible(pane('D'));
    expect(await paneCount()).toBe(4);
    const snap = await drag('E', pane('C'), 'right', false);
    for (const z of ['top', 'bottom', 'left', 'right']) expect(snap.zones[z]).toContain('dis');
    expect(snap.texts.top).toContain('已达 4 个窗格上限，只能替换');
    await releaseDrag();
    await new Promise(r => setTimeout(r, 300));
    expect(await paneCount()).toBe(4);
    expect(await sids()).not.toContain(ids.E);
    const hot = await drag('E', pane('C'), 'center', false);
    expect(hot.zones.center).toContain('hot');
    expect(hot.zones.center).toContain('rep');
    await releaseDrag();
    await app.waitVisible(pane('E'));
    expect(await app.exists(pane('C'))).toBe(false);
    expect(await markOf('C')).toBe(false);
    expect(await markOf('E')).toBe(true);
    expect(await paneCount()).toBe(4);
  });

  it('结束会话：其窗格关闭，焦点转给相邻窗格，不回首页', async () => {
    await clickPane('E');
    await clickPaneMenu(app, 'end-session');
    await app.waitVisible('#confirm-buttons');
    await clickButton(app, '#confirm-buttons', '结束会话');
    await app.until(async () => !(await app.session(ids.E)), { timeout: 20_000, message: 'E 从列表移除' });
    await app.until(async () => (await paneCount()) === 3, { message: '剩 3 个窗格' });
    expect(await app.visible('#main-pane')).toBe(true);
    const sel = await selectedSessionId(app);
    expect(sel).toBe(ids.D);
    expect(await focusPaneSid()).toBe(ids.D);
  });

  it('重启后已不存在的会话变空占位并注明原会话名；坏数据回退单窗格', async () => {
    const write = (v: string) => app.eval(`(() => { localStorage.setItem('nexus.paneLayout', ${q(v)}); return true; })()`);
    await write(JSON.stringify({ v: 1, focus: 'p1', root: { t: 'split', dir: 'row', sizes: [0.5, 0.5], children: [
      { t: 'leaf', id: 'p1', sid: ids.A, label: labels.A }, { t: 'leaf', id: 'p2', sid: 'ghost-0000', label: '幽灵会话' }] } }));
    await app.reload();
    await app.viewport(W, H);
    await app.click(rowSel(ids.A));
    await app.until(async () => (await paneCount()) === 2, { message: '恢复 2 个窗格' });
    expect(await app.text('.mp-pane.empty .mp-empty-sub')).toBe('原会话「幽灵会话」已不存在');
    expect(await app.text('.mp-pane.empty .mp-st')).toBe('原会话已不存在');

    await write('{bad');
    await app.reload();
    await app.viewport(W, H);
    await app.click(rowSel(ids.A));
    await app.waitVisible('#term-card');
    expect(await app.visible('#pane-area')).toBe(false);
    expect(await app.exceptions()).toEqual([]);

    const leaf = (id: string, k: string) => ({ t: 'leaf', id, sid: ids[k], label: labels[k] });
    await write(JSON.stringify({ v: 1, focus: 'p1', root: { t: 'split', dir: 'row', sizes: [0.5, 0.5], children: [
      { t: 'split', dir: 'col', sizes: [0.5, 0.5], children: [leaf('p1', 'A'), leaf('p2', 'B')] },
      { t: 'split', dir: 'col', sizes: [0.5, 0.5], children: [leaf('p3', 'C'), leaf('p4', 'D')] }] } }));
    await app.reload();
  });

  it('退出保留后重启：四个窗格各显示续接卡片，续接其一只影响该窗格', async () => {
    for (const k of ['A', 'B', 'C', 'D']) await runTurn(app, ids[k], `mp-turn-${k.toLowerCase()}`);
    await app.eval(`window.panelApi.resumeSettingsSet({ onQuit: 'keep' })`);
    await app.restart();
    await app.viewport(W, H);
    for (const k of ['A', 'B', 'C', 'D']) await waitStatus(app, ids[k], 'suspended');
    await app.click(rowSel(ids.A));
    await app.until(async () => (await paneCount()) === 4, { message: '恢复 4 个窗格' });
    for (const k of ['A', 'B', 'C', 'D']) await app.waitVisible(`${pane(k)} .dormant-card[data-session="${ids[k]}"]`);
    await app.click(`${pane('A')} .dormant-card .dc-resume`);
    await waitStatus(app, ids.A, 'running', 20_000);
    await app.waitVisible(`${pane('A')} .xterm`);
    for (const k of ['B', 'C', 'D']) expect(await app.exists(`${pane(k)} .dormant-card`)).toBe(true);
  });

  it('窗口过窄自动只显示焦点窗格，变宽后恢复且不回弹；底部审批条不触发退化', async () => {
    await app.waitFor(`document.querySelector('#pane-area').dataset.mode === 'grid'`, { message: '初始为网格' });
    await app.viewport(1100, H);
    await app.waitFor(`document.querySelector('#pane-area').dataset.mode === 'narrow'`, { timeout: 3000, message: '退化为只显示焦点窗格' });
    expect(await visiblePanes()).toBe(1);
    expect(await app.visible(pane('A'))).toBe(true);
    const note = await app.text('#pane-note');
    expect(note).toContain('窗口太窄');
    expect(note).toContain('变宽后自动恢复');
    expect(await app.eval<string>(`document.querySelector('#pane-note .mp-note-t').title`)).toContain('列 ×');
    expect(await app.count('#pane-note .mp-chip')).toBe(3);

    await app.viewport(W, H);
    await app.waitFor(`document.querySelector('#pane-area').dataset.mode === 'grid'`, { timeout: 3000, message: '恢复网格' });
    expect(await visiblePanes()).toBe(4);
    const modes = await app.eval<string[]>(`new Promise(res => {
      const out = [];
      const t = setInterval(() => { out.push(document.querySelector('#pane-area').dataset.mode); if (out.length >= 15) { clearInterval(t); res(out); } }, 100);
    })`);
    expect(modes.every(m => m === 'grid')).toBe(true);

    await sendLine(app, ids.A, 'mp-perm-narrow');
    await waitStatus(app, ids.A, 'waiting_permission');
    await app.waitVisible('#permission-bar');
    await new Promise(r => setTimeout(r, 1200));
    expect(await app.eval(`document.querySelector('#pane-area').dataset.mode`)).toBe('grid');
    await app.click('#permission-bar .btn.white');
    await waitStatus(app, ids.A, 'completed');
    expect(await app.exceptions()).toEqual([]);
  });
});
