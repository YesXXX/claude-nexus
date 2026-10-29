import type { ChangedFile, DiffMode, FileDiff, Session } from '../../shared/types';

/**
 * 改动视图的扩展点类型：批注、撤销等功能通过它往改动视图里加横条、列表行标记、diff 头部按钮与 diff 装饰，
 * 不需要导入改动视图本身。改动视图创建时对每个已注册的扩展调用一次 attach，拿到的实例跟随视图的生命周期。
 */

/** session：本会话 Claude 动过的全部文件（列表键为完整地址）；repo：工作目录所在仓库的 git 改动（列表键为相对路径） */
export type ChangesScope = 'session' | 'repo';

/** 改动视图交给扩展的只读状态与少量动作 */
export interface ChangesHost {
  /** 当前展示的会话（最近一次 show / update 传入的对象） */
  session(): Session | undefined;
  /** 当前视角；列表与 diff 的数据来源随之不同 */
  scope(): ChangesScope;
  /** 当前口径；非工作区会话或本会话视角为 undefined（主进程按仅未提交处理） */
  mode(): DiffMode | undefined;
  files(): ChangedFile[];
  selected(): ChangedFile | undefined;
  /** diff 区当前展示的内容（与 selected 对应），加载中或出错时可能为 undefined */
  diff(): FileDiff | undefined;
  /** diff 滚动区，扩展可在其中查找行元素与插入卡片 */
  diffScroll: HTMLElement;
  /** 选中某个文件并等待其 diff 渲染完成；文件不在列表或加载被新的操作取代时返回 false */
  selectPath(path: string): Promise<boolean>;
  /** 切换视角并重新加载列表；加载完成后返回（视图不可见时立即返回） */
  setScope(scope: ChangesScope): Promise<void>;
  /** 重新生成列表行（行尾标记随之更新），保持选中与滚动位置 */
  rerenderRows(): void;
  /** 重新生成 diff 头部的扩展按钮 */
  rerenderHead(): void;
  /** 重新拉取列表与选中文件的 diff */
  refresh(): void;
}

export interface ChangesExtInstance {
  /** 放在工具栏下方的横条，元素由扩展自己控制显隐 */
  bar?: HTMLElement;
  /** 覆盖在 diff 区上的浮层（如抽屉），挂在 diff 区容器内 */
  overlay?: HTMLElement;
  /** 文件列表行尾、增删统计之前的附加元素 */
  rowExtras?(f: ChangedFile): Node | null;
  /** diff 头部「打开」按钮之前的附加按钮 */
  headActions?(f: ChangedFile): Node | null;
  /** 选中文件的 diff 渲染完成后调用；同一文件静默刷新时也会调用 */
  diffRendered?(f: ChangedFile, d: FileDiff): void;
  /** 视图展示某会话（含切换会话） */
  show?(s: Session): void;
  /** 视角切换后、新列表加载之前调用 */
  scopeChanged?(scope: ChangesScope): void;
  /** 可见期间每次会话推送 */
  update?(s: Session): void;
  hide?(): void;
}

export interface ChangesExtension {
  /** 形如「功能.名称」 */
  id: string;
  order: number;
  attach(host: ChangesHost): ChangesExtInstance;
}
