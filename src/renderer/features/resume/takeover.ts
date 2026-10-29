import type { RestartResult, Session } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import { ipcErrorText } from '../../core/dom.js';
import { button } from './resume-actions.js';

/**
 * 接管认领的孤儿会话：面板重启后认领的会话进程仍在原终端运行，面板只能监控。
 * 原终端无法重新挂到面板里，接管会结束原进程，再在面板里续接同一段对话。
 * 入口为详情页头按钮与命令面板；主进程确认不了 pid 属于本会话时不结束任何进程。
 */

let ctxRef: AppContext;
const inFlight = new Set<string>();

export function installTakeover(ctx: AppContext): void {
  ctxRef = ctx;
  ctx.registry.registerPaneAction({
    id: 'resume.takeover', order: 100,
    render: s => {
      if (!s.readOnly) return null;
      const busy = inFlight.has(s.id);
      const b = button(busy ? '正在接管…' : '接管并续接', true, () => { void runTakeover(s); }, busy);
      b.id = 'pane-takeover';
      b.title = '结束原终端里的 claude 进程，在面板里续接同一段对话';
      return b;
    },
  });
  ctx.registry.registerCommands({
    id: 'resume.takeover', order: 505,
    items: ({ session: cur }) => !cur?.readOnly ? [] : [{
      section: '命令', icon: '⇲', title: '接管并续接', sub: cur.label,
      hint: '结束原终端里的进程，在面板里续接同一段对话',
      keywords: 'takeover adopt orphan resume jieguan xujie guer',
      run: () => { void runTakeover(cur); },
    }],
  });
}

async function runTakeover(s: Session): Promise<void> {
  const c = ctxRef;
  if (inFlight.has(s.id)) return;
  const ok = await c.confirm({
    title: '接管并续接',
    message: `会话「${s.label}」的 claude 进程仍在原终端运行。接管会先结束该进程，再在面板里续接同一段对话；`
      + '原终端里正在进行的操作会中断，未提交的输入会丢失。',
    okText: '接管并续接',
    danger: true,
  });
  if (!ok) return;
  inFlight.add(s.id);
  c.render();
  try {
    const r = await c.api.orphanTakeover(s.id)
      .catch((err): RestartResult => ({ ok: false, message: ipcErrorText(err) }));
    if (!r.ok) {
      c.toast(r.message ?? '接管失败', 'error');
      return;
    }
    c.toast(r.message ? `已接管并续接（${r.message}）` : '已接管并续接', 'success');
    c.actions.showTerminalTab(s.id);
    c.actions.selectSession(s.id);
    c.actions.focusSessionInput(s.id);
  } finally {
    inFlight.delete(s.id);
    c.render();
  }
}
