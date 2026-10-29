import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { createGitRunner } from '../src/main/git-runner';
import { ChangeTracker } from '../src/main/change-tracker';
import { AnnotationStore, MAX_COMMENT_CHARS, SENT_KEEP_MS } from '../src/main/annotation-store';
import type { Annotation } from '../src/shared/review-types';

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function tmpDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(root: string, rel: string, content: string): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function setup() {
  const repo = tmpDir('panel-ann-repo-');
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 't');
  sh(repo, 'config', 'core.autocrlf', 'false');
  write(repo, 'a.txt', 'l1\nl2\nl3\n');
  write(repo, 'keep.txt', 'k\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  write(repo, 'a.txt', 'l1\nL2\nl3\n');
  write(repo, 'new.txt', 'n1\nn2\n');
  const home = tmpDir('panel-ann-home-');
  fs.mkdirSync(path.join(home, 'sessions', 's1'), { recursive: true });
  const tracker = new ChangeTracker({ git: createGitRunner(), getSession: id => (id === 's1' ? { cwd: repo } : undefined) });
  let clock = 1_000_000;
  const changed: string[] = [];
  const mk = () => new AnnotationStore({
    home, tracker, now: () => clock, onChange: id => changed.push(id),
  });
  return { repo, home, tracker, store: mk(), mk, changed, tick: (ms: number) => { clock += ms; }, head: sh(repo, 'rev-parse', 'HEAD') };
}

async function addLine(store: AnnotationStore, comment = '改这里'): Promise<Annotation> {
  const r = await store.add('s1', { path: 'a.txt', side: 'new', hunkIndex: 0, fromLine: 1, toLine: 2, comment });
  if ('error' in r) throw new Error(r.error);
  return r;
}

describe('AnnotationStore', () => {
  it('按主进程重新取的 diff 截取范围，记录旧侧提交', async () => {
    const { store, head, repo } = setup();
    const a = await addLine(store);
    expect(a).toMatchObject({
      path: 'a.txt', side: 'new', start: 2, end: 2, lines: ['-l2', '+L2'], mode: 'working', refSha: head,
      status: 'pending', comment: '改这里', hunkHeader: '@@ -1,3 +1,3 @@',
    });
    expect(store.root('s1')).toBe(path.resolve(repo));
    expect(store.summary('s1')).toEqual({ pending: 1, queued: false });
    const f = await store.add('s1', { path: 'new.txt', side: 'file', comment: '整个文件' });
    expect(f).toMatchObject({ side: 'file', start: 0, end: 0, lines: [] });
  });

  it('白名单：不在改动列表、跑出仓库、分块不存在一律拒绝', async () => {
    const { store } = setup();
    expect(await store.add('s1', { path: 'keep.txt', side: 'file', comment: 'x' })).toEqual({ error: '文件不在改动列表中' });
    expect(await store.add('s1', { path: '../a.txt', side: 'file', comment: 'x' })).toEqual({ error: '非法路径' });
    expect(await store.add('s1', { path: 'C:/Windows/win.ini', side: 'file', comment: 'x' })).toEqual({ error: '非法路径' });
    expect(await store.add('s1', { path: 'a.txt', side: 'new', hunkIndex: 5, fromLine: 0, comment: 'x' }))
      .toEqual({ error: '分块不存在，改动可能已更新，请刷新后重试' });
    expect(await store.add('s1', { path: 'a.txt', side: 'new', hunkIndex: 0, fromLine: 0, toLine: 99, comment: 'x' }))
      .toEqual({ error: '行范围超出分块' });
    expect(await store.add('nope', { path: 'a.txt', side: 'file', comment: 'x' })).toEqual({ error: '会话不存在' });
    expect(store.list('s1')).toEqual([]);
  });

  it('意见文本校验', async () => {
    const { store } = setup();
    expect(await store.add('s1', { path: 'a.txt', side: 'file', comment: '   ' })).toEqual({ error: '意见不能为空' });
    expect(await store.add('s1', { path: 'a.txt', side: 'file', comment: 'x'.repeat(MAX_COMMENT_CHARS + 1) }))
      .toEqual({ error: `意见最多 ${MAX_COMMENT_CHARS} 字` });
    const a = await addLine(store, '  两行\r\n意见  ');
    expect(a.comment).toBe('两行\n意见');
  });

  it('持久化：重新创建存储后仍在', async () => {
    const { store, mk, home, repo } = setup();
    const a = await addLine(store);
    const file = path.join(home, 'annotations', 's1.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.root).toBe(path.resolve(repo));
    const again = mk();
    expect(again.list('s1')).toEqual([a]);
    expect(again.root('s1')).toBe(path.resolve(repo));
  });

  it('批注文件不在会话目录里：会话目录被清理后仍在，prune 只删没有会话的文件', async () => {
    const { store, mk, home } = setup();
    const a = await addLine(store);
    fs.rmSync(path.join(home, 'sessions'), { recursive: true, force: true });
    const again = mk();
    expect(again.list('s1')).toEqual([a]);
    fs.writeFileSync(path.join(home, 'annotations', 'gone.json'), '{"version":1,"items":[]}');
    expect(again.prune(id => id === 's1')).toBe(1);
    expect(fs.existsSync(path.join(home, 'annotations', 'gone.json'))).toBe(false);
    expect(again.list('s1')).toEqual([a]);
  });

  it('状态流转：排队中不能改删；取消退回；已发送改后退回待发送；清除已发送', async () => {
    const { store, tick } = setup();
    const a = await addLine(store);
    expect(store.markQueued('s1', [a.id])).toBe(1);
    expect(store.summary('s1')).toEqual({ pending: 0, queued: true });
    expect(store.update('s1', a.id, '新意见')).toBe(false);
    expect(store.remove('s1', a.id)).toBe(false);
    expect(store.resetQueued('s1', [a.id])).toBe(1);
    expect(store.pending('s1').map(x => x.id)).toEqual([a.id]);
    tick(10);
    expect(store.markSent('s1', [a.id])).toBe(1);
    expect(store.list('s1')[0]).toMatchObject({ status: 'sent', sentAt: 1_000_010 });
    expect(store.summary('s1')).toBeUndefined();
    expect(store.update('s1', a.id, '再改')).toBe(true);
    expect(store.list('s1')[0]).toMatchObject({ status: 'pending', comment: '再改' });
    expect(store.list('s1')[0].sentAt).toBeUndefined();
    store.markSent('s1', [a.id]);
    expect(store.remove('s1', 'all-sent')).toBe(true);
    expect(store.list('s1')).toEqual([]);
  });

  it('已发送超过 24 小时自动清掉', async () => {
    const { store, tick } = setup();
    const a = await addLine(store);
    const b = await addLine(store, '另一条');
    store.markSent('s1', [a.id]);
    tick(SENT_KEEP_MS + 1);
    expect(store.list('s1').map(x => x.id)).toEqual([b.id]);
  });

  it('校验：内容一致有效，整体移位为偏移，删掉内容或文件为失效', async () => {
    const { store, repo, changed } = setup();
    const a = await addLine(store);
    expect(await store.verify('s1')).toEqual([{ id: a.id, validity: 'valid' }]);
    write(repo, 'a.txt', 'x\ny\nl1\nL2\nl3\n');
    changed.length = 0;
    expect(await store.verify('s1')).toEqual([{ id: a.id, validity: 'moved', movedTo: 4 }]);
    expect(changed).toEqual(['s1']);
    write(repo, 'a.txt', 'l1\nl3\n');
    expect(await store.verify('s1')).toEqual([{ id: a.id, validity: 'stale', reason: '找不到原内容' }]);
    fs.rmSync(path.join(repo, 'a.txt'));
    expect(await store.verify('s1')).toEqual([{ id: a.id, validity: 'stale', reason: '文件已不存在' }]);
    // 结果不变时不再回调
    changed.length = 0;
    await store.verify('s1');
    expect(changed).toEqual([]);
  });

  it('超过大小上限的文件标为未校验', async () => {
    const { tracker, home } = setup();
    const store = new AnnotationStore({ home, tracker, maxCheckBytes: 4 });
    const a = await addLine(store);
    expect(await store.verify('s1')).toEqual([{ id: a.id, validity: 'unchecked', reason: '文件超过 2MB，未校验' }]);
  });
});
