import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { q, useApp } from './harness';
import {
  clickButton, createSessionViaForm, exitSession, initGitRepo, sendLine, waitOutput, waitStatus,
} from './fixtures';

/**
 * 提示词模板：管理弹窗增删改复制与持久化、文件损坏备份；命令面板与 Ctrl+Shift+T 选模板，
 * 变量填写（内置变量、默认值、文件选择、必填校验）；插入与插入并发送（多行作为一次粘贴提交）；
 * 等待审批与进程退出时拒绝并说明原因；新建表单的模板按钮与存为模板。
 * 文件选择框在隔离实例里由 CLAUDE_PANEL_TEST_PICK_FILE 直接给出文件。
 */

const PS = '\x1b[200~';
const PE = '\x1b[201~';

interface Tpl { id: string; name: string; body: string; description?: string; useCount: number }

describe('提示词模板', () => {
  const app = useApp({
    env: {
      CLAUDE_PANEL_MOCK_INPUT_LOG: '{root}/mock-input.log',
      CLAUDE_PANEL_TEST_PICK_FILE: '{work}/proj-tpl/src/main.ts',
    },
  });
  const inputs = (): string[] => {
    const f = path.join(app.root, 'mock-input.log');
    return fs.existsSync(f)
      ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => (JSON.parse(l) as { data: string }).data)
      : [];
  };
  const templates = () => app.eval<Tpl[]>('window.panelApi.templates.list()');
  const save = (name: string, body: string) =>
    app.eval<{ ok: boolean }>(`window.panelApi.templates.save({ name: ${q(name)}, body: ${q(body)} })`);
  const disabled = (sel: string) => app.eval<boolean>(`document.querySelector(${q(sel)})?.disabled === true`);
  const value = (sel: string) => app.eval<string>(`document.querySelector(${q(sel)})?.value ?? ''`);
  const varInput = (name: string) => `#tpl-fill-backdrop [data-var="${name}"]`;

  /** Ctrl+Shift+T 打开只列模板的命令面板，按名称过滤后回车（shift 为真时 Shift+回车） */
  const pickFromPalette = async (name: string, shift = false): Promise<void> => {
    await app.press('Control+Shift+T');
    await app.waitVisible('#palette-backdrop');
    expect(await app.eval<string>(`document.querySelector('#palette-backdrop').dataset.scope`)).toBe('模板');
    await app.fill('#palette-input', name);
    await app.waitFor(`document.querySelector('#palette-list .pal-i.on .pt')?.textContent === ${q(name)}`,
      { message: `命令面板高亮模板「${name}」` });
    await app.press(shift ? 'Shift+Enter' : 'Enter');
  };

  it('管理弹窗：新建、修改、复制、删除，变量标签；重启后仍在；文件损坏时备份并以空列表启动', async () => {
    await app.press('Control+Shift+T');
    await app.waitVisible('#palette-backdrop');
    await app.fill('#palette-input', '新建模板');
    await app.press('Enter');
    await app.waitVisible('#tpl-manage-backdrop');
    await app.fill('#tpl-m-name', '代码审查');
    await app.fill('#tpl-m-desc', '审查当前分支');
    await app.fill('#tpl-m-body', '审查 {{分支}} 上的 {{模块}}，重点 {{重点:性能}}');
    await app.waitFor(`document.querySelectorAll('#tpl-m-vars .tpl-var.builtin').length === 1
      && document.querySelectorAll('#tpl-m-vars .tpl-var.custom').length === 2`, { message: '变量标签按内置与自定义区分' });
    await app.click('#tpl-m-save');
    await app.until(async () => (await templates()).length === 1, { message: '模板已保存' });
    const [first] = await templates();
    expect(first).toMatchObject({ name: '代码审查', description: '审查当前分支', useCount: 0 });
    await app.shot('templates-manage');

    await app.fill('#tpl-m-name', '代码审查（改）');
    await app.click('#tpl-m-save');
    await app.until(async () => (await templates())[0]?.name === '代码审查（改）', { message: '修改已保存' });
    expect((await templates())[0].id).toBe(first.id);

    await app.click('#tpl-m-dup');
    expect(await value('#tpl-m-name')).toBe('代码审查（改） 副本');
    await app.click('#tpl-m-save');
    await app.until(async () => (await templates()).length === 2, { message: '副本已保存' });
    await app.waitFor(`document.querySelectorAll('#tpl-m-list .tpl-m-item').length === 2`, { message: '列表两项' });

    await app.click('#tpl-m-delete');
    await app.waitVisible('#confirm-buttons');
    await clickButton(app, '#confirm-buttons', '删除');
    await app.until(async () => (await templates()).length === 1, { message: '副本已删除' });
    expect((await templates())[0].id).toBe(first.id);

    // 未保存的修改在关闭时要确认
    await app.fill('#tpl-m-body', '改了没存');
    await app.press('Escape');
    await app.waitVisible('#confirm-buttons');
    await clickButton(app, '#confirm-buttons', '放弃修改');
    await app.waitHidden('#tpl-manage-backdrop');

    await app.restart();
    expect((await templates()).map(t => t.name)).toEqual(['代码审查（改）']);

    const home = app.home;
    await app.restart({ between: () => { fs.writeFileSync(path.join(home, 'templates.json'), '{ 坏掉的 json'); } });
    expect(await templates()).toEqual([]);
    expect(fs.readdirSync(home).filter(f => f.startsWith('templates.json.bak-'))).toHaveLength(1);
    expect(await app.exceptions()).toEqual([]);
  });

  it('选中会话：填写变量后插入并发送，多行作为一次粘贴提交；等待审批与只插入', async () => {
    const repo = initGitRepo(app, 'proj-tpl', { 'src/main.ts': 'export {};\n' });
    expect((await save('多行检查', '检查 {{项目}} 的 {{分支}}\n关注：{{重点:性能}}\n文件：{{文件}}')).ok).toBe(true);
    expect((await save('单行插入', '只插入不发送')).ok).toBe(true);
    const id = await createSessionViaForm(app, '模板用例', repo);
    await waitOutput(app, id, 'mock-claude 已启动');
    await app.until(async () => (await app.session(id))?.pasteMode === true, { message: '粘贴模式开启' });

    await pickFromPalette('多行检查');
    await app.waitVisible('#tpl-fill-backdrop');
    expect(await value(varInput('项目'))).toBe('proj-tpl');
    expect(await value(varInput('分支'))).toBe('main');
    expect(await value(varInput('重点'))).toBe('');
    expect(await disabled('#tpl-fill-send')).toBe(true);
    expect(await app.text('#tpl-fill-note')).toContain('还需填写：文件');

    await app.click('#tpl-fill-backdrop [data-pick="文件"]');
    await app.waitFor(`document.querySelector(${q(varInput('文件'))}).value === 'src/main.ts'`, { message: '文件变量填入相对路径' });
    const text = '检查 proj-tpl 的 main\n关注：性能\n文件：src/main.ts';
    expect(await app.text('#tpl-fill-preview')).toBe(text);
    expect(await disabled('#tpl-fill-send')).toBe(false);
    await app.shot('templates-fill');
    await app.click('#tpl-fill-send');
    await app.waitHidden('#tpl-fill-backdrop');
    await waitOutput(app, id, '收到任务（3 行）："检查 proj-tpl 的 main"');
    const data = inputs();
    const pi = data.indexOf(`${PS}${text.replace(/\n/g, '\r')}${PE}`);
    expect(pi).toBeGreaterThanOrEqual(0);
    expect(data[pi + 1]).toBe('\r');
    expect(data.filter(d => d.includes('检查 proj-tpl'))).toHaveLength(1);
    await app.until(async () => (await templates()).find(t => t.name === '多行检查')?.useCount === 1, { message: '使用计数加一' });

    // 等待审批：带变量的模板两个动作都置灰并说明原因；无变量的直接提示
    await waitStatus(app, id, 'waiting_permission');
    await pickFromPalette('多行检查');
    await app.waitVisible('#tpl-fill-backdrop');
    await app.click('#tpl-fill-backdrop [data-pick="文件"]');
    await app.waitFor(`document.querySelector(${q(varInput('文件'))}).value === 'src/main.ts'`);
    expect(await disabled('#tpl-fill-send')).toBe(true);
    expect(await disabled('#tpl-fill-insert')).toBe(true);
    expect(await app.text('#tpl-fill-note')).toContain('确认权限');
    await app.press('Escape');
    await app.waitHidden('#tpl-fill-backdrop');
    const before = inputs().length;
    await pickFromPalette('单行插入');
    await app.waitFor(`document.querySelector('#toast-container')?.textContent.includes('确认权限')`, { message: '拒绝原因提示' });
    expect(inputs().slice(before).filter(d => d.includes('只插入不发送'))).toEqual([]);
    await sendLine(app, id, 'y');
    await waitStatus(app, id, 'completed');

    // Shift+回车只插入：写进输入框但不提交，用户回车后才执行
    await pickFromPalette('单行插入', true);
    await app.until(() => inputs().includes(`${PS}只插入不发送${PE}`), { message: '插入的粘贴块' });
    await new Promise(r => setTimeout(r, 600));
    expect(await app.output(id)).not.toContain('收到任务："只插入不发送"');
    expect((await app.session(id))?.status).toBe('completed');
    await sendLine(app, id, '');
    await waitOutput(app, id, '收到任务："只插入不发送"');
    await waitStatus(app, id, 'waiting_permission');
    await sendLine(app, id, 'n');
    await waitStatus(app, id, 'completed');

    // 进程退出后不能插入
    await exitSession(app, id);
    await pickFromPalette('单行插入');
    await app.waitFor(`document.querySelector('#toast-container')?.textContent.includes('已退出')`, { message: '退出原因提示' });
    expect(await app.exceptions()).toEqual([]);
  });

  it('新建表单：模板按钮选模板填入首条提示词，创建后自动发送；首条提示词可存为模板', async () => {
    const repo = path.join(app.work, 'proj-tpl');
    await app.click('#btn-new');
    await app.waitVisible('#main-empty');
    await app.fill('#form-cwd', repo);
    await app.click('#form-template');
    await app.waitVisible('#palette-backdrop');
    await app.fill('#palette-input', '多行检查');
    await app.waitFor(`document.querySelector('#palette-list .pal-i.on .pt')?.textContent === '多行检查'`);
    await app.press('Enter');
    await app.waitVisible('#tpl-fill-backdrop');
    expect(await app.exists('#tpl-fill-send')).toBe(false);
    expect(await value(varInput('项目'))).toBe('proj-tpl');
    await app.fill(varInput('重点'), '正确性');
    await app.click('#tpl-fill-backdrop [data-pick="文件"]');
    await app.waitFor(`document.querySelector(${q(varInput('文件'))}).value === 'src/main.ts'`);
    await app.click('#tpl-fill-fill');
    await app.waitHidden('#tpl-fill-backdrop');
    const text = '检查 proj-tpl 的 main\n关注：正确性\n文件：src/main.ts';
    expect(await value('#form-prompt')).toBe(text);

    await app.fill('#form-label', '表单模板用例');
    await app.focus('#form-prompt');
    const before = new Set((await app.list()).map(s => s.id));
    await app.press('Control+Enter');
    const id = await app.until(async () => (await app.list()).find(s => !before.has(s.id) && s.label === '表单模板用例')?.id,
      { timeout: 20_000, message: '新会话出现' });
    await waitOutput(app, id, '收到任务（3 行）："检查 proj-tpl 的 main"', 20_000);
    expect(inputs().filter(d => d.includes('关注：正确性'))).toHaveLength(1);

    await app.click('#btn-new');
    await app.waitVisible('#main-empty');
    await app.fill('#form-prompt', '表单里写好的提示词');
    await app.click('#form-template');
    await app.waitVisible('#palette-backdrop');
    await app.fill('#palette-input', '存为模板');
    await app.waitFor(`document.querySelector('#palette-list .pal-i.on .pt')?.textContent === '把首条提示词存为模板'`, { message: '面板有存为模板' });
    await app.press('Enter');
    await app.waitVisible('#tpl-manage-backdrop');
    expect(await value('#tpl-m-body')).toBe('表单里写好的提示词');
    await app.fill('#tpl-m-name', '来自表单');
    await app.click('#tpl-m-save');
    await app.until(async () => (await templates()).some(t => t.name === '来自表单'), { message: '存为模板' });
    await app.press('Escape');
    await app.waitHidden('#tpl-manage-backdrop');

    // 退格清除分组过滤，回到全部条目
    await app.press('Control+Shift+T');
    await app.waitVisible('#palette-backdrop');
    await app.press('Backspace');
    expect(await app.eval<string>(`document.querySelector('#palette-backdrop').dataset.scope`)).toBe('');
    await app.press('Escape');
    expect(await app.exceptions()).toEqual([]);
  });
});
