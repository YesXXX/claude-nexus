/**
 * 会话预设：新建会话表单的可复用组合（工作目录、是否独立工作区、分支 / 基线、首条提示词），
 * 数据结构与输入校验的纯函数，主进程与渲染层共用。
 */

/** 预设保存后可再改名；创建会话时按下述字段回填新建表单 */
export interface SessionPreset {
  id: string;
  name: string;
  /** 工作目录（绝对路径）；创建时目录不存在会明确报错 */
  cwd: string;
  /** 是否创建独立工作区 */
  worktree: boolean;
  /** 独立工作区的分支名（留空自动生成） */
  branch?: string;
  /** 独立工作区的基线（留空取当前分支） */
  baseRef?: string;
  /** 首条提示词（可选，Claude 就绪后自动发送） */
  initialPrompt?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  useCount: number;
}

/** 保存时渲染层可传的字段；带 id 且存在时为修改（改名或更新内容），否则新建 */
export interface PresetInput {
  id?: string;
  name: string;
  cwd: string;
  worktree?: boolean;
  branch?: string;
  baseRef?: string;
  initialPrompt?: string;
}

export type PresetSaveResult = { ok: true; preset: SessionPreset } | { ok: false; error: string };

export const PRESET_NAME_MAX = 80;
export const PRESET_CWD_MAX = 1000;
export const PRESET_PROMPT_MAX = 100_000;
export const PRESET_MAX_COUNT = 200;

/**
 * 校验并规范化保存输入：名称与工作目录去首尾空白后非空且不超上限；
 * 首条提示词规范成 \n 换行；布尔开关只认真值。返回规范化输入或第一处错误。
 */
export function sanitizePresetInput(v: unknown): { ok: true; value: PresetInput } | { ok: false; error: string } {
  if (!v || typeof v !== 'object') return { ok: false, error: '参数无效' };
  const o = v as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const cwd = typeof o.cwd === 'string' ? o.cwd.trim() : '';
  const prompt = typeof o.initialPrompt === 'string' ? o.initialPrompt.replace(/\r\n?/g, '\n') : '';
  if (!name) return { ok: false, error: '预设名称不能为空' };
  if (name.length > PRESET_NAME_MAX) return { ok: false, error: `预设名称过长（上限 ${PRESET_NAME_MAX} 字）` };
  if (!cwd) return { ok: false, error: '工作目录不能为空' };
  if (cwd.length > PRESET_CWD_MAX) return { ok: false, error: `工作目录过长（上限 ${PRESET_CWD_MAX} 字）` };
  if (prompt.length > PRESET_PROMPT_MAX) return { ok: false, error: `首条提示词过长（上限 ${PRESET_PROMPT_MAX} 字）` };
  const value: PresetInput = { name, cwd, worktree: o.worktree === true };
  if (prompt.trim()) value.initialPrompt = prompt;
  if (value.worktree) {
    const branch = typeof o.branch === 'string' ? o.branch.trim() : '';
    const base = typeof o.baseRef === 'string' ? o.baseRef.trim() : '';
    if (branch) value.branch = branch;
    if (base) value.baseRef = base;
  }
  if (typeof o.id === 'string' && o.id) value.id = o.id;
  return { ok: true, value };
}

/** 列表排序：最近使用的在前，从未使用的按更新时间倒序 */
export function sortPresets(list: SessionPreset[]): SessionPreset[] {
  return [...list].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.updatedAt - a.updatedAt);
}

/** 预设的单行摘要（命令面板副标题、管理列表） */
export function presetSummary(p: SessionPreset, n = 80): string {
  const tags = [p.worktree ? '独立工作区' : '', p.initialPrompt ? '带首条提示词' : ''].filter(Boolean).join(' · ');
  const text = [p.cwd, tags].filter(Boolean).join(' · ');
  return text.length > n ? `${text.slice(0, n)}…` : text;
}
