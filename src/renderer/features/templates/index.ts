import type { PromptTemplate, TemplateContext } from '../../../shared/template';
import { parseTemplateVars, renderTemplate, sortTemplates, templateSummary } from '../../../shared/template.js';
import type { Session } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import type { PaletteItem } from '../../core/registry.js';
import type { FillAction } from './fill-dialog.js';
import { openFillDialog } from './fill-dialog.js';
import { bindManageDialog, openTemplateManager } from './manage-dialog.js';

/**
 * 提示词模板：命令面板「模板」分组（回车填变量后插入并发送，Shift+回车只插入）、
 * Ctrl+Shift+T 打开只列模板的命令面板、管理弹窗，以及新建表单的「模板 ▾」按钮（停在首页时面板里另有「把首条提示词存为模板」）。
 * 选中会话时写入该会话的 Claude 输入框（经主进程按粘贴模式整段写入）；停在首页时填进新建表单的首条提示词。
 * 模板列表在打开命令面板时刷新缓存，命令面板的条目只读缓存。
 */

/** 不能向会话写入提示词的原因；与主进程的拒绝条件一致，提前在界面上说明 */
export function blockReason(s: Session | undefined): string | null {
  if (!s) return '没有选中会话';
  if (s.readOnly) return '此会话由其他面板实例运行，只能查看，不能插入';
  if (s.status === 'suspended' || s.status === 'disconnected' || s.exitCode !== undefined || s.dormant) {
    return '会话进程已退出，重启后再插入';
  }
  if (s.status === 'waiting_permission') return 'Claude 正在等你确认权限，先处理权限再插入';
  return null;
}

type Target = { kind: 'session'; session: Session } | { kind: 'form' };

export function install(ctx: AppContext): void {
  let cache: PromptTemplate[] = [];
  let cacheKey = '';
  const keyOf = (list: PromptTemplate[]) => list.map(t => `${t.id}:${t.updatedAt}:${t.useCount}`).join('|');
  const setCache = (list: PromptTemplate[]): void => {
    cache = sortTemplates(list);
    cacheKey = keyOf(cache);
  };
  const reload = async (): Promise<boolean> => {
    const prev = cacheKey;
    setCache(await ctx.api.templates.list());
    return cacheKey !== prev;
  };
  bindManageDialog(ctx, list => setCache(list));
  void reload().catch(err => console.error('[templates] 读取模板失败：', err));

  const formCwd = (): string => (document.getElementById('form-cwd') as HTMLInputElement | null)?.value.trim() ?? '';
  const formPrompt = (): HTMLTextAreaElement | null => document.getElementById('form-prompt') as HTMLTextAreaElement | null;

  const touch = (t: PromptTemplate): void => {
    void ctx.api.templates.touch(t.id).then(next => {
      if (next) setCache(cache.map(x => (x.id === next.id ? next : x)));
    }).catch(() => undefined);
  };

  /** 填入新建表单：替换已有内容，光标移到末尾 */
  const fillForm = (t: PromptTemplate, text: string): string | null => {
    const box = formPrompt();
    if (!box) return '新建表单不可用';
    box.value = text;
    box.focus();
    box.setSelectionRange(text.length, text.length);
    touch(t);
    return null;
  };

  const writeSession = async (t: PromptTemplate, id: string, text: string, submit: boolean): Promise<string | null> => {
    const r = await ctx.api.sendPrompt(id, text, submit);
    if (!r.ok) return r.reason ?? '写入失败';
    touch(t);
    ctx.toast(submit ? `已发送模板「${t.name}」` : '已插入到输入框，检查后按回车发送', 'success');
    ctx.actions.focusSessionInput(id);
    return null;
  };

  const act = (t: PromptTemplate, target: Target) => async (action: FillAction, text: string): Promise<string | null> => {
    if (target.kind === 'form') return fillForm(t, text);
    // 对话框打开期间状态可能已变化，执行前按最新会话再查一次
    const s = ctx.state.sessions.find(x => x.id === target.session.id);
    const blocked = blockReason(s);
    if (blocked) return blocked;
    return writeSession(t, target.session.id, text, action === 'send');
  };

  /** 使用模板：有变量时弹填写框，没有变量时直接执行 */
  const useTemplate = async (t: PromptTemplate, target: Target, primary: FillAction): Promise<void> => {
    const sessionId = target.kind === 'session' ? target.session.id : null;
    const cwd = target.kind === 'session' ? target.session.cwd : formCwd();
    const blocked = target.kind === 'session' ? blockReason(target.session) : null;
    const run = act(t, target);
    if (parseTemplateVars(t.body).length === 0) {
      if (blocked) { ctx.toast(blocked, 'error'); return; }
      const err = await run(primary, renderTemplate(t.body, {}).text);
      if (err) ctx.toast(err, 'error');
      return;
    }
    let context: TemplateContext | null = null;
    try {
      context = await ctx.api.templates.context(sessionId, cwd || undefined);
    } catch (err) {
      console.error('[templates] 计算内置变量失败：', err);
    }
    openFillDialog(ctx.api.templates, {
      template: t, context, sessionId, cwd: cwd || undefined,
      target: target.kind, primary, blocked, onAction: run,
    });
  };

  const targetOf = (s: Session | undefined): Target | null => {
    if (s) return { kind: 'session', session: s };
    return ctx.state.selectedId ? null : { kind: 'form' };
  };

  // 命令面板关闭后再弹后续对话框，焦点才能落到对话框上
  const later = (fn: () => void) => () => requestAnimationFrame(fn);

  ctx.registry.registerCommands({
    id: 'templates.palette',
    order: 560,
    items: (c): PaletteItem[] => {
      const target = c.subagent ? null : targetOf(c.session);
      const items: PaletteItem[] = [];
      if (target) {
        const blocked = target.kind === 'session' ? blockReason(target.session) : null;
        const hint = target.kind === 'form' ? '填入首条提示词' : blocked ? '不能插入' : undefined;
        for (const t of cache) {
          const primary: FillAction = target.kind === 'form' ? 'fill' : 'send';
          items.push({
            section: '模板', icon: '¶', title: t.name, sub: templateSummary(t.body), hint,
            keywords: `moban template ${t.description ?? ''} ${t.body}`,
            run: later(() => { void useTemplate(t, target, primary); }),
            runAlt: later(() => { void useTemplate(t, target, target.kind === 'form' ? 'fill' : 'insert'); }),
          });
        }
      }
      items.push(
        { section: '模板', icon: '✎', title: '管理模板', sub: cache.length > 0 ? `${cache.length} 个模板` : undefined,
          keywords: 'guanli moban template manage', run: later(() => { void openTemplateManager(); }) },
        { section: '模板', icon: '＋', title: '新建模板',
          keywords: 'xinjian moban template new', run: later(() => { void openTemplateManager({ draft: { name: '', body: '' } }); }) },
      );
      // 停在首页时可把表单里的首条提示词存为模板
      if (target?.kind === 'form') {
        const body = formPrompt()?.value ?? '';
        items.push({
          section: '模板', icon: '⇩', title: '把首条提示词存为模板',
          hint: body.trim() ? undefined : '首条提示词为空', disabled: !body.trim(),
          keywords: 'cunwei moban template save form',
          run: later(() => { void openTemplateManager({ draft: { name: '', body } }).catch(err => ctx.toast(ipcErrorText(err), 'error')); }),
        });
      }
      return items;
    },
    refresh: reload,
  });

  ctx.registry.registerHotkey({
    id: 'templates.palette', keys: 'Ctrl ⇧ T', label: '插入模板', phase: 'always', order: 530, helpOrder: 35,
    match: e => e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 't',
    run: e => { e.preventDefault(); e.stopPropagation(); ctx.actions.openPalette({ section: '模板' }); },
  });

  ctx.registry.registerOpener({ id: 'templates.manage', order: 500, open: () => { void openTemplateManager(); } });

  // 新建表单的「模板 ▾」：有模板时打开只列模板的命令面板（首页下条目填进表单），没有时直接新建
  const tools = document.getElementById('form-prompt-tools');
  if (tools) {
    const b = el('button', 'btn sm tpl-form-btn', '模板 ▾');
    b.type = 'button';
    b.id = 'form-template';
    b.title = '选择模板填入首条提示词（Ctrl+Shift+T）';
    b.addEventListener('click', () => {
      void reload().catch(() => false).then(() => {
        if (cache.length === 0) void openTemplateManager({ draft: { name: '', body: formPrompt()?.value ?? '' } });
        else ctx.actions.openPalette({ section: '模板' });
      });
    });
    tools.appendChild(b);
  }
}
