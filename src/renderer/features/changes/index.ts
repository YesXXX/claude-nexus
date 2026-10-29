import type { AppContext } from '../../core/context.js';
import { el } from '../../core/dom.js';
import type { HotkeyContext } from '../../core/registry.js';
import { inReview, reviewFocus, setReviewFocus } from '../../core/review-layout.js';
import { segmented, settingRow, toggle } from '../../ui/settings-kit.js';
import { editorSettingRow } from '../editor-jump/editor-settings.js';
import type { DiffViewMode } from './diff-prefs.js';
import {
  diffView, highlightOn, ignoreWs, setDiffView, setHighlight, setIgnoreWs, toggleDiffView, toggleHighlight, toggleIgnoreWs,
} from './diff-prefs.js';
import { diffWrap, setDiffWrap, toggleDiffWrap, toggleListCollapsed } from './layout-prefs.js';

/**
 * 改动视图的显示入口：焦点在改动视图时 V 切换统一 / 分栏、W 自动换行、I 忽略空白、
 * B 收起文件列表、F 专注审阅（Esc 退出），
 * 命令面板可切换视图、换行、忽略空白、专注审阅与语法高亮，
 * 设置页「改动与 diff」分节同样可改视图、高亮、换行与忽略空白，并配置外部编辑器命令。
 * 偏好变化由 diff 区自己订阅后原地重绘或切换样式，这里只改偏好。
 */

/** 单键快捷键只在改动视图内生效；焦点掉到页面本身（如点过的按钮被收起）时，停在改动标签也算 */
function inChangesKeys(e: KeyboardEvent, c: HotkeyContext): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || c.inTerminal) return false;
  return c.inChanges || (inReview() && (!c.target || c.target === document.body));
}

const isKey = (e: KeyboardEvent, k: string): boolean => e.key === k || e.key === k.toUpperCase();

export function install(ctx: AppContext): void {
  const { registerHotkey } = ctx.registry;
  registerHotkey({
    id: 'changes.toggle-view', keys: 'V', label: '改动：统一 / 分栏', phase: 'outside-input', order: 500, helpOrder: 91,
    match: (e, c) => inChangesKeys(e, c) && isKey(e, 'v'),
    run: e => {
      e.preventDefault();
      toggleDiffView();
    },
  });
  registerHotkey({
    id: 'changes.toggle-wrap', keys: 'W', label: '改动：自动换行', phase: 'outside-input', order: 501, helpOrder: 92,
    match: (e, c) => inChangesKeys(e, c) && isKey(e, 'w'),
    run: e => {
      e.preventDefault();
      toggleDiffWrap();
    },
  });
  registerHotkey({
    id: 'changes.toggle-ignore-ws', keys: 'I', label: '改动：忽略空白差异', phase: 'outside-input', order: 504,
    helpOrder: 94.5,
    match: (e, c) => inChangesKeys(e, c) && isKey(e, 'i'),
    run: e => {
      e.preventDefault();
      toggleIgnoreWs();
    },
  });
  registerHotkey({
    id: 'changes.toggle-focus', keys: 'F', label: '改动：专注审阅（Esc 退出）', phase: 'outside-input', order: 502, helpOrder: 93,
    match: (e, c) => inChangesKeys(e, c) && isKey(e, 'f'),
    run: e => {
      e.preventDefault();
      setReviewFocus(!reviewFocus());
    },
  });
  registerHotkey({
    id: 'changes.toggle-list', keys: 'B', label: '改动：收起 / 展开文件列表', phase: 'outside-input', order: 503, helpOrder: 94,
    match: (e, c) => inChangesKeys(e, c) && isKey(e, 'b'),
    run: e => {
      e.preventDefault();
      toggleListCollapsed();
    },
  });

  ctx.registry.registerCommands({
    id: 'changes.diff-prefs', order: 500,
    items: () => {
      const items = [
        {
          section: '命令' as const, icon: '◫', title: '切换 diff 视图（统一 / 分栏）',
          sub: `当前：${diffView() === 'split' ? '分栏' : '统一'}`, keys: 'V',
          keywords: 'diff split unified fenlan tongyi qiehuan shitu view',
          run: () => { toggleDiffView(); },
        },
        {
          section: '命令' as const, icon: '↩', title: '开关 diff 自动换行',
          sub: `当前：${diffWrap() ? '开' : '关'}`, keys: 'W',
          keywords: 'diff wrap huanhang zidong',
          run: () => {
            const on = toggleDiffWrap();
            ctx.toast(on ? '已开启自动换行' : '已关闭自动换行', 'info');
          },
        },
        {
          section: '命令' as const, icon: '≈', title: '开关忽略空白差异',
          sub: `当前：${ignoreWs() ? '开' : '关'}；只影响 diff 内容，改动列表统计不变`, keys: 'I',
          keywords: 'diff whitespace ignore kongbai liukong hulue',
          run: () => {
            const on = toggleIgnoreWs();
            ctx.toast(on ? '已开启忽略空白（相当于 git diff -w）' : '已关闭忽略空白', 'info');
          },
        },
        {
          section: '命令' as const, icon: '✦', title: '开关语法高亮',
          sub: `当前：${highlightOn() ? '开' : '关'}`,
          keywords: 'diff highlight syntax yufa gaoliang kaiguan',
          run: () => {
            const on = toggleHighlight();
            ctx.toast(on ? '已开启语法高亮' : '已关闭语法高亮', 'info');
          },
        },
      ];
      if (inReview()) {
        items.splice(1, 0, {
          section: '命令', icon: '⤢', title: reviewFocus() ? '退出专注审阅' : '专注审阅',
          sub: '收起会话列表与属性面板，改动卡片占满工作区', keys: reviewFocus() ? 'Esc' : 'F',
          keywords: 'focus zhuanzhu shenyue changes review',
          run: () => { setReviewFocus(!reviewFocus()); },
        });
      }
      return items;
    },
  });

  ctx.registry.registerSettingsSection({
    id: 'changes.settings', order: 520, title: '改动与 diff',
    render: () => {
      const body = el('div');
      const view = segmented<DiffViewMode>([['unified', '统一'], ['split', '分栏']], diffView(), v => setDiffView(v));
      view.el.id = 'settings-diff-view';
      const hl = toggle(highlightOn(), on => setHighlight(on));
      hl.input.id = 'settings-diff-highlight';
      const wrap = toggle(diffWrap(), on => setDiffWrap(on));
      wrap.input.id = 'settings-diff-wrap';
      const ws = toggle(ignoreWs(), on => setIgnoreWs(on));
      ws.input.id = 'settings-diff-ignore-ws';
      body.append(
        settingRow('diff 视图', '统一：增删合在一栏；分栏：左旧右新并排，diff 区不足 640px 时暂按统一显示（改动视图里按 V 切换）', view.el),
        settingRow('自动换行', '统一视图下长行折行显示，不再横向滚动；续行缩进并在行首标出（改动视图里按 W 切换）', wrap.el),
        settingRow('忽略空白', 'diff 忽略空白差异（相当于 git diff -w），只剩空白变化的文件会给出「仅空白变化」说明；'
          + '改动列表与增删统计不受影响（改动视图里按 I 切换）', ws.el),
        settingRow('语法高亮', '按文件类型着色并标出行内的词级差异；超大的 diff 自动跳过', hl.el),
        editorSettingRow(ctx),
      );
      return body;
    },
  });
}
