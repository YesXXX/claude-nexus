import type {
  ChangedFile, ChangeList, DiffMode, FileDiff, Session,
} from '../../../shared/types';
import type { SessionChangeList } from '../../../shared/session-change-types';
import type { ConfirmOptions } from '../../core/dialog-types.js';
import type { ChangesExtension, ChangesScope } from '../../core/changes-ext.js';

/** 改动视图对外的接口与数据来源 */

export interface ChangesApi {
  changes(id: string, mode?: DiffMode): Promise<ChangeList>;
  fileDiff(id: string, path: string, mode?: DiffMode, ignoreWs?: boolean): Promise<FileDiff>;
  /** reveal=false 用默认程序打开（可执行类型由主进程改为定位）；line 有值且配置了外部编辑器时改为跳到该行 */
  openPath(id: string, path: string, reveal: boolean, line?: number): Promise<string>;
  /** 本会话视角的数据来源，path 为完整地址（正斜杠） */
  sessionChanges: {
    list(id: string): Promise<SessionChangeList>;
    fileDiff(id: string, path: string, ignoreWs?: boolean): Promise<FileDiff>;
    openPath(id: string, path: string, reveal: boolean, line?: number): Promise<string>;
    /** 清除类操作返回实际删除的条目数 */
    clear(id: string): Promise<{ removed: number }>;
    dismiss(id: string, paths: string[]): Promise<{ removed: number }>;
    dismissRoot(id: string, root: string, outside: boolean): Promise<{ removed: number }>;
  };
}

export interface ChangesViewOptions {
  /** 操作结果提示（应用内 toast） */
  toast(text: string, level?: 'info' | 'success' | 'warning' | 'error'): void;
  /** 危险操作确认框（清除改动记录等）；不传则不提供清除入口 */
  confirm?(opts: ConfirmOptions): Promise<boolean>;
  /** 改动视图扩展（批注、撤销等），创建时各 attach 一次 */
  extensions?: ChangesExtension[];
  /** 专注审阅开关（收起会话列表与属性面板）；不传则不显示该按钮 */
  focusMode?: { on(): boolean; set(on: boolean): void };
}

export interface ChangesView {
  /** 展示某会话的改动并加载列表；换了会话时重置选中与滚动，同一会话保留选中的文件 */
  show(session: Session): void;
  /** 视图被隐藏（切回终端或离开详情）：停掉待执行的加载，迟到的结果一律丢弃 */
  hide(): void;
  /** 重新拉取列表与选中文件的 diff，文件仍在则保持选中 */
  refresh(): void;
  /** 仅工作区会话的仓库视角：在相对基线与仅未提交之间切换，其余情况无效果 */
  toggleMode(): void;
  /** 在本会话改动与仓库视角之间切换 */
  toggleScope(): void;
  /** 当前会话的视角（未展示会话时为默认的本会话改动） */
  scope(): ChangesScope;
  /** 可见期间每次会话推送都会调用：摘要时间戳变化时静默刷新，保留选中、不闪加载态 */
  update(session: Session): void;
  /** 键盘焦点移到文件列表，方向键即可切换文件 */
  focus(): void;
  /** 聚焦搜索框并全选（/ 热键与命令面板用） */
  focusSearch(): void;
  /** 清空本会话全部改动记录：弹确认后调主进程并刷新（仓库视角下也可用，清的是本会话记录） */
  clearAll(): Promise<void>;
}

/** 两种视角的列表统一成同一形状；roots 只有本会话视角有，root 与 sharedWith 只有仓库视角有 */
export interface ListResult {
  summary: ChangeList['summary'] | SessionChangeList['summary'];
  files: ChangedFile[];
  truncated: boolean;
  sharedWith: number;
  roots: number;
  root?: string;
}

export async function fetchList(api: ChangesApi, id: string, sc: ChangesScope, mode: DiffMode | undefined): Promise<ListResult> {
  if (sc === 'session') {
    const r = await api.sessionChanges.list(id);
    return { summary: r.summary, files: r.files, truncated: r.truncated, sharedWith: 0, roots: r.summary.roots };
  }
  const r = await api.changes(id, mode);
  return { summary: r.summary, files: r.files, truncated: r.truncated, sharedWith: r.sharedWith, roots: 0, root: r.root };
}
