import type { Session } from '../../shared/types';
import { api } from '../core/api.js';
import type { CreateSessionOptions } from '../core/api.js';
import { dbg, short } from '../core/debug.js';
import { pushRecent, RECENT_CWDS_KEY, RECENT_LABELS_KEY } from '../core/persist.js';
import { render } from '../core/render.js';
import { state } from '../core/state.js';

/**
 * 创建会话并立即选中：新建表单与会话预设共用。
 * 目录不存在等创建失败会抛出，由调用方负责提示；成功时已切换到新会话的终端标签。
 */

export async function createSessionAndSelect(label: string, cwd: string, opts?: CreateSessionOptions): Promise<Session> {
  dbg('create', `创建会话：label=${label} cwd=${cwd}${opts?.worktree ? ' 独立工作区' : ''}${opts?.initialPrompt ? ' 带首条提示词' : ''}`);
  const created = await api().create(label, cwd, opts);
  dbg('create', `创建成功：会话 ${short(created.id)}，自动选中`);
  pushRecent(RECENT_CWDS_KEY, cwd);
  pushRecent(RECENT_LABELS_KEY, label);
  // 避免选中后右侧空白，须在同一同步块里完成：
  // 1. 先把新会话合入本地 state.sessions，整体重绘时一定能找到
  // 2. 清掉残留的子代理选中态（新建会话一定是父视图）
  // 3. 设 state.selectedId 后立刻 render，跨微任务会出现会话列表先到、
  //    selectedId 还未设的中间帧，右侧闪一下空态
  if (!state.sessions.find(s => s.id === created.id)) {
    state.sessions = [created, ...state.sessions];
  }
  state.selectedSubagent = null;
  state.selectedId = created.id;
  state.paneTab = 'term';
  state.pendingFocusId = created.id;
  render();
  return created;
}
