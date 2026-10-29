import type { ResumeCheck, Session, SessionRecord } from '../../../shared/types';
import type { AppContext } from '../../core/context.js';
import { el } from '../../core/dom.js';
import { foldSection } from '../../ui/fold-section.js';
import { cachedCheck } from './resume-actions.js';

/**
 * 属性面板「对话」分区：Claude 会话 id（可复制）、对话记录是否存在及大小、续接次数、历史 id 个数。
 * 续接次数来自会话记录，按 id 缓存；记录变化通知里带到这个 id 时重新读取并重绘。
 */

let ctxRef: AppContext;
const records = new Map<string, { rec: SessionRecord | null; pending: boolean }>();

export function installConversationSection(ctx: AppContext): void {
  ctxRef = ctx;
  ctx.registry.registerInspectorSection({ id: 'resume.conversation', order: 800, render: s => (s ? renderSection(s) : null) });
  ctx.api.onRecordsChanged(ids => {
    let hit = false;
    for (const id of ids) {
      if (!records.has(id)) continue;
      records.delete(id);
      hit = true;
    }
    if (hit) ctx.requestRender();
  });
}

/** 读缓存的会话记录；没有时后台读取，到达后重绘 */
function recordOf(id: string): SessionRecord | null | undefined {
  const hit = records.get(id);
  if (hit) return hit.pending ? undefined : hit.rec;
  const entry = { rec: null as SessionRecord | null, pending: true };
  records.set(id, entry);
  void ctxRef.api.recordGet(id).then(rec => {
    if (records.get(id) !== entry) return;
    entry.rec = rec;
    entry.pending = false;
    ctxRef.requestRender();
  }).catch(() => {
    if (records.get(id) === entry) entry.pending = false;
  });
  return undefined;
}

/** 字节数转为 B / KB / MB */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function transcriptText(s: Session, check: ResumeCheck | undefined): { text: string; cls: string } {
  if (!s.claudeSessionId) return { text: '还没有对话 id', cls: 'dim' };
  if (!check) return { text: '检查中…', cls: 'dim' };
  if (check.transcript === 'found') {
    const size = check.transcriptSize !== undefined ? `（${sizeText(check.transcriptSize)}）` : '';
    return { text: `✓ 存在${size}`, cls: 'ok' };
  }
  if (check.transcript === 'missing') return { text: '✗ 缺失', cls: 'warn' };
  return { text: '无法确认', cls: 'dim' };
}

/** 对话分区默认折叠，展开状态按分区记住；续接不可用的原因另在页头续接按钮旁的说明里 */
function renderSection(s: Session): HTMLElement | null {
  if (s.readOnly) return null;
  const { sec, body } = foldSection('conversation', '对话', 'conv-sec');
  const kv = el('div', 'kv');
  const push = (k: string, v: Node | string, cls = ''): void => {
    kv.appendChild(el('div', 'k', k));
    const cell = el('div', `v${cls ? ' ' + cls : ''}`);
    if (typeof v === 'string') cell.textContent = v; else cell.appendChild(v);
    kv.appendChild(cell);
  };

  const idCell = el('span', 'conv-id');
  if (s.claudeSessionId) {
    const cid = s.claudeSessionId;
    const text = el('span', '', `${cid.slice(0, 8)}…`);
    text.title = cid;
    const copy = el('button', 'conv-copy', '复制') as HTMLButtonElement;
    copy.type = 'button';
    copy.title = '复制完整的 Claude 会话 id';
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(cid).then(() => ctxRef.toast('已复制 Claude 会话 id')).catch(() => undefined);
    });
    idCell.append(text, copy);
  } else {
    idCell.append('—');
  }
  push('Claude 会话', idCell, 'm');

  const t = transcriptText(s, cachedCheck(s));
  push('对话记录', el('span', `conv-tr ${t.cls}`, t.text));

  const rec = recordOf(s.id);
  push('续接次数', rec ? String(rec.resumeCount) : rec === null ? '—' : '…');

  const older = Math.max(0, (s.claudeSessionIds?.length ?? 0) - 1);
  if (older > 0) push('历史 id', `${older} 个（/clear 或全新开始产生）`);

  body.appendChild(kv);
  return sec;
}
