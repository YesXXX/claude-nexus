import type { Session } from '../../../shared/types';
import type { FinishStatus } from '../../../shared/review-types';
import {
  commitBlockReason, mergeBlockReason, needsPushBeforePr, prBlockReason, pushBlockReason, READ_ONLY_TEXT,
} from '../../../shared/finish-rules.js';
import { el } from '../../core/dom.js';
import {
  abortFlow, commitFlow, copyGhCommand, mergeFlow, openCompare, openConflictSession, prFlow, pushFlow, sendPromptFlow,
  type FinishFlowDeps,
} from './finish-flow.js';

/**
 * 收尾页的四个分区：提交、合并、推送、创建 PR。每次状态刷新整体重建，
 * 用户输入（提交信息、PR 标题与说明、所选远端与合并方式）存在每个会话的草稿里，重建后原样恢复。
 * 不能执行的按钮置灰，悬停显示与主进程复查同一份规则给出的原因。
 */

export interface Draft {
  msg: string;
  noVerify: boolean;
  ffOnly: boolean;
  remote?: string;
  /** 用户改过后不再被状态里的默认值覆盖 */
  prTitle?: string;
  prBody?: string;
}

export interface SectionEnv {
  s: Session;
  st: FinishStatus;
  draft: Draft;
  /** 有操作在执行，所有按钮暂不可用 */
  running: boolean;
  flow: FinishFlowDeps;
  /** 执行一个操作：期间置为执行中，结束后刷新状态与记录 */
  run(op: () => Promise<unknown>): void;
}

const RUNNING_TEXT = '有操作正在执行';

export function actBtn(text: string, cls: string, reason: string | undefined, onClick: () => void): HTMLButtonElement {
  const b = el('button', `chg-btn ${cls}`, text);
  b.type = 'button';
  b.disabled = !!reason;
  if (reason) b.title = reason;
  b.addEventListener('click', () => { if (!b.disabled) onClick(); });
  return b;
}

function section(title: string, cls: string): { box: HTMLElement; head: HTMLElement } {
  const box = el('section', `fin-sec ${cls}`);
  const head = el('div', 'fin-sec-head');
  head.append(el('h3', 'fin-sec-title', title));
  box.append(head);
  return { box, head };
}

function row(...nodes: Node[]): HTMLElement {
  const r = el('div', 'fin-row');
  r.append(...nodes);
  return r;
}

/** 行尾靠右的一组控件：整组一起换行，换行后仍靠右，不会把主按钮单独甩到左边 */
function end(...nodes: Node[]): HTMLElement {
  const g = el('span', 'fin-row-end');
  g.append(...nodes);
  return g;
}

function checkbox(label: string, cls: string, checked: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const l = el('label', `fin-check ${cls}`);
  const c = el('input');
  c.type = 'checkbox';
  c.checked = checked;
  c.addEventListener('change', () => onChange(c.checked));
  l.append(c, document.createTextNode(label));
  return l;
}

function radio(name: string, label: string, cls: string, checked: boolean, onPick: () => void): HTMLLabelElement {
  const l = el('label', `fin-check ${cls}`);
  const r = el('input');
  r.type = 'radio';
  r.name = name;
  r.checked = checked;
  r.addEventListener('change', () => { if (r.checked) onPick(); });
  l.append(r, document.createTextNode(label));
  return l;
}

function gate(env: SectionEnv, reason: string | undefined): string | undefined {
  return env.running ? RUNNING_TEXT : reason;
}

export function commitSection(env: SectionEnv): HTMLElement {
  const { s, st, draft } = env;
  const { box, head } = section('提交', 'fin-commit-sec');
  head.append(el('span', 'fin-sec-sub', st.dirty > 0 ? `${st.dirty} 个未提交改动` : '没有未提交改动'));
  const ta = el('textarea', 'fin-input fin-msg');
  ta.rows = 3;
  ta.placeholder = '提交信息（第一行为标题）';
  ta.value = draft.msg;
  ta.dataset.focusKey = 'msg';
  ta.disabled = st.readOnly;
  const block = commitBlockReason(st);
  const commit = actBtn('提交', 'primary fin-commit', gate(env, block ?? (draft.msg.trim() ? undefined : '先填写提交信息')),
    () => env.run(() => commitFlow(env.flow, s, st, draft.msg, draft.noVerify)));
  ta.addEventListener('input', () => {
    draft.msg = ta.value;
    const reason = gate(env, block ?? (ta.value.trim() ? undefined : '先填写提交信息'));
    commit.disabled = !!reason;
    commit.title = reason ?? '';
  });
  const suggest = actBtn('请 Claude 生成', 'fin-suggest', gate(env, st.readOnly ? READ_ONLY_TEXT : st.dirty === 0 ? '没有需要提交的改动' : undefined),
    () => env.run(async () => {
      suggest.textContent = '生成中…';
      const r = await env.flow.api.suggest(s.id);
      if (r.ok && r.text) { draft.msg = r.text; ta.value = r.text; }
      else env.flow.toast(r.error ?? '生成提交信息失败', 'error');
    }));
  suggest.title = suggest.title || '将调用一次 claude，根据改动生成提交信息';
  const self = actBtn('让本会话自己提交', 'fin-self-commit', gate(env, block),
    () => env.run(() => sendPromptFlow(env.flow, s.id, 'commit')));
  self.title = self.title || '把「检查改动并提交」的提示词发给本会话的 Claude';
  box.append(
    ta,
    row(suggest, el('span', 'fin-note', '将调用一次 claude'), self,
      end(checkbox('跳过提交钩子', 'fin-noverify', draft.noVerify, v => { draft.noVerify = v; }), commit)),
  );
  return box;
}

function precheckText(st: FinishStatus): { text: string; cls: string } | null {
  const p = st.precheck;
  if (!p) return null;
  if (p.state === 'clean') return { text: '预检：可以干净合并', cls: 'ok' };
  if (p.state === 'conflict') return { text: `预检：会冲突（${p.files.join('、') || '未知文件'}）`, cls: 'warn' };
  if (p.state === 'nothing') return { text: '预检：没有需要合并的提交', cls: '' };
  return { text: '预检：无法预判是否冲突', cls: '' };
}

export function mergeSection(env: SectionEnv): HTMLElement {
  const { s, st, draft } = env;
  const { box, head } = section('合并', 'fin-merge-sec');
  head.append(el('span', 'fin-sec-sub', `${st.branch} → ${st.baseRef}（主工作区 ${st.main.path}）`));
  const block = mergeBlockReason(st);
  const modes = row(
    radio(`fin-mode-${s.id}`, '保留合并提交 --no-ff', 'fin-noff', !draft.ffOnly, () => { draft.ffOnly = false; }),
    radio(`fin-mode-${s.id}`, '仅快进 --ff-only', 'fin-ff', draft.ffOnly, () => { draft.ffOnly = true; }),
  );
  box.append(modes);
  const pre = precheckText(st);
  if (pre) box.append(el('div', `fin-precheck ${pre.cls}`, pre.text));
  const merge = actBtn('合并', 'primary fin-merge', gate(env, block),
    () => env.run(() => mergeFlow(env.flow, s, st, draft.ffOnly)));
  const actions: Node[] = [];
  if (st.precheck?.state === 'conflict') {
    const inWt = actBtn('让本会话先在工作区里把基线合进来', 'fin-merge-in-wt', gate(env, st.readOnly ? READ_ONLY_TEXT : undefined),
      () => env.run(() => sendPromptFlow(env.flow, s.id, 'merge-in-worktree')));
    inWt.title = inWt.title || `让 Claude 在工作区里合入 ${st.baseRef} 并解决冲突，之后这里再合并就不会冲突`;
    actions.push(inWt);
  }
  if (st.main.inProgress === 'merge') {
    const ro = gate(env, st.readOnly ? READ_ONLY_TEXT : undefined);
    actions.push(
      actBtn('开一个解决冲突的会话', 'fin-conflict-session', ro, () => env.run(() => openConflictSession(env.flow, s.id))),
      actBtn('放弃合并', 'fin-abort', ro, () => env.run(() => abortFlow(env.flow, s, st))),
    );
  }
  box.append(row(...actions, end(merge)));
  return box;
}

/** 当前选中的远端：草稿里的仍存在则沿用，否则只有一个远端时自动选中，多个时优先 origin */
export function pickRemote(st: FinishStatus, draft: Draft): string | undefined {
  const names = st.remotes.map(r => r.name);
  if (draft.remote && names.includes(draft.remote)) return draft.remote;
  return names.length === 1 ? names[0] : names.find(n => n === 'origin') ?? names[0];
}

function remoteSelect(st: FinishStatus, draft: Draft, current: string | undefined, onChange: () => void): HTMLSelectElement {
  const sel = el('select', 'fin-input fin-remote');
  for (const r of st.remotes) {
    const o = el('option', '', r.name);
    o.value = r.name;
    o.title = r.url;
    o.selected = r.name === current;
    sel.append(o);
  }
  sel.disabled = st.remotes.length <= 1;
  sel.addEventListener('change', () => { draft.remote = sel.value; onChange(); });
  return sel;
}

export function pushSection(env: SectionEnv, rerender: () => void): HTMLElement {
  const { s, st, draft } = env;
  const { box, head } = section('推送', 'fin-push-sec');
  const up = st.upstream;
  head.append(el('span', 'fin-sec-sub', up ? `上游 ${up.name} · 领先 ${up.ahead} 落后 ${up.behind}` : '尚未推送到任何远端'));
  const remote = pickRemote(st, draft);
  const nodes: Node[] = [];
  if (st.remotes.length > 0) {
    nodes.push(el('span', 'fin-label', '远端'), remoteSelect(st, draft, remote, rerender));
    const url = st.remotes.find(r => r.name === remote)?.url;
    if (url) nodes.push(el('span', 'fin-note fin-remote-url', url));
  }
  const push = actBtn('推送', 'primary fin-push', gate(env, pushBlockReason(st, remote)),
    () => { if (remote) env.run(() => pushFlow(env.flow, s, st, remote)); });
  box.append(row(...nodes, end(push)));
  return box;
}

function ghText(st: FinishStatus): { text: string; cls: string } {
  const g = st.gh;
  if (g.state === 'ok') return { text: `gh：已登录${g.host ? ` ${g.host}` : ''}`, cls: 'ok' };
  if (g.state === 'missing') return { text: 'gh：未安装', cls: 'warn' };
  if (g.state === 'unauthed') return { text: `gh：未登录${g.host ? ` ${g.host}` : ''}`, cls: 'warn' };
  return { text: 'gh：未检测', cls: '' };
}

export function prSection(env: SectionEnv): HTMLElement {
  const { s, st, draft } = env;
  const { box, head } = section('创建 PR', 'fin-pr-sec');
  const gh = ghText(st);
  head.append(el('span', `fin-gh ${gh.cls}`, gh.text));
  const remote = pickRemote(st, draft);
  const title = el('input', 'fin-input fin-pr-title');
  title.placeholder = 'PR 标题';
  title.value = draft.prTitle ?? st.prTitle;
  title.dataset.focusKey = 'prTitle';
  title.addEventListener('input', () => { draft.prTitle = title.value; });
  const body = el('textarea', 'fin-input fin-pr-body');
  body.rows = 4;
  body.placeholder = 'PR 说明';
  body.value = draft.prBody ?? st.prBody;
  body.dataset.focusKey = 'prBody';
  body.addEventListener('input', () => { draft.prBody = body.value; });
  title.disabled = body.disabled = st.readOnly;
  const pushFirst = !!remote && needsPushBeforePr(st, remote);
  const nodes: Node[] = [];
  if (remote && pushFirst) nodes.push(el('span', 'fin-note', `将先推送到 ${remote}`));
  const copy = actBtn('复制命令', 'fin-pr-copy', st.remotes.length ? undefined : '没有配置远端',
    () => void copyGhCommand(env.flow, st, title.value, body.value));
  copy.title = copy.title || '复制 gh pr create 命令，可在终端里手动执行';
  const web = st.remotes.find(r => r.name === remote)?.web;
  const compare = actBtn('打开比较页', 'fin-pr-compare', web ? undefined : '该远端无法生成比较页链接',
    () => { if (remote) void openCompare(env.flow, s.id, remote); });
  if (st.gh.state === 'ok') {
    const create = actBtn('创建 PR', 'primary fin-pr-create', gate(env, prBlockReason(st, remote)),
      () => { if (remote) env.run(() => prFlow(env.flow, s, st, remote, title.value, body.value, pushFirst)); });
    nodes.push(end(copy, compare, create));
  } else {
    nodes.push(end(copy, compare));
  }
  box.append(title, body, row(...nodes));
  return box;
}
