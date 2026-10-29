import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { useApp, q } from './harness';
import {
  clickButton, createSessionViaForm, exitSession, hasButton, mkWorkDir, recordOf, runTurn, transcriptFile, waitOutput,
  waitStatus, writeSubagentTranscript,
} from './fixtures';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('会话续接', () => {
  const app = useApp();
  const agentId = 'e2e0res01';
  let id = '';
  let claudeId = '';

  it('新建会话立即拿到 Claude 会话 id，属性面板「对话」分区显示 id', async () => {
    id = await createSessionViaForm(app, '续接用例', mkWorkDir(app, 'proj-resume'));
    const s = (await app.session(id))!;
    claudeId = String(s.claudeSessionId ?? '');
    expect(claudeId).toMatch(UUID);
    await waitOutput(app, id, `会话 ${claudeId}`);
    expect(app.logs()).toContain(`--session-id ${claudeId}`);
    await app.waitFor(`(document.querySelector('.conv-sec')?.textContent ?? '').includes(${q(claudeId.slice(0, 8))})`,
      { message: '属性面板显示 Claude 会话 id' });
  });

  it('跑一轮并带上子代理，进程退出后页头出现「续接对话」', async () => {
    await runTurn(app, id, 'resume-e2e');
    expect(transcriptFile(app, claudeId)).not.toBeNull();
    const transcript = writeSubagentTranscript(app, agentId, [
      { type: 'user', message: { role: 'user', content: '续接用例的子代理' } },
    ]);
    await app.postHook(id, { hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'Explore', agent_transcript_path: transcript });
    await app.postHook(id, { hook_event_name: 'SubagentStop', agent_id: agentId, agent_transcript_path: transcript });
    await app.until(async () => (await app.session(id))?.subagents?.[0]?.status === 'completed', { message: '子代理完成' });
    await exitSession(app, id);
    await app.waitFor(`[...document.querySelectorAll('.resume-acts button')].some(b => b.textContent.trim() === '续接对话' && !b.disabled)`,
      { message: '续接对话按钮可用' });
    await app.waitFor(`(document.querySelector('.conv-sec')?.textContent ?? '').includes('✓ 存在')`, { message: '对话记录存在' });
  });

  it('续接重启：面板 id 与 Claude 会话 id 不变，子代理保留，续接次数加一', async () => {
    await clickButton(app, '.resume-acts', '续接对话');
    await waitOutput(app, id, '已续接，历史 1 条');
    const s = await waitStatus(app, id, 'running');
    expect(s.claudeSessionId).toBe(claudeId);
    expect((await app.list()).filter(x => x.id === id)).toHaveLength(1);
    expect(s.subagents?.map(x => x.agentId)).toEqual([agentId]);
    expect(app.logs()).toContain(`--resume ${claudeId}`);
    await app.until(async () => (await recordOf(app, id))?.resumeCount === 1, { message: '记录的续接次数为 1' });
    expect(await app.exists(`[data-role="child"][data-agent-id="${agentId}"]`)).toBe(true);
  });

  it('全新开始：换新的 Claude 会话 id，子代理清空', async () => {
    await exitSession(app, id);
    await app.waitFor(`[...document.querySelectorAll('.resume-acts button')].some(b => b.textContent.trim() === '全新开始')`,
      { message: '全新开始按钮出现' });
    await clickButton(app, '.resume-acts', '全新开始');
    const s = await app.until(async () => {
      const cur = await app.session(id);
      return cur && cur.status === 'running' && cur.claudeSessionId !== claudeId ? cur : undefined;
    }, { message: 'Claude 会话 id 已变化' });
    expect(String(s.claudeSessionId)).toMatch(UUID);
    expect(s.subagents ?? []).toHaveLength(0);
    const rec = await recordOf(app, id);
    expect(rec?.claudeSessionIds).toEqual([claudeId, s.claudeSessionId]);
    claudeId = String(s.claudeSessionId);
  });

  it('对话记录缺失：续接不可用并说明原因，全新开始为主按钮', async () => {
    // 全新开始后没有提交过任务，新 id 没有对话记录
    expect(transcriptFile(app, claudeId)).toBeNull();
    await exitSession(app, id);
    await app.waitFor(`(document.querySelector('.resume-note.info')?.title ?? '').includes('找不到这段对话的记录')`,
      { message: '显示对话记录缺失原因' });
    expect(await hasButton(app, '.resume-acts', '续接对话')).toBe(false);
    expect(await app.eval(`[...document.querySelectorAll('.resume-acts button.white')].map(b => b.textContent.trim())`)).toEqual(['全新开始']);
    const check = await app.eval<{ resumable: boolean; reason: string }>(`window.panelApi.resumeCheck(${q(id)})`);
    expect(check).toMatchObject({ resumable: false, reason: 'no_transcript' });
    await app.waitFor(`(document.querySelector('.conv-sec')?.textContent ?? '').includes('缺失')`, { message: '属性面板显示记录缺失' });
  });

  it('对话记录在退出后被删：点续接被拒绝且不拉起进程，随后显示原因', async () => {
    await clickButton(app, '.resume-acts', '全新开始');
    const s = await app.until(async () => {
      const cur = await app.session(id);
      return cur && cur.status === 'running' && cur.claudeSessionId !== claudeId ? cur : undefined;
    }, { message: '再次全新开始' });
    claudeId = String(s.claudeSessionId);
    await runTurn(app, id, 'second-e2e');
    await exitSession(app, id);
    await app.waitFor(`[...document.querySelectorAll('.resume-acts button')].some(b => b.textContent.trim() === '续接对话')`,
      { message: '有记录时可续接' });
    fs.rmSync(transcriptFile(app, claudeId)!);
    const spawns = () => app.logs().split(`spawn 会话 ${id.slice(0, 8)}`).length - 1;
    const before = spawns();
    // 按钮仍是退出时的检查结果；点击时主进程重新检查并拒绝
    await clickButton(app, '.resume-acts', '续接对话');
    await app.waitFor(`(document.querySelector('.resume-note.info')?.title ?? '').includes('找不到这段对话的记录')`,
      { message: '被拒后显示原因' });
    expect(await hasButton(app, '.resume-acts', '续接对话')).toBe(false);
    expect((await app.session(id))?.status).not.toBe('running');
    expect(spawns()).toBe(before);
  });
});
