import type { ResumeSettings } from '../shared/types';
import { startupDisposition, StartupPlan } from '../shared/session-records';
import type { SessionManager } from './session-manager';
import type { SessionRecordStore } from './session-record-store';
import { log } from './logger';

/**
 * 启动时按记录恢复会话列表：崩溃遗留的 live 记录转 suspended(crash)，不恢复档把待续接记录转入历史，
 * 其余 suspended / exited 记录以无进程行放回列表。返回的方案里带着要自动续接的 id 与询问档横幅内容，
 * 由调用方在窗口就绪后处理。
 */
export function applyStartupPlan(input: {
  records: SessionRecordStore;
  manager: SessionManager;
  onStartup: ResumeSettings['onStartup'];
  adoptedIds: ReadonlySet<string>;
  now: number;
}): StartupPlan {
  const { records, manager, now } = input;
  const plan = startupDisposition(records.all(), input.adoptedIds, input.onStartup);
  for (const id of plan.crashed) records.patch(id, { state: 'suspended', restoreReason: 'crash' });
  for (const id of plan.end) {
    records.patch(id, { state: 'ended', endReason: 'not_restored', endedAt: now, restoreReason: undefined });
  }
  let restored = 0;
  for (const d of plan.dormant) {
    const rec = records.get(d.id);
    if (rec && manager.addDormant(rec, d)) restored++;
  }
  log('records', `启动恢复：认领 ${plan.adopted.length}，恢复无进程行 ${restored}（崩溃遗留 ${plan.crashed.length}），`
    + `转入历史 ${plan.end.length}，待自动续接 ${plan.autoResume.length}，待询问 ${plan.prompt?.ids.length ?? 0}`);
  return plan;
}
