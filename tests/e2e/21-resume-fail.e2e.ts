import { describe, it, expect } from 'vitest';
import { useApp } from './harness';
import {
  clickButton, createSessionViaForm, exitSession, hasButton, mkWorkDir, runTurn, waitOutput, waitStatus,
} from './fixtures';

describe('续接失败识别', () => {
  // mock 在 --resume 时一律打印「No conversation found」并以 1 退出，模拟 CLI 找不到对话
  const app = useApp({ env: { CLAUDE_PANEL_MOCK_RESUME_FAIL: '1' } });
  let id = '';
  let claudeId = '';

  it('CLI 报找不到对话时标记续接失败，不自动重试，给出全新开始', async () => {
    id = await createSessionViaForm(app, '续接失败用例', mkWorkDir(app, 'proj-resume-fail'));
    claudeId = String((await app.session(id))?.claudeSessionId ?? '');
    expect(claudeId).not.toBe('');
    await runTurn(app, id, 'fail-e2e');
    await exitSession(app, id);
    await app.waitFor(`[...document.querySelectorAll('.resume-acts button')].some(b => b.textContent.trim() === '续接对话')`,
      { message: '续接对话按钮出现' });

    await clickButton(app, '.resume-acts', '续接对话');
    await waitOutput(app, id, 'No conversation found');
    const s = await waitStatus(app, id, 'error');
    expect(s.resumeFailure).toMatchObject({ reason: 'no_transcript' });
    expect(s.claudeSessionId).toBe(claudeId);
    await app.waitFor(`(document.querySelector('.resume-note.bad')?.textContent ?? '').includes('续接失败：CLI 找不到这段对话')`,
      { message: '页头显示续接失败原因' });
    expect(await hasButton(app, '.resume-acts', '全新开始')).toBe(true);
    // 只拉起过一次续接进程，没有自动重试
    await new Promise(r => setTimeout(r, 1500));
    expect(app.logs().split(`--resume ${claudeId}`).length - 1).toBe(1);
    expect((await app.session(id))?.status).toBe('error');
  });

  it('失败后全新开始恢复可用', async () => {
    await clickButton(app, '.resume-acts', '全新开始');
    const s = await app.until(async () => {
      const cur = await app.session(id);
      return cur && cur.status === 'running' && cur.claudeSessionId !== claudeId ? cur : undefined;
    }, { message: '全新开始后换了 Claude 会话 id' });
    expect(s.resumeFailure).toBeUndefined();
    await waitOutput(app, id, `会话 ${String(s.claudeSessionId)}`);
    await app.waitFor(`!document.querySelector('.resume-note.bad')`, { message: '失败提示消失' });
  });
});
