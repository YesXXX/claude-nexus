import type { SessionChangedFile } from '../../../shared/session-change-types';
import type { ChangedFile } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import { el, ICON_PATHS, ipcErrorText, lineIcon } from '../../core/dom.js';
import type { ChangesExtInstance, ChangesHost } from '../../core/changes-ext.js';

/**
 * diff 行跳转外部编辑器：配置了编辑器命令后，悬停 diff 行时右缘出现「↗ :行号」按钮，
 * 点击按该行的新侧行号在编辑器中打开；删除行没有新行号，就近映射到相邻的新侧行号。
 * 未配置命令时不出现按钮，打开行为保持系统默认程序（不带行号）。
 */

/** 行元素对应的新侧行号；删除行就地近取相邻行的新行号（先后再前） */
export function lineOfRow(row: HTMLElement): number | undefined {
  const n = row.dataset.n;
  if (n !== undefined) return Number(n);
  let after: HTMLElement | null = row;
  while ((after = after.nextElementSibling as HTMLElement | null) !== null) {
    if (after.dataset.n !== undefined) return Number(after.dataset.n);
  }
  let before: HTMLElement | null = row;
  while ((before = before.previousElementSibling as HTMLElement | null) !== null) {
    if (before.dataset.n !== undefined) return Number(before.dataset.n);
  }
  return undefined;
}

export function install(ctx: AppContext): void {
  // 编辑器命令可能随时在设置里改掉，展示会话时刷新一次缓存
  let configured = false;
  const refreshConfig = async (): Promise<void> => {
    try {
      configured = !!(await ctx.api.editor.getConfig()).command;
    } catch {
      configured = false;
    }
  };
  void refreshConfig();

  ctx.registry.registerChangesExtension({
    id: 'editor-jump.changes',
    order: 610,
    attach(host: ChangesHost): ChangesExtInstance {
      const overlay = el('div', 'ejump-overlay');
      overlay.hidden = true;
      const btn = el('button', 'ejump-btn');
      btn.type = 'button';
      const label = el('span', 'ejump-label');
      btn.append(lineIcon(ICON_PATHS.open, 12, 1.6), label);
      overlay.append(btn);

      let hovered: HTMLElement | null = null;
      const hide = (): void => {
        overlay.hidden = true;
        hovered = null;
      };
      const place = (row: HTMLElement, line: number): void => {
        const pane = overlay.parentElement;
        if (!pane) return;
        const paneRect = pane.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        label.textContent = `:${line}`;
        btn.title = `在编辑器中打开这一行（第 ${line} 行）`;
        overlay.style.top = `${Math.max(0, rowRect.top - paneRect.top)}px`;
        overlay.hidden = false;
      };

      host.diffScroll.addEventListener('mousemove', (e) => {
        if (!configured) return;
        const row = ((e.target as HTMLElement | null)?.closest?.('.chg-ln') ?? null) as HTMLElement | null;
        if (!row || !host.diffScroll.contains(row)) { hide(); return; }
        const line = lineOfRow(row);
        if (line === undefined || !Number.isFinite(line) || line < 1) { hide(); return; }
        hovered = row;
        place(row, line);
      });
      host.diffScroll.addEventListener('mouseleave', hide);
      // 滚动后行位变了，按钮位置不再可靠，先收起等下一次悬停
      host.diffScroll.addEventListener('scroll', hide, { passive: true });

      btn.addEventListener('click', () => {
        const s = host.session();
        const f: ChangedFile | undefined = host.selected();
        const row = hovered;
        if (!s || !f || !row || !configured) return;
        const line = lineOfRow(row);
        if (line === undefined) return;
        const session = host.scope() === 'session';
        const path = session ? (f as SessionChangedFile).abs : f.path;
        void (async () => {
          try {
            const err = session
              ? await ctx.api.sessionChanges.openPath(s.id, path, false, line)
              : await ctx.api.openPath(s.id, path, false, line);
            if (err) ctx.toast(err, 'error');
          } catch (err) {
            ctx.toast(ipcErrorText(err), 'error');
          }
        })();
      });

      return {
        overlay,
        show(): void {
          hide();
          void refreshConfig();
        },
        scopeChanged: hide,
        diffRendered: hide,
        hide,
      };
    },
  });
}
