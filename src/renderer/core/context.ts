import type { PanelApi, CreateSessionOptions } from './api.js';
import type { ChoiceOptions, ConfirmOptions, ToastLevel } from './dialog-types.js';
import type { PaletteSection, Registry } from './registry.js';
import type { AppState } from './state.js';
import type { Session } from '../../shared/types';

/**
 * 功能模块的安装上下文：features/<名称>/index.ts 导出 install(ctx: AppContext)，
 * 由入口在启动时按顺序调用。功能模块只通过它拿 api、状态、提示框、常用动作与注册入口，
 * 因此不需要导入 actions 或 views，可以整体搬走。
 */

/** 常用动作：由 builtin 层把 actions 与 views 的实现装配进来 */
export interface AppActions {
  /** 选中父会话 */
  selectSession(id: string): void;
  selectSubagent(sessionId: string, agentId: string): void;
  /** 切换详情标签，参数为标签名（注册 id 的最后一段，内置 'term' / 'changes'）；未注册的忽略 */
  setPaneTab(tab: string): void;
  /** 让会话的终端（或当前标签的内容）获得键盘焦点 */
  focusSessionInput(id: string): void;
  /** 记住该会话回到终端标签，下次选中时显示终端 */
  showTerminalTab(id: string): void;
  /** 跳到最需要处理的会话；没有待处理会话时返回 false */
  focusUrgent(): boolean;
  /** 回到首页新建表单，可预填工作目录 */
  goHome(cwd?: string): void;
  /** 创建会话并立即选中（新建表单与会话预设共用）；目录不存在等失败会抛出，由调用方提示 */
  createSessionAndSelect(label: string, cwd: string, opts?: CreateSessionOptions): Promise<Session>;
  /** 打开命令面板；指定 section 时只列该分组，输入框为空时按退格回到全部 */
  openPalette(opts?: { section?: PaletteSection }): void;
  /** 对等待权限的会话发出审批决定（带防双发锁） */
  approve(id: string, choice: 'yes' | 'no' | 'always'): void;
  closePalette(refocus?: boolean): void;
}

/** 当前可见的终端：父会话终端（终端标签下）或子代理只读终端 */
export interface ActiveTerminal {
  /** 父会话为会话 id，子代理为「会话 id + \0 + 子代理 id」，与终端层的实例表一致 */
  key: string;
  kind: 'session' | 'subagent';
  sessionId: string;
  /** xterm 的 Terminal 实例；终端被销毁重建后是另一个对象 */
  term: any;
  /** 终端卡片（宿主的父元素），浮层挂在这里，不进入宿主以免影响 fit 计算 */
  card: HTMLElement;
}

/** 终端访问：功能模块据此给 xterm 实例挂插件、叠浮层，不直接接触终端层的实例表 */
export interface TerminalAccess {
  /** 详情区当前显示的终端；首页、非终端标签或终端尚未创建时为 null */
  active(): ActiveTerminal | null;
  /** 让终端重新获得键盘焦点 */
  focus(t: ActiveTerminal): void;
  /** 按当前样式表的 --term-* 变量刷新所有已打开终端的配色（换肤后调用） */
  refreshTheme(): void;
}

export interface AppContext {
  api: PanelApi;
  terminals: TerminalAccess;
  /** 共享状态，只读；需要修改时通过 actions */
  state: Readonly<AppState>;
  /** 同步整体重绘 */
  render(): void;
  /** 按帧合并的重绘，供高频更新使用 */
  requestRender(): void;
  toast(text: string, level?: ToastLevel, onClick?: () => void): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  choice<T extends string>(opts: ChoiceOptions<T>): Promise<T | null>;
  actions: AppActions;
  registry: Registry;
}

/** 功能模块与内置组的统一安装函数形态 */
export type Install = (ctx: AppContext) => void;
