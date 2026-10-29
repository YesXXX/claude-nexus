import { describe, it, expect } from 'vitest';
import { NotificationService } from '../src/main/notification-service';
import { NotificationPayload, Session } from '../src/shared/types';

const base: Session = {
  id: 's1', label: '重构用户模块', cwd: 'D:\\p', status: 'running',
  statusSince: 0, createdAt: 0, escalated: false,
};

function makeService() {
  const notifications: NotificationPayload[] = [];
  const svc = new NotificationService({ escalateAfterMs: 5 * 60_000 });
  svc.subscribe(n => notifications.push(n));
  return { svc, notifications };
}

describe('onTransition 状态变化触发订阅通知', () => {
  it('进入 waiting_permission：标题含任务标签，正文含命令文本', () => {
    const { svc, notifications } = makeService();
    svc.onTransition(base, {
      ...base, status: 'waiting_permission',
      pendingAction: { toolName: 'Bash', commandText: 'rm -rf node_modules' },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toContain('重构用户模块');
    expect(notifications[0].title).toContain('请求授权');
    expect(notifications[0].body).toContain('rm -rf node_modules');
    expect(notifications[0].level).toBe('warning');
    expect(notifications[0].sessionId).toBe('s1');
  });

  it('进入 waiting_input / completed / error / disconnected 都发通知', () => {
    const { svc, notifications } = makeService();
    svc.onTransition(base, { ...base, status: 'waiting_input' });
    svc.onTransition(base, { ...base, status: 'completed' });
    svc.onTransition(base, { ...base, status: 'error', exitCode: 1 });
    svc.onTransition(base, { ...base, status: 'disconnected', exitCode: null });
    expect(notifications).toHaveLength(4);
    expect(notifications[0].level).toBe('info');      // waiting_input
    expect(notifications[1].level).toBe('success');   // completed
    expect(notifications[2].level).toBe('error');     // error
    expect(notifications[2].title).toContain('异常退出');
    expect(notifications[2].body).toContain('1');
    expect(notifications[3].level).toBe('error');     // disconnected
    expect(notifications[3].title).toContain('失联');
    expect(notifications[1].title).toContain('已搞定');
  });

  it('带 resumeFailure 的 error 用续接失败文案', () => {
    const { svc, notifications } = makeService();
    svc.onTransition(base, { ...base, status: 'error', exitCode: 1,
      resumeFailure: { reason: 'no_transcript', exitCode: 1, at: 1 } });
    svc.onTransition(base, { ...base, status: 'error', exitCode: 3,
      resumeFailure: { reason: 'exited_early', exitCode: 3, at: 1 } });
    expect(notifications.map(n => n.title)).toEqual(['❌ 「重构用户模块」续接失败', '❌ 「重构用户模块」续接失败']);
    expect(notifications[0].body).toContain('找不到这段对话');
    expect(notifications[1].body).toContain('退出码 3');
  });

  it('进入 running 不发通知；状态未变不发', () => {
    const { svc, notifications } = makeService();
    svc.onTransition(base, { ...base, status: 'running' });
    svc.onTransition(base, base);
    expect(notifications).toHaveLength(0);
  });

  it('订阅者抛错不影响其他订阅者', () => {
    const svc = new NotificationService();
    const b: NotificationPayload[] = [];
    svc.subscribe(() => { throw new Error('boom'); });
    svc.subscribe(n => b.push(n));
    svc.onTransition(base, { ...base, status: 'completed' });
    expect(b).toHaveLength(1);
  });
});

describe('subscribe 返回取消订阅函数', () => {
  it('取消后不再接收', () => {
    const svc = new NotificationService();
    const got: NotificationPayload[] = [];
    const unsub = svc.subscribe(n => got.push(n));
    svc.onTransition(base, { ...base, status: 'completed' });
    unsub();
    svc.onTransition(base, { ...base, status: 'error' });
    expect(got).toHaveLength(1);
  });
});

describe('全局通知', () => {
  it('不带会话 id 时 sessionId 为空，带会话 id 时透传', () => {
    const { svc, notifications } = makeService();
    svc.notifyGlobal('warning', '今日用量已达预算的 80%', '今日已知费用 $8.00');
    svc.notifyGlobal('error', '上下文已用 96%', '96k / 100k', 's1');
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toMatchObject({ level: 'warning', title: '今日用量已达预算的 80%', body: '今日已知费用 $8.00' });
    expect(notifications[0].sessionId).toBeUndefined();
    expect(notifications[0].id).toBeTruthy();
    expect(notifications[1]).toMatchObject({ level: 'error', sessionId: 's1' });
  });
});

describe('tick 超时升级', () => {
  const waiting = (since: number, escalated = false): Session =>
    ({ ...base, status: 'waiting_permission', statusSince: since, escalated });

  it('等待超阈值且未升级过 → 重新通知并返回 id', () => {
    const { svc, notifications } = makeService();
    const ids = svc.tick([waiting(0)], 6 * 60_000);
    expect(ids).toEqual(['s1']);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toContain('仍在等待');
    expect(notifications[0].level).toBe('warning');
  });

  it('未超阈值 / 已升级过 / 非等待状态 → 都不触发', () => {
    const { svc, notifications } = makeService();
    expect(svc.tick([waiting(4 * 60_000)], 6 * 60_000)).toEqual([]);
    expect(svc.tick([waiting(0, true)], 9 * 60_000)).toEqual([]);
    expect(svc.tick([{ ...base, status: 'running', statusSince: 0 }], 9 * 60_000)).toEqual([]);
    expect(notifications).toHaveLength(0);
  });
});

describe('待续接不打扰', () => {
  it('进入或离开 suspended 都不发通知', () => {
    const { svc, notifications } = makeService();
    svc.onTransition(base, { ...base, status: 'suspended' });
    svc.onTransition({ ...base, status: 'suspended' }, { ...base, status: 'running' });
    expect(notifications).toHaveLength(0);
  });
});

describe('结构化通知 kind 与 meta', () => {
  const at = { ...base, cwd: 'D:/work/app/' };

  it('状态类通知带 kind、会话标签、cwd 末段与状态描述，标题正文不变', () => {
    const { svc, notifications } = makeService();
    svc.onTransition(at, { ...at, status: 'waiting_permission', pendingAction: { toolName: 'Bash', commandText: 'npm test' } });
    svc.onTransition(at, { ...at, status: 'waiting_input' }, { type: 'idle_prompt', message: 'Claude 想确认方案' });
    svc.onTransition(at, { ...at, status: 'completed' }, { type: 'turn_completed' });
    svc.onTransition(at, { ...at, status: 'completed', exitCode: 0 }, { type: 'process_exit', code: 0 });
    svc.onTransition(at, { ...at, status: 'error', exitCode: 2 });
    svc.onTransition(at, { ...at, status: 'disconnected', exitCode: null });
    expect(notifications.map(n => n.kind)).toEqual(['permission', 'input', 'turn', 'ended', 'error', 'lost']);
    expect(notifications[0].meta).toEqual({
      label: '重构用户模块', cwdTail: 'app', status: '等待批准（Bash）', toolName: 'Bash', summary: 'npm test',
    });
    expect(notifications[0].body).toBe('Bash：npm test，需要你点头才能继续');
    expect(notifications[1].meta).toMatchObject({ status: '等待输入', summary: 'Claude 想确认方案' });
    expect(notifications[1].body).toBe('它已经休息了一会儿，需要你接着指挥下一步动作');
    expect(notifications[2].meta?.status).toBe('本轮结束');
    expect(notifications[3].meta?.status).toBe('会话已退出');
    expect(notifications[3].title).toBe('✅ 「重构用户模块」已搞定');
    expect(notifications[4].meta?.status).toBe('异常退出（退出码 2）');
    expect(notifications[5].meta?.status).toBe('失联');
  });

  it('等待超时沿用等待中的摘要，并同时上报活动', () => {
    const reported: unknown[] = [];
    const svc = new NotificationService({ escalateAfterMs: 60_000, activity: { report: i => { reported.push(i); return null; } } });
    const got: NotificationPayload[] = [];
    svc.subscribe(n => got.push(n));
    const waitingInput = { ...at, status: 'waiting_input' as const, statusSince: 0 };
    svc.onTransition(at, waitingInput, { type: 'idle_prompt', message: '要不要继续？' });
    svc.tick([waitingInput, { ...at, id: 's2', status: 'waiting_permission', statusSince: 0,
      pendingAction: { toolName: 'Edit', commandText: 'a.ts' } }], 3 * 60_000);
    const overdue = got.filter(n => n.kind === 'overdue');
    expect(overdue).toHaveLength(2);
    expect(overdue[0].meta).toMatchObject({ status: '仍在等待（3 分钟）', summary: '要不要继续？' });
    expect(overdue[1].meta).toMatchObject({ toolName: 'Edit', summary: 'a.ts' });
    expect(overdue[0].title).toBe('⏰ 「重构用户模块」仍在等待');
    expect(reported).toEqual([
      expect.objectContaining({ type: 'wait.overdue', sessionId: 's1', detail: '等待输入已 3 分钟' }),
      expect.objectContaining({ type: 'wait.overdue', sessionId: 's2', detail: '等待批准已 3 分钟' }),
    ]);
  });

  it('离开等待输入后清掉旧摘要', () => {
    const { svc, notifications } = makeService();
    const w = { ...at, status: 'waiting_input' as const, statusSince: 0 };
    svc.onTransition(at, w, { type: 'idle_prompt', message: '旧问题' });
    svc.onTransition(w, { ...at, status: 'running' });
    svc.onTransition(at, w, { type: 'idle_prompt' });
    svc.tick([w], 10 * 60_000);
    expect(notifications.at(-1)!.kind).toBe('overdue');
    expect(notifications.at(-1)!.meta?.summary).toBeUndefined();
  });

  it('onActivity 只把上下文告警转为通知，其余类型忽略', () => {
    const { svc, notifications } = makeService();
    const ev = (type: string, extra: object = {}) => ({
      id: type, seq: 1, rev: 1, at: 1, updatedAt: 1, level: 'warning', source: 'usage', title: '「乙」上下文已用 81%', ...extra, type,
    }) as unknown as Parameters<NotificationService['onActivity']>[0];
    svc.onActivity(ev('turn.end'));
    svc.onActivity(ev('wait.permission'));
    svc.onActivity(ev('verify.result', { level: 'error' }));
    expect(notifications).toHaveLength(0);
    svc.onActivity(ev('budget.alert', { detail: '810k / 1M（claude-opus-5）' }));
    svc.onActivity(ev('budget.alert', { level: 'error', sessionId: 's1', sessionLabel: '甲', cwdTail: 'app', detail: '上下文 96%' }));
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toMatchObject({
      kind: 'budget', level: 'warning', title: '「乙」上下文已用 81%', body: '810k / 1M（claude-opus-5）',
      meta: { status: '上下文告警', summary: '810k / 1M（claude-opus-5）' },
    });
    expect(notifications[0].sessionId).toBeUndefined();
    expect(notifications[1]).toMatchObject({ kind: 'budget', level: 'error', sessionId: 's1', meta: { label: '甲', cwdTail: 'app' } });
  });

  it('全局通知不带 kind，不参与远程推送', () => {
    const { svc, notifications } = makeService();
    svc.notifyGlobal('info', '批注已排队', '空闲后发送', 's1');
    expect(notifications[0].kind).toBeUndefined();
  });
});
