import type { WorktreeRecord } from '../../shared/types';
import type { FilterKey } from '../../shared/filters.js';
import { cwdBaseName } from '../../shared/session-view.js';
import type { AppContext } from '../core/context.js';
import { FILTER_LABELS, STATUS_TEXT, SUBAGENT_STATUS_TEXT, subagentTitle } from '../core/labels.js';
import { loadRecent, RECENT_CWDS_KEY } from '../core/persist.js';
import type { CommandContext, PaletteItem } from '../core/registry.js';
import { render } from '../core/render.js';
import { inspectorShown, toggleInspector } from '../core/review-layout.js';
import { state, visibleSessions } from '../core/state.js';
import { toast } from '../ui/toast.js';
import { focusUrgent, selectSession, selectSubagent } from '../actions/selection.js';
import { cleanupWorktreeFlow, openWorktreeOf } from '../actions/session-actions.js';
import { setPaneTab } from '../views/detail-pane.js';
import { getChangesView } from './detail-tabs.js';
import { goHome } from '../views/home.js';

/**
 * 内置命令面板条目，按 order 依次为：新建、当前会话操作、遗留工作区清理、筛选、面板开关、会话直达。
 * 条目顺序与面板中的展示顺序一致。
 */
export interface BuiltinCommandOptions {
  /** 打开更新入口；更新界面初始化失败时为空操作 */
  openUpdateSettings(): void;
}

export function installBuiltinCommands(ctx: AppContext, opts: BuiltinCommandOptions): void {
  const { registerCommands } = ctx.registry;

  // 设置页「版本与更新」分节按 id 调用
  ctx.registry.registerOpener({ id: 'update.settings', order: 400, open: () => opts.openUpdateSettings() });

  // 新建会话：当前工作目录 + 最近用过的目录，各自一条快速新建
  registerCommands({
    id: 'core.new-session', order: 0,
    items: ({ session: cur }) => {
      const out: PaletteItem[] = [{
        section: '命令', icon: '＋', title: '新建会话', keys: 'Ctrl N',
        keywords: 'xinjian new session', run: () => goHome(),
      }];
      const cwds: string[] = [];
      if (cur) cwds.push(cur.cwd);
      for (const c of loadRecent(RECENT_CWDS_KEY)) {
        if (cwds.length >= 4) break;
        if (!cwds.includes(c)) cwds.push(c);
      }
      for (const cwd of cwds) {
        out.push({
          section: '命令', icon: '＋', title: `在 ${cwdBaseName(cwd) || cwd} 新建会话`, sub: cwd,
          keywords: `xinjian ${cwd}`, run: () => goHome(cwd),
        });
      }
      return out;
    },
  });

  registerCommands({ id: 'core.current-session', order: 100, items: currentSessionItems });

  // 遗留工作区（会话已结束但目录还在）：打开面板时异步拉取，到达后补进列表
  let leftovers: WorktreeRecord[] = [];
  registerCommands({
    id: 'core.leftover-worktrees', order: 200,
    items: () => leftovers.map(rec => ({
      section: '命令' as const, icon: '⌫', title: `清理工作区：${rec.label}`,
      sub: `${cwdBaseName(rec.path)}（已无会话）`, hint: rec.branch,
      keywords: `worktree qingli gongzuoqu cleanup ${rec.path} ${rec.branch}`,
      run: () => {
        void cleanupWorktreeFlow(rec).then(ok => {
          if (ok) leftovers = leftovers.filter(x => x.path !== rec.path);
        });
      },
    })),
    refresh: async () => {
      const list = await ctx.api.leftoverWorktrees();
      const changed = list.length !== leftovers.length
        || list.some((r, i) => r.path !== leftovers[i]?.path);
      leftovers = list;
      return changed;
    },
  });

  registerCommands({
    id: 'core.filters', order: 300,
    items: () => (Object.keys(FILTER_LABELS) as FilterKey[]).map(key => ({
      section: '命令' as const, icon: '≡', title: `筛选：${FILTER_LABELS[key]}`,
      keywords: `filter shaixuan ${key}`, run: () => { state.activeFilter = key; render(); },
    })),
  });

  registerCommands({
    id: 'core.panel', order: 400,
    items: () => [
      {
        section: '命令', icon: '◫', title: inspectorShown() ? '隐藏属性面板' : '显示属性面板',
        keywords: 'inspector shuxing',
        run: () => toggleInspector(),
      },
      {
        section: '命令', icon: '⚡', title: '跳到待处理会话', keys: 'Alt ⇧ C',
        keywords: 'urgent daichuli inbox', run: () => { focusUrgent(); },
      },
      {
        section: '命令', icon: '↑', title: '检查更新',
        keywords: 'update gengxin', run: () => opts.openUpdateSettings(),
      },
    ],
  });

  // 会话与其子代理都进面板，方便一次搜索直达
  registerCommands({
    id: 'core.sessions', order: 450,
    items: () => {
      const out: PaletteItem[] = [];
      for (const s of visibleSessions()) {
        out.push({
          section: '会话', icon: '', title: s.label, sub: cwdBaseName(s.cwd),
          hint: STATUS_TEXT[s.status], keywords: `${s.label} ${s.cwd}`,
          run: () => selectSession(s.id),
        });
        for (const sub of s.subagents ?? []) {
          out.push({
            section: '会话', icon: '↳', title: subagentTitle(sub), sub: s.label,
            hint: SUBAGENT_STATUS_TEXT[sub.status],
            keywords: `${sub.agentType} ${sub.description ?? ''} ${s.label}`,
            run: () => selectSubagent(s.id, sub.agentId),
          });
        }
      }
      return out;
    },
  });
}

/** 当前选中会话的操作：复制路径、打开工作区、终端与改动切换、刷新改动、切换改动口径（续接与全新开始由续接模块提供） */
function currentSessionItems({ session: cur, paneTab }: CommandContext): PaletteItem[] {
  if (!cur) return [];
  const out: PaletteItem[] = [];
  out.push({
    section: '命令', icon: '⧉', title: '复制工作目录', sub: cur.cwd,
    keywords: 'copy cwd fuzhi', run: () => {
      void navigator.clipboard?.writeText(cur.cwd).catch(() => undefined);
      toast('已复制工作目录');
    },
  });
  if (cur.worktree) {
    out.push({
      section: '命令', icon: '⑂', title: '在资源管理器中打开工作区', sub: cur.worktree.path,
      keywords: 'worktree gongzuoqu open dakai', run: () => void openWorktreeOf(cur.id),
    });
  }
  out.push({
    section: '命令', icon: '±', title: paneTab === 'changes' ? '返回终端' : '查看改动', sub: cur.label,
    keys: 'Ctrl ⇧ D', keywords: 'changes diff gaidong chakan terminal zhongduan',
    run: () => setPaneTab(state.paneTab === 'changes' ? 'term' : 'changes'),
  });
  out.push({
    section: '命令', icon: '⟳', title: '刷新改动', sub: cur.label,
    keywords: 'changes refresh shuaxin gaidong diff',
    run: () => {
      if (state.paneTab !== 'changes') setPaneTab('changes');
      else getChangesView()?.refresh();
    },
  });
  const view = getChangesView();
  const repoScope = view?.scope() === 'repo';
  out.push({
    section: '命令', icon: '⇄', title: repoScope ? '改动切换为「本会话改动」' : '改动切换为「仓库视角」', sub: cur.label,
    keywords: 'changes scope shijiao huihua cangku session repo gaidong',
    run: () => {
      if (state.paneTab !== 'changes') setPaneTab('changes');
      getChangesView()?.toggleScope();
    },
  });
  if (cur.worktree && repoScope) {
    const nextScope = cur.changes?.mode === 'working' ? '相对基线' : '仅未提交';
    out.push({
      section: '命令', icon: '⇄', title: `改动口径切换为「${nextScope}」`, sub: cur.label,
      keywords: 'diff mode koujing jixian base working weitijiao',
      run: () => {
        if (state.paneTab !== 'changes') setPaneTab('changes');
        getChangesView()?.toggleMode();
      },
    });
  }
  const ro = cur.readOnly ? '此会话由其他面板实例运行，只能查看' : '';
  out.push({
    section: '命令', icon: '⌫', title: '清除改动记录',
    sub: ro || `删除本会话全部改动记录与改前快照 · ${cur.label}`,
    keywords: 'clear qingchu shanchu gaidong jilu records delete',
    ...(ro ? { disabled: true, hint: ro } : {}),
    run: () => {
      if (ro) return;
      // 首次切到改动页时视图才创建，先切页，已在改动页时直接走确认流程
      if (state.paneTab !== 'changes') { setPaneTab('changes'); return; }
      void getChangesView()?.clearAll();
    },
  });
  return out;
}
