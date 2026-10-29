import * as fs from 'fs';
import * as path from 'path';
import { LaunchOptions, Session, WorktreeInfo } from '../shared/types';

function isWorktreeInfo(v: unknown): v is WorktreeInfo {
  const w = v as WorktreeInfo;
  return !!w && typeof w.path === 'string' && typeof w.repoRoot === 'string'
    && typeof w.branch === 'string' && typeof w.baseCommit === 'string';
}

/** sessions/<id>/metadata.json 的内容（各字段都可能缺失或类型不对，使用前需校验） */
export interface OrphanMetadata {
  id?: string;
  label?: string;
  cwd?: string;
  createdAt?: number;
  pid?: number;
  sessionId?: string;
  sessionIds?: string[];
  transcriptPath?: string;
  launch?: LaunchOptions;
  worktree?: WorktreeInfo;
  hooksVersion?: number;
  batchId?: string;
}

export interface OrphanScanResult {
  adopted: Session[];
  adoptedPids: Map<string, number>;   // 认领会话 id → 进程 pid，供后续轮询存活
  removedIds: string[];
  /** 进程已死、目录已删除的会话元数据（目录名补作 id），交给调用方迁移成历史记录 */
  deadMetas: OrphanMetadata[];
}

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && !!x);
  return out.length > 0 ? out : undefined;
}

// 扫描 <home>/sessions/<id>/metadata.json, 认领存活孤儿并清理死亡残留.
export function scanOrphans(deps: {
  home: string;
  now: number;
  isAlive: (pid: number) => boolean;
}): OrphanScanResult {
  const result: OrphanScanResult = { adopted: [], adoptedPids: new Map(), removedIds: [], deadMetas: [] };
  const sessionsDir = path.join(deps.home, 'sessions');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return result;
  }
  for (const id of entries) {
    const dir = path.join(sessionsDir, id);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')) as OrphanMetadata;
      if (typeof meta.pid !== 'number' || !deps.isAlive(meta.pid)) {
        fs.rmSync(dir, { recursive: true, force: true });
        result.removedIds.push(id);
        result.deadMetas.push({ ...meta, id: typeof meta.id === 'string' && meta.id ? meta.id : id });
        continue;
      }
      const sessionId = typeof meta.sessionId === 'string' && meta.sessionId ? meta.sessionId : undefined;
      const sessionIds = stringList(meta.sessionIds);
      const adopted: Session = {
        id: meta.id ?? id,
        label: meta.label ?? '未知任务（孤儿认领）',
        cwd: meta.cwd ?? '',
        status: 'running',
        statusSince: deps.now,
        createdAt: meta.createdAt ?? deps.now,
        escalated: false,
        readOnly: true,
        // claudeSessionId 是 SubagentTracker.reconstruct 反查 transcript 的唯一凭据
        ...(sessionId ? { claudeSessionId: sessionId } : {}),
        ...(sessionIds ? { claudeSessionIds: sessionIds } : {}),
        ...(typeof meta.transcriptPath === 'string' && meta.transcriptPath ? { claudeTranscriptPath: meta.transcriptPath } : {}),
        ...(meta.launch && typeof meta.launch === 'object' ? { launch: meta.launch } : {}),
        // 工作区信息随会话恢复，结束认领会话时仍能按正常流程清理工作区
        ...(isWorktreeInfo(meta.worktree) ? { worktree: meta.worktree } : {}),
        // 批次归属随会话恢复，批次对比视图仍能找到它
        ...(typeof meta.batchId === 'string' && meta.batchId ? { batchId: meta.batchId } : {}),
        // 认领前的忙碌状态未知，只沿用 hooks 版本；缺省版本的会话发送时按可能正忙处理
        ...(typeof meta.hooksVersion === 'number' ? { hooksVersion: meta.hooksVersion } : {}),
      };
      result.adopted.push(adopted);
      result.adoptedPids.set(adopted.id, meta.pid);
    } catch {
      /* 单个目录损坏则跳过 */
    }
  }
  return result;
}

/** 元数据里的工作区信息是否完整（迁移旧会话时用） */
export function metaWorktree(meta: OrphanMetadata): WorktreeInfo | undefined {
  return isWorktreeInfo(meta.worktree) ? meta.worktree : undefined;
}
