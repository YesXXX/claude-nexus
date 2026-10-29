import { describe, it, expect } from 'vitest';
import { useApp, q } from './harness';
import {
  appendJsonl, createSessionViaForm, isRowSelected, mkWorkDir, waitOutput, writeSubagentTranscript, xtermText,
} from './fixtures';

describe('子代理', () => {
  const app = useApp();
  const agentId = 'e2e0sub01';
  const task = '检查 e2e 子代理';
  const kidSel = `[data-role="child"][data-agent-id="${agentId}"]`;
  let id = '';
  let transcript = '';

  const subText = () => xtermText(app, '#subagent-pane');

  it('SubagentStart 后父会话下出现运行中的子代理行', async () => {
    id = await createSessionViaForm(app, '子代理用例', mkWorkDir(app, 'proj-sub'));
    await waitOutput(app, id, 'mock-claude 已启动');
    transcript = writeSubagentTranscript(app, agentId, [
      { type: 'user', message: { role: 'user', content: task } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '子代理第一步输出' }] } },
    ]);
    // agent_id 带 agent- 前缀，面板应剥掉前缀与文件名对齐
    expect(await app.postHook(id, {
      hook_event_name: 'SubagentStart', agent_id: `agent-${agentId}`, agent_type: 'Explore', agent_transcript_path: transcript,
    })).toBe(200);
    await app.waitFor(`!!document.querySelector(${q(kidSel)})`, { message: '子代理行出现' });
    expect(await app.eval(`document.querySelector(${q(kidSel)}).dataset.sessionId`)).toBe(id);
    expect(await app.text(kidSel)).toContain(task);
    const sub = (await app.session(id))?.subagents?.[0];
    expect(sub).toMatchObject({ agentId, status: 'running', description: task });
    // 运行中的子代理没有关闭按钮
    expect(await app.exists(`${kidSel} .kid-close`)).toBe(false);
  });

  it('点击子代理行进入只读子代理视图，显示任务与输出', async () => {
    await app.click(kidSel);
    await app.waitVisible('#subagent-pane');
    expect(await app.visible('#main-pane')).toBe(false);
    expect((await app.text('#subagent-label')).trim()).toBe(task);
    expect((await app.text('#subagent-parent')).trim()).toBe('子代理用例');
    await app.waitFor(`document.querySelector(${q(kidSel)})?.classList.contains('sel') === true`, { message: '子代理行选中' });
    await app.until(async () => {
      const t = await subText();
      return t.includes('▸ 任务') && t.includes(task) && t.includes('子代理第一步输出');
    }, { message: '子代理终端显示任务与输出' });
  });

  it('transcript 新增的行被轮询进子代理视图', async () => {
    appendJsonl(transcript, [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '子代理第二步输出' }] } },
    ]);
    await app.until(async () => (await subText()).includes('子代理第二步输出'), { message: '子代理终端显示追加的输出' });
  });

  it('Esc 返回父会话', async () => {
    await app.blur();
    await app.press('Escape');
    await app.waitVisible('#main-pane');
    expect(await app.visible('#subagent-pane')).toBe(false);
    expect(await isRowSelected(app, id)).toBe(true);
    expect(await app.eval(`document.querySelector(${q(kidSel)})?.classList.contains('sel')`)).toBe(false);
  });

  it('SubagentStop 后出现关闭按钮，点击后子代理行移除', async () => {
    expect(await app.postHook(id, {
      hook_event_name: 'SubagentStop', agent_id: `agent-${agentId}`, agent_transcript_path: transcript,
      last_assistant_message: '子代理完成',
    })).toBe(200);
    await app.until(async () => (await app.session(id))?.subagents?.[0]?.status === 'completed', { message: '子代理状态为 completed' });
    await app.waitFor(`!!document.querySelector(${q(`${kidSel} .kid-close`)})`, { message: '关闭按钮出现' });
    await app.click(`${kidSel} .kid-close`);
    await app.waitFor(`!document.querySelector(${q(kidSel)})`, { message: '子代理行移除' });
    expect((await app.session(id))?.subagents ?? []).toHaveLength(0);
    // 关闭按钮不冒泡成行点击，仍停在父会话
    expect(await app.visible('#main-pane')).toBe(true);
  });
});
