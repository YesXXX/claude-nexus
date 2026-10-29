import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { q, useApp } from './harness';
import { initGitRepo, mkWorkDir, selectedSessionId, waitOutput } from './fixtures';

/**
 * 会话预设：首页新建表单「预设 ▾」里的「把当前表单存为预设」保存组合（目录、独立工作区、首条提示词），
 * 「预设 ▾」打开命令面板的预设分组，选中即创建会话并发送首条提示词；
 * 工作目录不存在时明确报错；设置页「会话预设」分节可改名与删除；
 * presets.json 损坏时备份后以空列表启动。
 */

describe('会话预设', () => {
  const app = useApp();
  const presetsFile = (): string => path.join(app.home, 'presets.json');
  const list = () => app.eval<Array<{ id: string; name: string; cwd: string; worktree: boolean; branch?: string; initialPrompt?: string; useCount: number }>>(
    'window.panelApi.presets.list()');
  const toastHas = (text: string) => app.waitFor(
    `document.querySelector('#toast-container')?.textContent.includes(${q(text)})`, { message: `提示包含「${text}」` });
  /** 回到首页的新建表单 */
  const goHomeForm = async (): Promise<void> => {
    if (!(await app.visible('#main-empty'))) {
      await app.click('#btn-new');
      await app.waitVisible('#main-empty');
    }
  };
  /** 在设置分节里点某个预设行上的按钮 */
  const clickRowButton = (name: string, button: string): Promise<boolean> => app.eval<boolean>(
    `(() => { const row = [...document.querySelectorAll('#settings-preset-list .preset-row')]
      .find(r => r.querySelector('.preset-name')?.textContent === ${q(name)}); if (!row) return false;
      const btn = [...row.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === ${q(button)});
      if (!btn) return false; btn.click(); return true; })()`);

  it('新建表单「预设 ▾」存为预设：普通预设带首条提示词，独立工作区预设带分支', async () => {
    // 普通目录的预设
    await goHomeForm();
    await app.fill('#form-cwd', mkWorkDir(app, 'preset-a'));
    await app.fill('#form-prompt', '预设带来的任务');
    await app.click('#form-preset');
    await app.waitVisible('#palette-backdrop');
    await app.fill('#palette-input', '存为预设');
    await app.waitFor(`document.querySelector('#palette-list .pal-i.on .pt')?.textContent === '把当前表单存为预设'`, { message: '面板有存为预设' });
    await app.press('Enter');
    await app.waitVisible('#preset-dialog-backdrop');
    expect(await app.text('#preset-dialog-title')).toBe('存为预设');
    expect(await app.text('.preset-dialog-summary')).toContain('带首条提示词');
    // 名称必填：空名称保存给出提示且弹窗不关
    await app.click('#preset-dialog-save');
    expect(await app.text('#preset-dialog-error')).toBe('预设名称不能为空');
    await app.fill('#preset-dialog-name', '日常开发');
    await app.press('Enter');
    await app.waitHidden('#preset-dialog-backdrop');
    await toastHas('预设「日常开发」已保存');

    // git 仓库目录的独立工作区预设
    const repo = initGitRepo(app, 'preset-wt-repo', { 'a.txt': 'a\n' });
    await app.fill('#form-cwd', repo);
    await app.waitVisible('#wt-row');
    await app.waitFor(`document.querySelector('#wt-on')?.disabled === false`, { message: '工作区开关可用' });
    await app.click('#wt-on');
    await app.waitVisible('#wt-fields');
    await app.fill('#wt-branch', 'nexus/preset-wt');
    await app.click('#form-preset');
    await app.waitVisible('#palette-backdrop');
    await app.fill('#palette-input', '存为预设');
    await app.waitFor(`document.querySelector('#palette-list .pal-i.on .pt')?.textContent === '把当前表单存为预设'`, { message: '面板有存为预设' });
    await app.press('Enter');
    await app.waitVisible('#preset-dialog-backdrop');
    await app.fill('#preset-dialog-name', '工作区预设');
    await app.click('#preset-dialog-save');
    await app.waitHidden('#preset-dialog-backdrop');

    const presets = await list();
    expect(presets.map(p => p.name).sort()).toEqual(['工作区预设', '日常开发']);
    const plain = presets.find(p => p.name === '日常开发')!;
    expect(plain.cwd.replace(/\\/g, '/')).toContain('preset-a');
    expect(plain.worktree).toBe(false);
    const wt = presets.find(p => p.name === '工作区预设')!;
    expect(wt).toMatchObject({ worktree: true, branch: 'nexus/preset-wt' });
    expect(wt.cwd.replace(/\\/g, '/')).toContain('preset-wt-repo');
    expect(fs.existsSync(presetsFile())).toBe(true);
  });

  it('「预设 ▾」打开预设分组，选中即创建会话并发送首条提示词', async () => {
    await goHomeForm();
    await app.click('#form-preset');
    await app.waitVisible('#palette-backdrop');
    expect(await app.eval(`document.querySelector('#palette-backdrop')?.dataset.scope`)).toBe('预设');
    await app.waitFor(`[...document.querySelectorAll('#palette-list .pal-i .pt')]
      .some(t => t.textContent.includes('用预设新建：日常开发'))`, { message: '面板列出预设' });
    // 用名称过滤到目标预设再回车（同一更新时间的内容按保存先后排序，不依赖首行）
    await app.type('日常开发');
    await app.waitFor(`document.querySelectorAll('#palette-list .pal-i').length === 1
      && document.querySelector('#palette-list .pal-i .pt')?.textContent.includes('用预设新建：日常开发')`,
      { message: '过滤到日常开发' });
    expect(await app.eval(`document.querySelector('#palette-list .pal-i .ps')?.textContent`)).toContain('带首条提示词');
    await app.press('Enter');
    await app.waitHidden('#palette-backdrop');

    const id = await app.until(async () => {
      const s = (await app.list()).find(x => x.label === '日常开发');
      return s?.id;
    }, { timeout: 20_000, message: '按预设创建的会话出现' });
    await app.until(async () => (await selectedSessionId(app)) === id, { message: '新会话被选中' });
    expect(await app.text('#pane-label')).toContain('日常开发');
    await waitOutput(app, id, 'mock-claude 已启动');
    await waitOutput(app, id, '收到任务："预设带来的任务"', 20_000);
    await toastHas('已用预设「日常开发」创建会话');
    // 使用计数：最近使用的排在预设分组前面
    await goHomeForm();
    await app.click('#form-preset');
    await app.waitVisible('#palette-backdrop');
    await app.waitFor(`document.querySelector('#palette-list .pal-i .pt')?.textContent.includes('用预设新建：日常开发')`,
      { message: '最近使用的预设排最前' });
    await app.press('Escape');
    await app.waitHidden('#palette-backdrop');
  });

  it('工作目录不存在：保存允许，使用时明确报错且不创建会话', async () => {
    const bad = 'Z:\\panel-e2e-不存在的目录\\x';
    expect(await app.eval(`window.panelApi.presets.save(${JSON.stringify({ name: '坏预设', cwd: bad })})`))
      .toMatchObject({ ok: true });
    const before = (await app.list()).length;

    await app.blur();
    await app.press('Control+K');
    await app.waitVisible('#palette-backdrop');
    await app.type('坏预设');
    await app.waitFor(`document.querySelector('#palette-list .pal-i .pt')?.textContent.includes('用预设新建：坏预设')`,
      { message: '面板列出坏预设' });
    await app.press('Enter');
    await app.waitHidden('#palette-backdrop');
    await toastHas('工作目录不存在');
    await new Promise(r => setTimeout(r, 1000));
    expect((await app.list())).toHaveLength(before);
    expect(await app.exceptions()).toEqual([]);
  });

  it('设置页「会话预设」分节：改名与删除', async () => {
    // 面板可能因前面用例的失败留在打开状态，先关掉再开设置
    if (await app.visible('#palette-backdrop')) {
      await app.press('Escape');
      await app.waitHidden('#palette-backdrop');
    }
    await app.blur();
    await app.press('Control+Comma');
    await app.waitVisible('#settings-page');
    await app.click('#settings-nav .set-nav-i[data-key="presets-settings"]');
    await app.waitFor(`document.querySelectorAll('#settings-preset-list .preset-row').length === 3`,
      { message: '设置页列出 3 个预设' });
    // 用过一次的显示使用次数
    expect(await app.text('#settings-preset-list .preset-row .preset-count')).toContain('用过 1 次');

    await app.until(() => clickRowButton('日常开发', '改名'), { message: '点改名' });
    await app.waitVisible('#preset-dialog-backdrop');
    expect(await app.text('#preset-dialog-title')).toBe('预设改名');
    await app.fill('#preset-dialog-name', '日常开发2');
    await app.click('#preset-dialog-save');
    await app.waitHidden('#preset-dialog-backdrop');
    await app.waitFor(`[...document.querySelectorAll('#settings-preset-list .preset-name')].some(n => n.textContent === '日常开发2')`,
      { message: '列表更新为新名称' });
    const names = (await list()).map(p => p.name);
    expect(names).toContain('日常开发2');
    expect(names).not.toContain('日常开发');
    // 其他内容保持不变
    expect((await list()).find(p => p.name === '日常开发2')?.initialPrompt).toBe('预设带来的任务');
  });

  it('删除预设走确认框；取消不删，确认后从列表消失', async () => {
    await app.until(() => clickRowButton('坏预设', '删除'), { message: '点删除' });
    await app.waitVisible('#confirm-backdrop');
    expect(await app.text('#confirm-title')).toBe('删除预设？');
    await app.click('#confirm-cancel');
    await app.waitHidden('#confirm-backdrop');
    expect((await list()).map(p => p.name)).toContain('坏预设');

    await app.until(() => clickRowButton('坏预设', '删除'), { message: '再点删除' });
    await app.waitVisible('#confirm-backdrop');
    await app.click('#confirm-buttons .solid-danger');
    await app.waitHidden('#confirm-backdrop');
    await app.until(async () => (await list()).every(p => p.name !== '坏预设'), { message: '坏预设被删除' });
    await toastHas('已删除预设「坏预设」');
    expect(await app.exceptions()).toEqual([]);
  });

  it('presets.json 损坏：备份后以空列表启动，表单按钮给出引导提示', async () => {
    const file = presetsFile();
    for (const s of await app.list()) await app.eval(`window.panelApi.kill(${q(s.id)})`);
    await app.restart({
      between: () => { fs.writeFileSync(file, '{ 不是 json'); },
    });
    expect(await list()).toEqual([]);
    const baks = fs.readdirSync(app.home).filter(f => f.startsWith('presets.json.bak-'));
    expect(baks.length).toBe(1);
    expect(fs.readFileSync(path.join(app.home, baks[0]), 'utf8')).toBe('{ 不是 json');

    // 空列表时「预设 ▾」仍打开预设分组，只剩「把当前表单存为预设」与管理入口
    await goHomeForm();
    await app.click('#form-preset');
    await app.waitVisible('#palette-backdrop');
    await app.waitFor(`[...document.querySelectorAll('#palette-list .pal-i .pt')].some(t => t.textContent === '把当前表单存为预设')`, { message: '空列表时有存为预设' });
    expect(await app.eval<boolean>(`[...document.querySelectorAll('#palette-list .pal-i .pt')].some(t => t.textContent.startsWith('用预设新建'))`)).toBe(false);
    await app.press('Escape');
    await app.waitHidden('#palette-backdrop');
    expect(await app.exceptions()).toEqual([]);
  });
});
