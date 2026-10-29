import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AnnotationStore } from '../src/main/annotation-store';
import { AnnotationService } from '../src/main/annotation-service';
import { PromptInjector } from '../src/main/prompt-injector';
import type { SessionListener } from '../src/main/session-manager';
import type { PanelEvent, Session } from '../src/shared/types';
import type { Annotation } from '../src/shared/review-types';

function seed(home: string, items: Partial<Annotation>[]): void {
  const dir = path.join(home, 'annotations');
  fs.mkdirSync(dir, { recursive: true });
  const full = items.map((p, i) => ({
    id: `a${i}`, path: `f${i}.md`, mode: 'working', refSha: '', side: 'file', start: 0, end: 0, lines: [],
    comment: `意见${i}`, status: 'pending', createdAt: i, updatedAt: i, ...p,
  }));
  fs.writeFileSync(path.join(dir, 's1.json'), JSON.stringify({ version: 1, root: home, items: full }));
}

function setup(sess: Partial<Session> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-annsvc-'));
  const s = {
    id: 's1', label: '会话一', cwd: 'D:/repo', status: 'running', statusSince: 0, createdAt: 0, escalated: false,
    busy: false, hooksVersion: 2, pasteMode: true, ...sess,
  } as Session;
  const listeners = new Set<SessionListener>();
  const writes: string[] = [];
  const host = {
    getSession: (id: string) => (id === 's1' ? s : undefined),
    isBusy: () => s.busy === true,
    hasLivePty: () => true,
    writeInput: (_id: string, d: string) => { writes.push(d); return true; },
    addListener: (l: SessionListener) => { listeners.add(l); return () => listeners.delete(l); },
  };
  const emit = (e: PanelEvent): void => { for (const l of listeners) l.onEvent?.('s1', e); };
  const tracker = { fileContext: vi.fn(), getFileDiff: vi.fn(), getRepoRoot: () => undefined };
  const store = new AnnotationStore({ home, tracker: tracker as never });
  const queuedSent: number[] = [];
  const notices: string[] = [];
  let service!: AnnotationService;
  const injector = new PromptInjector({
    host,
    onSent: (item, info) => service.onSent(item, info),
    onDropped: (item, reason) => service.onDropped(item, reason),
  });
  service = new AnnotationService({
    store, injector, getSession: host.getSession, isBusy: host.isBusy,
    onQueuedSent: (_s, n) => queuedSent.push(n),
    onNotice: (_id, m) => notices.push(m),
  });
  return { home, s, store, service, injector, writes, emit, queuedSent, notices };
}

describe('AnnotationService', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('预览：给出消息、条数与会话状态', async () => {
    const t = setup({ pasteMode: false });
    seed(t.home, [{}, {}]);
    const p = await t.service.preview('s1');
    expect(p).toMatchObject({ count: 2, omitted: 0, stale: 0, busy: false, waitingPermission: false, pasteMode: false, queued: false });
    expect(p.blocked).toBeUndefined();
    expect(p.text.startsWith('请根据以下代码审阅批注修改（共 2 条）：')).toBe(true);
  });

  it('只读会话：预览标明不可发送，发送被拒绝，批注保持待发送', async () => {
    const t = setup({ readOnly: true });
    seed(t.home, [{}]);
    const msg = '此会话由其他面板实例运行，只能查看，不能执行写操作';
    expect((await t.service.preview('s1')).blocked).toBe(msg);
    expect(await t.service.send('s1', 'now')).toMatchObject({ ok: false, message: msg });
    expect(t.writes).toEqual([]);
    expect(t.store.pending('s1')).toHaveLength(1);
  });

  it('没有待发送批注时不可发送', async () => {
    const t = setup();
    expect((await t.service.preview('s1')).blocked).toBe('没有待发送的批注');
    expect(await t.service.send('s1', 'auto')).toMatchObject({ ok: false, message: '没有待发送的批注' });
  });

  it('空闲发送：批注转为已发送', async () => {
    const t = setup();
    seed(t.home, [{}, {}]);
    expect(await t.service.send('s1', 'auto')).toMatchObject({ ok: true, sent: true, message: '已发送 2 条批注' });
    expect(t.store.list('s1').map(a => a.status)).toEqual(['sent', 'sent']);
    expect(t.writes).toHaveLength(1);
  });

  it('排队：批注转为排队中，本轮结束后发出并转为已发送；排队后新增的不并入', async () => {
    const t = setup({ busy: true });
    seed(t.home, [{}]);
    expect(await t.service.send('s1', 'queue')).toMatchObject({ queued: true, message: '已排队 1 条批注，本轮结束后发送' });
    expect(t.store.list('s1')[0].status).toBe('queued');
    expect(t.service.list('s1').outbox).toMatchObject({ reason: 'annotations', annotationIds: ['a0'] });
    expect((await t.service.preview('s1')).queued).toBe(true);
    t.s.busy = false;
    t.emit({ type: 'turn_completed' } as PanelEvent);
    vi.advanceTimersByTime(500);
    expect(t.writes).toHaveLength(1);
    expect(t.store.list('s1')[0].status).toBe('sent');
    expect(t.queuedSent).toEqual([1]);
  });

  it('取消排队与会话退出：批注退回待发送，退出时提示', async () => {
    const t = setup({ busy: true });
    seed(t.home, [{}]);
    await t.service.send('s1', 'queue');
    expect(t.service.cancel('s1')).toBe(true);
    expect(t.store.list('s1')[0].status).toBe('pending');
    expect(t.notices).toEqual([]);
    await t.service.send('s1', 'queue');
    t.emit({ type: 'process_exit', code: 1 } as unknown as PanelEvent);
    expect(t.store.list('s1')[0].status).toBe('pending');
    expect(t.notices).toEqual(['会话已退出，排队的批注未发送，已退回待发送']);
  });

  it('正忙时 auto 返回需要选择，批注不变', async () => {
    const t = setup({ busy: true });
    seed(t.home, [{}]);
    expect(await t.service.send('s1', 'auto')).toMatchObject({ ok: false, needChoice: 'busy' });
    expect(t.store.list('s1')[0].status).toBe('pending');
  });

  it('超出长度的条目留在待发送', async () => {
    const t = setup();
    const big = Array.from({ length: 400 }, () => '+' + 'x'.repeat(5000));
    seed(t.home, Array.from({ length: 6 }, (_, i) => ({ side: 'new' as const, start: 1, end: 400, lines: big, path: `f${i}.ts` })));
    const r = await t.service.send('s1', 'now');
    expect(r.ok).toBe(true);
    const st = t.store.list('s1').map(a => a.status);
    expect(st.filter(x => x === 'sent').length).toBeGreaterThan(0);
    expect(st.filter(x => x === 'pending').length).toBeGreaterThan(0);
    expect(r.message).toMatch(/另有 \d+ 条因长度限制留在待发送/);
  });
});
