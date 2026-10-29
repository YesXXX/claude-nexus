/**
 * 提示词模板：数据结构与变量解析、渲染的纯函数，主进程与渲染层共用。
 * 语法：{{名称}} 或 {{名称:默认值}}，名称由中文、字母、数字、下划线组成，两侧空白忽略；
 * \{{ 输出字面的 {{；名称不合规或缺右括号的 {{ 原样保留。
 */

export interface PromptTemplate {
  id: string;
  name: string;
  /** 含变量的正文 */
  body: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  useCount: number;
}

/** 保存时渲染层可传的字段；带 id 且存在时为修改，否则新建 */
export interface TemplateInput {
  id?: string;
  name: string;
  body: string;
  description?: string;
}

export type TemplateSaveResult = { ok: true; template: PromptTemplate } | { ok: false; error: string };

/** 模板解析出的变量；builtin 由面板自动填充，其余需要用户填写 */
export interface TemplateVar {
  name: string;
  builtin: boolean;
  defaultValue?: string;
  /** file 类型带「选择…」按钮，插入相对会话目录的路径 */
  kind: 'text' | 'file';
}

/** 内置变量的取值，主进程按会话或表单目录计算；取不到的项缺省 */
export interface TemplateContext {
  分支?: string;
  目录?: string;
  项目?: string;
  日期: string;
  改动文件?: string;
}

export const BUILTIN_TEMPLATE_VARS = ['分支', '目录', '项目', '日期', '改动文件'] as const;
export const FILE_TEMPLATE_VAR = '文件';

export const TEMPLATE_NAME_MAX = 80;
export const TEMPLATE_BODY_MAX = 20_000;
export const TEMPLATE_DESC_MAX = 500;

const BUILTIN = new Set<string>(BUILTIN_TEMPLATE_VARS);

/** 每次调用新建，避免共享 lastIndex */
const tokenRe = () => /\\\{\{|\{\{\s*([\p{L}\p{N}_]+)\s*(?::([^{}]*))?\}\}/gu;

export function isBuiltinVar(name: string): boolean {
  return BUILTIN.has(name);
}

/** 按首次出现的顺序列出变量（同名只列一次，默认值取第一个写了默认值的位置） */
export function parseTemplateVars(body: string): TemplateVar[] {
  const out = new Map<string, TemplateVar>();
  for (const m of body.matchAll(tokenRe())) {
    const name = m[1];
    if (!name) continue;
    const def = m[2];
    const prev = out.get(name);
    if (prev) {
      if (prev.defaultValue === undefined && def !== undefined) prev.defaultValue = def;
      continue;
    }
    const v: TemplateVar = { name, builtin: isBuiltinVar(name), kind: name === FILE_TEMPLATE_VAR ? 'file' : 'text' };
    if (def !== undefined) v.defaultValue = def;
    out.set(name, v);
  }
  return [...out.values()];
}

/** 需要用户填写的变量：非内置的，以及文件变量 */
export function userVars(vars: TemplateVar[]): TemplateVar[] {
  return vars.filter(v => !v.builtin);
}

/**
 * 用取值渲染正文。取值为空白时依次退回默认值；内置变量没有取值时渲染为空串；
 * 自定义变量既没有取值也没有默认值时列入 missing（界面据此禁止发送），该处渲染为空串。
 */
export function renderTemplate(body: string, values: Record<string, string | undefined>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(tokenRe(), (_whole, name: string | undefined, def: string | undefined) => {
    if (!name) return '{{';
    const v = values[name];
    if (v !== undefined && v.trim() !== '') return v;
    if (def !== undefined) return def;
    if (!isBuiltinVar(name) && !missing.includes(name)) missing.push(name);
    return '';
  });
  return { text, missing };
}

/** 内置变量上下文转成渲染用的取值表 */
export function contextValues(ctx: TemplateContext | null | undefined): Record<string, string | undefined> {
  if (!ctx) return {};
  return { 分支: ctx.分支, 目录: ctx.目录, 项目: ctx.项目, 日期: ctx.日期, 改动文件: ctx.改动文件 };
}

/** 本地日期 yyyy-MM-dd */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 正文前 n 个字符的单行摘要（命令面板副标题） */
export function templateSummary(body: string, n = 60): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/**
 * 校验并规范化保存输入：名称去首尾空白后非空且不超过上限，正文非空且不超过上限，说明可缺省。
 * 返回规范化后的输入或第一处错误。
 */
export function sanitizeTemplateInput(v: unknown): { ok: true; value: TemplateInput } | { ok: false; error: string } {
  if (!v || typeof v !== 'object') return { ok: false, error: '参数无效' };
  const o = v as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const body = typeof o.body === 'string' ? o.body.replace(/\r\n?/g, '\n') : '';
  const description = typeof o.description === 'string' ? o.description.trim() : '';
  if (!name) return { ok: false, error: '模板名称不能为空' };
  if (name.length > TEMPLATE_NAME_MAX) return { ok: false, error: `模板名称过长（上限 ${TEMPLATE_NAME_MAX} 字）` };
  if (!body.trim()) return { ok: false, error: '模板正文不能为空' };
  if (body.length > TEMPLATE_BODY_MAX) return { ok: false, error: `模板正文过长（上限 ${TEMPLATE_BODY_MAX} 字）` };
  if (description.length > TEMPLATE_DESC_MAX) return { ok: false, error: `说明过长（上限 ${TEMPLATE_DESC_MAX} 字）` };
  const value: TemplateInput = { name, body };
  if (description) value.description = description;
  if (typeof o.id === 'string' && o.id) value.id = o.id;
  return { ok: true, value };
}

/** 列表排序：最近使用的在前，从未使用的按更新时间倒序 */
export function sortTemplates(list: PromptTemplate[]): PromptTemplate[] {
  return [...list].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.updatedAt - a.updatedAt);
}
