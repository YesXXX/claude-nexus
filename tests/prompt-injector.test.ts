import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PromptInjector, type InjectorHost, type DropReason } from '../src/main/prompt-injector';
import type { SessionListener } from '../src/main/session-manager';
import type { PanelEvent, Session } from '../src/shared/types';
import type { OutboxItem } from '../src/shared/review-types';

const PS = '\x1b[200~';
const PE = '\x1b[201~';

function session(p: Partial<Session> = {}): Session {
  return {
    id: 's1', label: 'L', cwd: 'D:/x', status: 'running', statusSince: 0, createdAt: 0, escalated: false,
    busy: false, hooksVersion: 2, pasteMode: true, ...p,
  } as Session;
}

interface Fake {
  host: InjectorHost;
  s: Session;
  writes: { t: number; data: string }[];
  emit(ev: PanelEvent): void;
  output(chunk?: string): void;
  detach(reason: 'killed' | 'restarted'): void;
  alive: boolean;
}

function fakeHost(init: Partial<Session> = {}): Fake {
  const listeners = new Set<SessionListener>();
  const f: Fake = {
    s: session(init),
    writes: [],
    alive: true,
    host: undefined as unknown as InjectorHost,
    emit(ev) {
      // 与 SessionManager 一致：先更新 busy 与状态，再通知订阅者
      const busyTrue = ['prompt_submitted', 'tool_started', 'tool_finished', 'permission_request'];
      const busyFalse = ['turn_completed', 'idle_prompt', 'process_exit'];
      if (busyTrue.includes(ev.type)) f.s.busy = true;
      if (busyFalse.includes(ev.type)) f.s.busy = false;
      if (ev.type === 'permission_request') f.s.status = 'waiting_permission';
      if (ev.type === 'turn_completed') f.s.status = 'completed';
      if (ev.type === 'process_exit') f.alive = false;
      for (const l of listeners) l.onEvent?.('s1', ev);
    },
    output(chunk = 'x') { for (const l of listeners) l.onOutput?.('s1', chunk); },
    detach(reason) { f.alive = false; for (const l of listeners) l.onDetach?.('s1', reason); },
  };
  f.host = {
    getSession: id => (id === 's1' ? f.s : undefined),
    isBusy: () => f.s.busy === true || (f.s.hooksVersion ?? 0) < 2,
    hasLivePty: () => f.alive,
    writeInput: (_id, data) => { if (!f.alive) return false; f.writes.push({ t: Date.now(), data }); return true; },
    addListener: l => { listeners.add(l); return () => listeners.delete(l); },
  };
  return f;
}

const ev = (type: PanelEvent['type'], extra: Record<string, unknown> = {}): PanelEvent =>
  ({ type, ...extra }) as unknown as PanelEvent;

function make(f: Fake, extra: Partial<ConstructorParameters<typeof PromptInjector>[0]> = {}) {
  const sent: { item: OutboxItem; queued: boolean }[] = [];
  const dropped: { item: OutboxItem; reason: DropReason }[] = [];
  const notices: string[] = [];
  const inj = new PromptInjector({
    host: f.host,
    onSent: (item, info) => sent.push({ item, queued: info.queued }),
    onDropped: (item, reason) => dropped.push({ item, reason }),
    onNotice: (_id, m) => notices.push(m),
    ...extra,
  });
  return { inj, sent, dropped, notices };
}

describe('PromptInjector', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('空闲时立即写入：一次粘贴包裹，30ms 后单独一次回车', () => {
    const f = fakeHost();
    const { inj, sent } = make(f);
    const r = inj.send('s1', '第一行\n第二行', { when: 'auto', reason: 'annotations', annotationIds: ['a'] });
    expect(r).toEqual({ ok: true, sent: true, queued: false, message: '已发送' });
    expect(f.writes.map(w => w.data)).toEqual([`${PS}第一行\r第二行${PE}`]);
    vi.advanceTimersByTime(29);
    expect(f.writes).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(f.writes.map(w => w.data)).toEqual([`${PS}第一行\r第二行${PE}`, '\r']);
    expect(f.writes[1].t - f.writes[0].t).toBe(30);
    expect(sent).toEqual([{ item: expect.objectContaining({ reason: 'annotations', annotationIds: ['a'] }), queued: false }]);
  });

  it('粘贴后回车前收到权限请求：不写回车并提示', () => {
    const f = fakeHost();
    const { inj, notices } = make(f);
    inj.send('s1', 'x', { when: 'now' });
    f.emit(ev('permission_request'));
    vi.advanceTimersByTime(100);
    expect(f.writes.map(w => w.data)).toEqual([`${PS}x${PE}`]);
    expect(notices[0]).toContain('未自动提交');
  });

  it('正忙：auto 返回需要选择；queue 排队，turn_completed 后等 500ms 再发', () => {
    const f = fakeHost();
    const { inj, sent } = make(f);
    f.emit(ev('prompt_submitted'));
    expect(inj.send('s1', 'q', { when: 'auto' })).toMatchObject({ ok: false, sent: false, needChoice: 'busy' });
    expect(f.writes).toEqual([]);
    const r = inj.send('s1', 'q', { when: 'queue', reason: 'annotations', annotationIds: ['a', 'b'] });
    expect(r).toMatchObject({ ok: true, sent: false, queued: true });
    expect(inj.get('s1')).toMatchObject({ text: 'q', waitFor: 'idle', annotationIds: ['a', 'b'] });
    expect(inj.send('s1', 'q2', { when: 'now' })).toMatchObject({ ok: false, message: '已有排队中的消息，先取消排队再发送' });
    f.emit(ev('tool_started'));
    vi.advanceTimersByTime(10_000);
    expect(f.writes).toEqual([]);
    f.emit(ev('turn_completed'));
    vi.advanceTimersByTime(499);
    expect(f.writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(f.writes.map(w => w.data)).toEqual([`${PS}q${PE}`]);
    vi.advanceTimersByTime(30);
    expect(f.writes.map(w => w.data)).toEqual([`${PS}q${PE}`, '\r']);
    expect(sent).toEqual([{ item: expect.objectContaining({ text: 'q' }), queued: true }]);
    expect(inj.get('s1')).toBeUndefined();
  });

  it('500ms 内又开始新一轮：不发，等下一次空闲', () => {
    const f = fakeHost({ busy: true });
    const { inj } = make(f);
    inj.send('s1', 'q', { when: 'queue' });
    f.emit(ev('turn_completed'));
    vi.advanceTimersByTime(200);
    f.emit(ev('prompt_submitted'));
    vi.advanceTimersByTime(1000);
    expect(f.writes).toEqual([]);
    f.emit(ev('idle_prompt'));
    vi.advanceTimersByTime(500);
    expect(f.writes).toHaveLength(1);
  });

  it('等待权限时绝不写入：now 拒绝，排队等到权限处理完、本轮结束', () => {
    const f = fakeHost();
    const { inj } = make(f);
    f.emit(ev('permission_request'));
    expect(inj.send('s1', 'x', { when: 'now' })).toMatchObject({ ok: false, needChoice: 'permission' });
    expect(inj.send('s1', 'x', { when: 'auto' })).toMatchObject({ ok: false, needChoice: 'permission' });
    inj.send('s1', 'x', { when: 'queue' });
    // 状态仍是等待权限时，即使 busy 被清也不写
    f.s.busy = false;
    f.emit(ev('idle_prompt'));
    f.s.status = 'waiting_permission';
    vi.advanceTimersByTime(5000);
    expect(f.writes).toEqual([]);
    f.s.status = 'running';
    f.emit(ev('turn_completed'));
    vi.advanceTimersByTime(500);
    expect(f.writes).toHaveLength(1);
  });

  it('立即发送：正忙也写入，由 Claude Code 自己排队', () => {
    const f = fakeHost({ busy: true });
    const { inj } = make(f);
    expect(inj.send('s1', 'x', { when: 'now' })).toMatchObject({ ok: true, sent: true });
    expect(f.writes).toHaveLength(1);
  });

  it('会话退出、被结束、被重启：排队消息丢弃并回调', () => {
    for (const how of ['exit', 'killed', 'restarted'] as const) {
      const f = fakeHost({ busy: true });
      const { inj, dropped } = make(f);
      inj.send('s1', 'x', { when: 'queue', reason: 'annotations', annotationIds: ['a'] });
      if (how === 'exit') f.emit(ev('process_exit', { code: 0 }));
      else f.detach(how);
      vi.advanceTimersByTime(5000);
      expect(f.writes).toEqual([]);
      expect(dropped).toEqual([{ item: expect.objectContaining({ annotationIds: ['a'] }), reason: how === 'exit' ? 'exited' : how }]);
      expect(inj.get('s1')).toBeUndefined();
      inj.dispose();
    }
  });

  it('取消排队', () => {
    const f = fakeHost({ busy: true });
    const { inj, dropped } = make(f);
    inj.send('s1', 'x', { when: 'queue' });
    expect(inj.cancel('s1')).toMatchObject({ text: 'x' });
    expect(dropped[0].reason).toBe('cancelled');
    f.emit(ev('turn_completed'));
    vi.advanceTimersByTime(1000);
    expect(f.writes).toEqual([]);
    expect(inj.cancel('s1')).toBeUndefined();
  });

  it('只读会话拒绝发送；排队期间变为只读则保持排队，恢复后再发', () => {
    const f = fakeHost({ readOnly: true });
    const { inj } = make(f);
    expect(inj.send('s1', 'x', { when: 'auto' })).toEqual({
      ok: false, sent: false, queued: false, message: '此会话由其他面板实例运行，只能查看，不能执行写操作',
    });
    f.s.readOnly = false;
    f.s.busy = true;
    inj.send('s1', 'x', { when: 'queue' });
    f.s.readOnly = true;
    f.emit(ev('turn_completed'));
    vi.advanceTimersByTime(1000);
    expect(f.writes).toEqual([]);
    expect(inj.get('s1')).toBeDefined();
    f.s.readOnly = false;
    f.emit(ev('idle_prompt'));
    vi.advanceTimersByTime(500);
    expect(f.writes).toHaveLength(1);
  });

  it('进程已退出与会话不存在时拒绝', () => {
    const f = fakeHost();
    const { inj } = make(f);
    expect(inj.send('zz', 'x', { when: 'now' })).toMatchObject({ ok: false, message: '会话不存在' });
    f.alive = false;
    expect(inj.send('s1', 'x', { when: 'now' })).toMatchObject({ ok: false, message: '会话进程已退出' });
  });

  it('未检测到粘贴模式时照常发送并带警告标记', () => {
    const f = fakeHost({ pasteMode: false });
    const { inj } = make(f);
    expect(inj.send('s1', 'x', { when: 'auto' })).toMatchObject({ ok: true, sent: true, warnPasteMode: true });
  });

  it('老会话：busy 不可靠，auto 需要选择；排队后要见过一次空闲事件才发', () => {
    const f = fakeHost({ hooksVersion: undefined });
    const { inj } = make(f);
    expect(inj.send('s1', 'x', { when: 'auto' })).toMatchObject({ needChoice: 'busy' });
    expect(inj.send('s1', 'x', { when: 'queue' })).toMatchObject({ queued: true });
    vi.advanceTimersByTime(5000);
    expect(f.writes).toEqual([]);
    f.emit(ev('tool_finished'));
    f.emit(ev('turn_completed'));
    vi.advanceTimersByTime(500);
    expect(f.writes).toHaveLength(1);
  });

  it('排队超过 30 分钟提醒一次', () => {
    const f = fakeHost({ busy: true });
    const { inj, notices } = make(f);
    inj.send('s1', 'x', { when: 'queue' });
    vi.advanceTimersByTime(30 * 60_000);
    expect(notices).toEqual(['排队的消息已等待超过 30 分钟，可在批注区取消排队或立即发送']);
  });

  describe('ready 模式', () => {
    it('SessionStart、粘贴模式、输出静默 800ms 三个条件都满足才发', () => {
      const f = fakeHost({ pasteMode: false });
      const { inj, sent } = make(f);
      expect(inj.enqueueReady('s1', '解决冲突', { reason: 'conflict' })).toMatchObject({ waitFor: 'ready', deadline: 130_000 });
      f.output('trust dialog');
      vi.advanceTimersByTime(2000);
      expect(f.writes).toEqual([]);
      f.emit(ev('session_started'));
      vi.advanceTimersByTime(2000);
      expect(f.writes).toEqual([]);
      f.s.pasteMode = true;
      f.output('\x1b[?2004h');
      vi.advanceTimersByTime(500);
      f.output('banner');
      vi.advanceTimersByTime(799);
      expect(f.writes).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(f.writes.map(w => w.data)).toEqual([`${PS}解决冲突${PE}`]);
      vi.advanceTimersByTime(30);
      expect(f.writes).toHaveLength(2);
      expect(sent[0]).toMatchObject({ item: { reason: 'conflict' }, queued: true });
    });

    it('先于入队到达的 SessionStart 也算数', () => {
      const f = fakeHost();
      const { inj } = make(f);
      f.emit(ev('session_started'));
      f.output();
      inj.enqueueReady('s1', 'p');
      vi.advanceTimersByTime(800);
      expect(f.writes).toHaveLength(1);
    });

    it('30 秒内未就绪：以 timeout 丢弃', () => {
      const f = fakeHost();
      const { inj, dropped } = make(f);
      inj.enqueueReady('s1', 'p', { reason: 'conflict' });
      vi.advanceTimersByTime(29_999);
      expect(dropped).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(dropped).toEqual([{ item: expect.objectContaining({ text: 'p' }), reason: 'timeout' }]);
      f.emit(ev('session_started'));
      vi.advanceTimersByTime(5000);
      expect(f.writes).toEqual([]);
    });

    it('重启后要重新收到 SessionStart', () => {
      const f = fakeHost();
      const { inj } = make(f);
      f.emit(ev('session_started'));
      f.detach('restarted');
      f.alive = true;
      inj.enqueueReady('s1', 'p');
      vi.advanceTimersByTime(5000);
      expect(f.writes).toEqual([]);
      f.emit(ev('session_started'));
      vi.advanceTimersByTime(800);
      expect(f.writes.map(w => w.data)).toEqual([`${PS}p${PE}`, '\r']);
    });

    it('只读会话不入队', () => {
      const f = fakeHost({ readOnly: true });
      const { inj } = make(f);
      expect(inj.enqueueReady('s1', 'p')).toBeUndefined();
    });
  });

  describe('insert 写入输入框', () => {
    it('粘贴模式开启：多行一次粘贴包裹；不提交时不写回车', () => {
      const f = fakeHost();
      const { inj } = make(f);
      expect(inj.insert('s1', '第一行\r\n第二行', false)).toEqual({ ok: true });
      vi.advanceTimersByTime(100);
      expect(f.writes.map(w => w.data)).toEqual([`${PS}第一行\r第二行${PE}`]);
    });

    it('提交时粘贴后单独一次回车；回车前收到权限请求则跳过回车', () => {
      const f = fakeHost();
      const { inj } = make(f);
      expect(inj.insert('s1', 'hi', true).ok).toBe(true);
      vi.advanceTimersByTime(30);
      expect(f.writes.map(w => w.data)).toEqual([`${PS}hi${PE}`, '\r']);
      const g = fakeHost();
      const m = make(g);
      m.inj.insert('s1', 'go', true);
      g.emit(ev('permission_request'));
      vi.advanceTimersByTime(100);
      expect(g.writes.map(w => w.data)).toEqual([`${PS}go${PE}`]);
    });

    it('未开启粘贴模式：单行去掉控制字符后直接写入，多行拒绝', () => {
      const f = fakeHost({ pasteMode: false });
      const { inj } = make(f);
      const r = inj.insert('s1', 'a\nb', false);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('粘贴模式');
      expect(inj.insert('s1', 'ab\x07c', false)).toEqual({ ok: true });
      expect(f.writes.map(w => w.data)).toEqual(['abc']);
    });

    it('等待审批、只读、进程已退出、空文本时拒绝', () => {
      const f = fakeHost({ status: 'waiting_permission' });
      expect(make(f).inj.insert('s1', 'x', true).reason).toContain('确认权限');
      expect(make(fakeHost({ readOnly: true })).inj.insert('s1', 'x', true).ok).toBe(false);
      const dead = fakeHost();
      dead.alive = false;
      expect(make(dead).inj.insert('s1', 'x', true)).toEqual({ ok: false, reason: '会话进程已退出' });
      expect(make(fakeHost()).inj.insert('s1', '  \n ', true)).toEqual({ ok: false, reason: '提示词为空' });
      expect(f.writes).toEqual([]);
    });
  });
});
