import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scanOrphans } from '../src/main/orphan-reclaimer';

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'panel-orphan-'));
}
function seed(home: string, id: string, pid: number): string {
  const dir = path.join(home, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'metadata.json'),
    JSON.stringify({ id, label: `任务-${id}`, cwd: 'D:\\p', createdAt: 1, pid }));
  return dir;
}

describe('scanOrphans', () => {
  it('活进程的会话被认领：readOnly + running', () => {
    const home = makeHome();
    seed(home, 'a1', 111);
    const { adopted, removedIds } = scanOrphans({
      home, now: 999, isAlive: pid => pid === 111,
    });
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ id: 'a1', label: '任务-a1', status: 'running', readOnly: true, statusSince: 999 });
    expect(removedIds).toEqual([]);
  });

  it('metadata 中的工作区信息随认领恢复，格式不全则忽略', () => {
    const home = makeHome();
    const worktree = { repoRoot: 'D:\\r', path: 'D:\\r\\.claude\\worktrees\\nexus-w1', branch: 'nexus/w1', baseRef: 'main', baseCommit: 'a'.repeat(40) };
    for (const [id, wt] of [['w1', worktree], ['w2', { path: 'D:\\x' }]] as const) {
      const dir = path.join(home, 'sessions', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ id, label: id, cwd: 'D:\\p', createdAt: 1, pid: 5, worktree: wt }));
    }
    const { adopted } = scanOrphans({ home, now: 1, isAlive: () => true });
    expect(adopted.find(s => s.id === 'w1')?.worktree).toEqual(worktree);
    expect(adopted.find(s => s.id === 'w2')?.worktree).toBeUndefined();
  });

  it('死进程的会话目录被清理', () => {
    const home = makeHome();
    const dir = seed(home, 'dead1', 222);
    scanOrphans({ home, now: 999, isAlive: () => false });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('死进程的元数据在删目录前交给调用方；缺 id 时用目录名补上', () => {
    const home = makeHome();
    seed(home, 'dead2', 333);
    const dir = path.join(home, 'sessions', 'noid');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ label: 'x', cwd: 'D:\\q', sessionId: 'c1', pid: 444 }));
    const { deadMetas, removedIds } = scanOrphans({ home, now: 1, isAlive: () => false });
    expect(removedIds.sort()).toEqual(['dead2', 'noid']);
    expect(deadMetas.find(m => m.id === 'dead2')).toMatchObject({ label: '任务-dead2', cwd: 'D:\\p', pid: 333 });
    expect(deadMetas.find(m => m.id === 'noid')).toMatchObject({ cwd: 'D:\\q', sessionId: 'c1' });
  });

  it('认领时恢复 id 历史、对话记录路径与启动选项', () => {
    const home = makeHome();
    const dir = path.join(home, 'sessions', 'r1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
      id: 'r1', label: 'r', cwd: 'D:\\p', createdAt: 1, pid: 7, sessionId: 'c2', sessionIds: ['c1', 'c2', 3],
      transcriptPath: 'D:\\t\\c2.jsonl', launch: { model: 'opus' },
    }));
    const { adopted, deadMetas } = scanOrphans({ home, now: 1, isAlive: () => true });
    expect(deadMetas).toEqual([]);
    expect(adopted[0]).toMatchObject({
      claudeSessionId: 'c2', claudeSessionIds: ['c1', 'c2'], claudeTranscriptPath: 'D:\\t\\c2.jsonl', launch: { model: 'opus' },
    });
  });

  it('缺 pid / 损坏 JSON 的目录安全跳过，不抛错', () => {
    const home = makeHome();
    const dir = path.join(home, 'sessions', 'bad1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'metadata.json'), 'not-json');
    expect(() => scanOrphans({ home, now: 999, isAlive: () => true })).not.toThrow();
  });
});

describe('scanOrphans 批次归属', () => {
  it('metadata 中的批次 id 随认领恢复，空串或类型不对时忽略', () => {
    const home = makeHome();
    for (const [id, batchId] of [['b1', 'batch-1'], ['b2', ''], ['b3', 7]] as const) {
      const dir = path.join(home, 'sessions', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ id, label: id, cwd: 'D:\p', createdAt: 1, pid: 5, batchId }));
    }
    const { adopted } = scanOrphans({ home, now: 1, isAlive: () => true });
    expect(adopted.find(s => s.id === 'b1')?.batchId).toBe('batch-1');
    expect('batchId' in (adopted.find(s => s.id === 'b2') ?? {})).toBe(false);
    expect('batchId' in (adopted.find(s => s.id === 'b3') ?? {})).toBe(false);
  });
});
