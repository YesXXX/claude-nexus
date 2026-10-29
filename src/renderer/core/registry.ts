import type { Session, SubagentEntry } from '../../shared/types';
import type { ChangesExtension } from './changes-ext.js';
import { normalizeKeys } from './keys.js';

/**
 * 扩展点注册表：纯数据，不访问 DOM，可以在 node 中单测。
 * 规则：
 * - 只在安装阶段（install(ctx)）注册，模块顶层不注册；
 * - id 形如「功能.名称」，内置项用 core. 前缀，重复 id 注册时抛错；
 * - order 小的在前，内置项占 0~499，功能模块从 500 起并留出间隔；order 相同按注册先后；
 * - 每个注册函数返回注销函数，供功能开关或单测使用。
 */

interface Entry {
  id: string;
  order: number;
}

const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

/** 一张按 id 去重、按 order 排序的注册表 */
function createTable<T extends Entry>(kind: string) {
  const items = new Map<string, T>();
  return {
    add(item: T): () => void {
      if (!ID_RE.test(item.id)) throw new Error(`${kind} id 不合规（应为「功能.名称」）：${item.id}`);
      if (items.has(item.id)) throw new Error(`${kind} 重复注册：${item.id}`);
      items.set(item.id, item);
      return () => {
        if (items.get(item.id) === item) items.delete(item.id);
      };
    },
    list(): T[] {
      // Map 保持插入顺序，Array.prototype.sort 是稳定排序，order 相同即按注册先后
      return [...items.values()].sort((a, b) => a.order - b.order);
    },
  };
}

// ================= 命令面板 =================

export type PaletteSection = '命令' | '模板' | '会话' | '预设' | '历史';

export interface PaletteItem {
  section: PaletteSection;
  icon: string;
  title: string;
  sub?: string;
  hint?: string;
  /** 快捷键展示文本，按空格分成若干个键帽，如 'Ctrl ⇧ D' */
  keys?: string;
  /** 拼音首字母与英文别名，参与过滤 */
  keywords?: string;
  /** 置灰显示、不可执行（如不可续接的历史条目，原因放 hint） */
  disabled?: boolean;
  /** 只在输入了搜索词或面板限定在本分组时显示，避免大量条目挤占空输入时的列表 */
  queryOnly?: boolean;
  run(): void;
  /** Shift+Enter 执行的备选动作（如模板只插入不发送）；缺省时 Shift+Enter 等同回车 */
  runAlt?(): void;
}

export interface CommandContext {
  /** 当前选中的父会话（选中子代理时为其父会话） */
  session: Session | undefined;
  /** 当前选中的子代理 */
  subagent: SubagentEntry | undefined;
  /** 详情区当前所在的标签 id */
  paneTab: string;
}

export interface CommandProvider {
  id: string;
  order: number;
  /** 同步返回条目，只读缓存、不发 IPC；当前上下文不可用的命令直接不返回 */
  items(ctx: CommandContext): PaletteItem[];
  /** 打开面板时并行调用，刷新缓存；返回 true 表示缓存有变化，面板仍打开时会重建列表 */
  refresh?(): Promise<boolean>;
}

const commandTable = createTable<CommandProvider>('命令');

export function registerCommands(p: CommandProvider): () => void {
  return commandTable.add(p);
}

export function commandProviders(): CommandProvider[] {
  return commandTable.list();
}

const SECTION_ORDER: Record<PaletteSection, number> = { 命令: 0, 会话: 1, 模板: 2, 预设: 3, 历史: 4 };

/** 按分组归拢（命令、会话、模板、预设、历史），分组内保持 provider 顺序 */
export function collectCommandItems(ctx: CommandContext): PaletteItem[] {
  const items = commandProviders().flatMap(p => p.items(ctx));
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => SECTION_ORDER[a.it.section] - SECTION_ORDER[b.it.section] || a.i - b.i)
    .map(x => x.it);
}

/** 并行刷新各 provider 的缓存，失败的忽略；任一有变化即返回 true */
export async function refreshCommandProviders(): Promise<boolean> {
  const results = await Promise.all(commandProviders().map(async p => {
    try { return p.refresh ? await p.refresh() : false; } catch { return false; }
  }));
  return results.some(Boolean);
}

// ================= 热键 =================

export interface HotkeyContext {
  target: HTMLElement | null;
  /** 焦点在 INPUT 或可编辑元素上（xterm 的隐藏 textarea 不算） */
  inInput: boolean;
  /** 焦点在 xterm 的隐藏输入区 */
  inTerminal: boolean;
  /** 焦点在改动视图内 */
  inChanges: boolean;
  /** 当前选中的父会话 */
  session: Session | undefined;
}

export type HotkeyPhase = 'always' | 'outside-input';

export interface HotkeySpec {
  id: string;
  /** 展示文本，如 'Ctrl ⇧ D'；同一阶段内规范化后不得重复 */
  keys: string;
  /** 快捷键说明 */
  label: string;
  /** always 先于「焦点在输入框则返回」的判断参与匹配；outside-input 只在焦点不在输入框时匹配 */
  phase: HotkeyPhase;
  /** 同一阶段内按 order 依次匹配，第一个 match 为真的执行后停止 */
  order: number;
  /** 需要让给终端或输入框的情况在这里返回 false，而不是在 run 里什么都不做 */
  match(e: KeyboardEvent, ctx: HotkeyContext): boolean;
  /** preventDefault / stopPropagation 由 run 自己决定 */
  run(e: KeyboardEvent, ctx: HotkeyContext): void;
  /** 是否出现在设置页的快捷键分节，默认 true */
  help?: boolean;
  /** 快捷键分节内的排列顺序，缺省取 order；与匹配顺序无关 */
  helpOrder?: number;
}

const hotkeyTable = createTable<HotkeySpec>('热键');

/** 同一阶段内按键展示文本规范化后重复的，注册时抛错 */
export function registerHotkey(spec: HotkeySpec): () => void {
  const keys = normalizeKeys(spec.keys);
  const clash = hotkeysOf(spec.phase).find(h => h.id !== spec.id && normalizeKeys(h.keys) === keys);
  if (clash) throw new Error(`热键 ${spec.id} 与 ${clash.id} 在同一阶段使用相同按键：${spec.keys}`);
  return hotkeyTable.add(spec);
}

/** 某一阶段的热键，按匹配顺序排列 */
export function hotkeysOf(phase: HotkeyPhase): HotkeySpec[] {
  return hotkeyTable.list().filter(h => h.phase === phase);
}

/** 在某一阶段中找到第一个匹配的热键 */
export function findHotkey(phase: HotkeyPhase, e: KeyboardEvent, ctx: HotkeyContext): HotkeySpec | undefined {
  return hotkeysOf(phase).find(h => h.match(e, ctx));
}

/** 设置页快捷键分节展示的条目：[说明, 按键] */
export function hotkeyHelpRows(): Array<[string, string]> {
  return hotkeyTable.list()
    .filter(h => h.help !== false)
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (a.h.helpOrder ?? a.h.order) - (b.h.helpOrder ?? b.h.order) || a.i - b.i)
    .map(({ h }) => [h.label, h.keys]);
}

// ================= 状态标记 =================

export interface StatusBadge {
  id: string;
  order: number;
  /**
   * 每次整体重绘时对选中的父会话调用，结果排在属性面板「状态」分区里；必须是纯同步函数：
   * 只读 Session 字段，不发 IPC、不读 localStorage。返回 null 表示该会话不显示；说明文字放 title。
   */
  render(s: Session): HTMLElement | null;
}

const statusBadgeTable = createTable<StatusBadge>('状态标记');

export function registerStatusBadge(m: StatusBadge): () => void {
  return statusBadgeTable.add(m);
}

export function statusBadges(): StatusBadge[] {
  return statusBadgeTable.list();
}

// ================= 详情标签 =================

export interface DetailTabView {
  /** 切到该标签或换会话时调用 */
  show(s: Session): void;
  /** 标签可见期间，每次会话推送都会调用 */
  update(s: Session): void;
  /** 切走或离开详情时调用，迟到的异步结果必须丢弃 */
  hide(): void;
  /** 键盘焦点移入标签内容 */
  focus(): void;
}

export interface DetailTab {
  /** 生成 #tab-<id> 按钮；宿主为 #<id>-host，页面里没有时自动创建 */
  id: string;
  title: string;
  order: number;
  /** 返回 false 时隐藏标签按钮，当前停在该标签的会退回终端 */
  available?(s: Session): boolean;
  /** 标签上的数字，如改动增删；提供时按钮内生成 #tab-<id>-stat */
  stat?(s: Session): Node | null;
  tooltip?(s: Session): string;
  /** 第一次切到该标签时才创建；终端标签是内置特例，没有 create */
  create?(host: HTMLElement): DetailTabView;
  /** Esc 是否回到终端，默认 true */
  escBack?: boolean;
}

const detailTabTable = createTable<DetailTab>('详情标签');

/** 详情标签的 id 会拼进 DOM id，只取「功能.名称」中的名称部分 */
export function detailTabKey(t: Pick<DetailTab, 'id'>): string {
  return t.id.slice(t.id.lastIndexOf('.') + 1);
}

export function registerDetailTab(t: DetailTab): () => void {
  const key = detailTabKey(t);
  const clash = detailTabs().find(x => x.id !== t.id && detailTabKey(x) === key);
  if (clash) throw new Error(`详情标签 ${t.id} 与 ${clash.id} 的名称部分重复：${key}`);
  return detailTabTable.add(t);
}

export function detailTabs(): DetailTab[] {
  return detailTabTable.list();
}

/** 按标签名（state.paneTab 的取值）查找 */
export function detailTab(key: string): DetailTab | undefined {
  return detailTabs().find(t => detailTabKey(t) === key);
}

// ================= 属性面板分区与页头操作 =================

export interface InspectorSection {
  id: string;
  order: number;
  /** 未选中会话时 s 为 undefined；返回 null 表示不显示该分区 */
  render(s: Session | undefined): HTMLElement | null;
}

const inspectorTable = createTable<InspectorSection>('属性面板分区');

export function registerInspectorSection(sec: InspectorSection): () => void {
  return inspectorTable.add(sec);
}

export function inspectorSections(): InspectorSection[] {
  return inspectorTable.list();
}

export interface PaneAction {
  id: string;
  order: number;
  /** 父会话详情页头右侧的按钮（或含说明文字的按钮组）；返回 null 表示该会话不显示 */
  render(s: Session): HTMLElement | null;
}

const paneActionTable = createTable<PaneAction>('页头操作');

export function registerPaneAction(a: PaneAction): () => void {
  return paneActionTable.add(a);
}

export function paneActions(): PaneAction[] {
  return paneActionTable.list();
}

export interface PaneMenuItem {
  id: string;
  order: number;
  /** 详情页头「⋯」菜单里的一项；返回 null 表示该会话不显示 */
  item(s: Session): { label: string; role?: string; danger?: boolean; disabled?: boolean; title?: string; run(): void } | null;
}

const paneMenuTable = createTable<PaneMenuItem>('页头菜单');

export function registerPaneMenuItem(m: PaneMenuItem): () => void {
  return paneMenuTable.add(m);
}

export function paneMenuItems(): PaneMenuItem[] {
  return paneMenuTable.list();
}

export interface TermCover {
  id: string;
  order: number;
  /**
   * 终端标签下替代终端显示的内容，用于没有进程、也不挂 xterm 的会话行（如待续接）。
   * 按 order 取第一个非 null 的结果；全部返回 null 时照常挂载终端。
   */
  render(s: Session): HTMLElement | null;
}

const termCoverTable = createTable<TermCover>('终端替代');

export function registerTermCover(c: TermCover): () => void {
  return termCoverTable.add(c);
}

export function termCovers(): TermCover[] {
  return termCoverTable.list();
}

// ================= 改动视图扩展 =================

const changesExtTable = createTable<ChangesExtension>('改动视图扩展');

/** 改动视图在创建时读取扩展列表，因此须在第一次切到改动标签之前注册 */
export function registerChangesExtension(x: ChangesExtension): () => void {
  return changesExtTable.add(x);
}

export function changesExtensions(): ChangesExtension[] {
  return changesExtTable.list();
}

// ================= 具名入口 =================

export interface Opener {
  /** 如 history.panel：其他模块按 id 查找并调用，查不到时隐藏对应入口 */
  id: string;
  order: number;
  open(): void;
}

const openerTable = createTable<Opener>('具名入口');

export function registerOpener(o: Opener): () => void {
  return openerTable.add(o);
}

export function findOpener(id: string): Opener | undefined {
  return openerTable.list().find(o => o.id === id);
}

// ================= 设置页分节 =================

export interface SettingsSection {
  id: string;
  order: number;
  /** 分节标题，同时作为左侧导航项 */
  title: string;
  /**
   * 每次打开设置页时调用，返回分节内容（标题由设置页生成）；返回 null 表示不显示。
   * 需要异步读取的设置先返回占位元素，数据到达后自行填充。
   */
  render(): HTMLElement | null;
}

const settingsTable = createTable<SettingsSection>('设置分节');

export function registerSettingsSection(sec: SettingsSection): () => void {
  return settingsTable.add(sec);
}

export function settingsSections(): SettingsSection[] {
  return settingsTable.list();
}

/** 逐项调用扩展点的 render，单项抛错只记日志、不拖垮整块重绘 */
export function renderEach<T extends Entry, A, R>(list: T[], arg: A, fn: (item: T, arg: A) => R | null): R[] {
  const out: R[] = [];
  for (const item of list) {
    try {
      const r = fn(item, arg);
      if (r !== null) out.push(r);
    } catch (err) {
      console.error(`[registry] ${item.id} 渲染失败：`, err);
    }
  }
  return out;
}

// ================= 注册入口汇总 =================

/** 交给功能模块的注册入口集合（AppContext.registry） */
export const registry = {
  registerCommands,
  registerHotkey,
  registerStatusBadge,
  registerDetailTab,
  registerInspectorSection,
  registerPaneAction,
  registerPaneMenuItem,
  registerTermCover,
  registerOpener,
  registerChangesExtension,
  registerSettingsSection,
};

export type Registry = typeof registry;
