import type { ChangesExtension, ChangesExtInstance, ChangesHost } from '../../core/changes-ext.js';

/**
 * 改动视图扩展的挂载与调用。单个扩展的钩子抛错只记日志，不影响改动视图本身。
 */

export interface ExtRunner {
  each(fn: (x: ChangesExtInstance) => void): void;
  collect(fn: (x: ChangesExtInstance) => Node | null | undefined): Node[];
  /** 依次挂载扩展，返回成功挂载的实例 */
  attach(defs: ChangesExtension[], host: ChangesHost): ChangesExtInstance[];
}

export function createExtRunner(): ExtRunner {
  const exts: ChangesExtInstance[] = [];
  const each = (fn: (x: ChangesExtInstance) => void): void => {
    for (const x of exts) {
      try { fn(x); } catch (err) { console.error('[changes] 扩展执行失败：', err); }
    }
  };
  return {
    each,
    collect(fn) {
      const out: Node[] = [];
      each(x => { const n = fn(x); if (n) out.push(n); });
      return out;
    },
    attach(defs, host) {
      for (const d of defs) {
        try { exts.push(d.attach(host)); } catch (err) { console.error(`[changes] 扩展 ${d.id} 挂载失败：`, err); }
      }
      return exts.slice();
    },
  };
}
