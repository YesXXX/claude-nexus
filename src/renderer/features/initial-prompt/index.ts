import type { Session } from '../../../shared/types';
import type { SendResult } from '../../../shared/review-types';
import type { AppContext } from '../../core/context.js';
import { el, ipcErrorText } from '../../core/dom.js';
import type { PaletteItem } from '../../core/registry.js';

/**
 * 首条提示词的投递状态：会话行显示「待发送」或红色「未发送」，未发送时页头给出处理按钮，
 * 可重新发送（忙碌时选择排队或立即）、插入到输入框（不提交，由用户检查后回车）或放弃。
 * 状态来自主进程合并进会话行的 pendingPrompt，变化时随会话列表推送。
 */

type PendingAction = 'retry' | 'insert' | 'discard';

const WAITING_TITLE = '首条提示词等 Claude 就绪（SessionStart、输入框开启粘贴模式、输出静默）后自动发送';

function failed(s: Session): boolean {
  return s.pendingPrompt?.state === 'failed';
}

export function install(ctx: AppContext): void {
  const busy = new Set<string>();

  const retry = async (id: string): Promise<void> => {
    let r: SendResult = await ctx.api.finish.sendPrompt(id, 'pending', 'auto');
    if (r.needChoice) {
      const perm = r.needChoice === 'permission';
      const pick = await ctx.choice<'now' | 'queue'>({
        title: perm ? 'Claude 正在等你确认权限' : 'Claude 正在处理本轮任务',
        message: perm
          ? '先处理权限再发送；也可以排队，本轮结束后自动发送。'
          : '立即发送会在 Claude 处理中插入消息；排队则在本轮结束后自动发送。',
        choices: perm
          ? [{ value: 'queue', text: '排队，本轮结束后发送', style: 'primary' }]
          : [{ value: 'now', text: '立即发送' }, { value: 'queue', text: '排队，本轮结束后发送', style: 'primary' }],
        defaultValue: 'queue',
      });
      if (!pick) return;
      r = await ctx.api.finish.sendPrompt(id, 'pending', pick);
    }
    ctx.toast(r.message, r.ok ? (r.queued ? 'info' : 'success') : 'error');
    if (r.ok && r.sent && r.warnPasteMode) ctx.toast('未检测到粘贴模式，多行消息可能被逐行提交，请留意终端', 'warning');
  };

  const run = async (s: Session, action: PendingAction): Promise<void> => {
    if (busy.has(s.id)) return;
    busy.add(s.id);
    try {
      if (action === 'retry') {
        await retry(s.id);
      } else if (action === 'insert') {
        const r = await ctx.api.insertPendingPrompt(s.id);
        ctx.toast(r.ok ? '已插入到输入框，检查后按回车发送' : (r.reason ?? '插入失败'), r.ok ? 'success' : 'error');
      } else {
        const ok = await ctx.api.finish.discardPrompt(s.id);
        if (ok) ctx.toast('已放弃首条提示词', 'info');
      }
    } catch (err) {
      ctx.toast(ipcErrorText(err), 'error');
    } finally {
      busy.delete(s.id);
      ctx.requestRender();
    }
  };

  const openMenu = async (s: Session): Promise<void> => {
    const action = await ctx.choice<PendingAction>({
      title: '首条提示词未发送',
      message: `${s.pendingPrompt?.reason ?? 'Claude 没有在时限内就绪'}。\n可以重新发送（Claude 就绪时直接发出），或插入到输入框由你检查后回车，也可以放弃。`,
      choices: [
        { value: 'retry', text: '重新发送', style: 'primary' },
        { value: 'insert', text: '插入到输入框' },
        { value: 'discard', text: '放弃' },
      ],
      defaultValue: 'retry',
    });
    if (action) await run(s, action);
  };

  ctx.registry.registerStatusBadge({
    id: 'initial-prompt.state', order: 520,
    render: s => {
      const p = s.pendingPrompt;
      if (!p) return null;
      const tag = el('span', p.state === 'failed' ? 'tagx err' : 'tagx', p.state === 'failed' ? '提示词未发送' : '提示词待发送');
      tag.dataset.role = 'prompt-state';
      tag.dataset.state = p.state;
      tag.title = p.state === 'failed' ? `${p.reason ?? '首条提示词未发送'}，在会话页头处理` : WAITING_TITLE;
      return tag;
    },
  });

  ctx.registry.registerPaneAction({
    id: 'initial-prompt.pending', order: 120,
    render: s => {
      if (!failed(s) || s.readOnly) return null;
      const b = el('button', 'btn danger', '未发送') as HTMLButtonElement;
      b.dataset.role = 'prompt-pending';
      b.title = '首条提示词未发送：重新发送、插入到输入框或放弃';
      b.disabled = busy.has(s.id);
      b.addEventListener('click', () => { void openMenu(s); });
      return b;
    },
  });

  ctx.registry.registerCommands({
    id: 'initial-prompt.palette',
    order: 540,
    items: (c): PaletteItem[] => {
      const s = c.session;
      if (!s || !failed(s) || s.readOnly) return [];
      // 命令面板关闭后再弹后续对话框，焦点才能落到对话框上
      const later = (a: PendingAction) => () => requestAnimationFrame(() => { void run(s, a); });
      return [
        { section: '命令', icon: '➤', title: '重新发送首条提示词', sub: s.label,
          keywords: 'shoutiao tishici chongxin fasong prompt retry', run: later('retry') },
        { section: '命令', icon: '⎀', title: '把首条提示词插入到输入框', sub: s.label,
          keywords: 'shoutiao tishici charu shurukuang prompt insert', run: later('insert') },
        { section: '命令', icon: '✕', title: '放弃首条提示词', sub: s.label,
          keywords: 'shoutiao tishici fangqi prompt discard', run: later('discard') },
      ];
    },
  });
}
