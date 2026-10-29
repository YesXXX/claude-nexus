/**
 * git 远端地址的纯函数解析：去掉凭据、取出主机与仓库路径、生成网页上的比较页链接。
 * 支持 https / http、scp 风格（git@host:owner/repo.git）、ssh://（可带端口）三种写法；
 * 本地路径与 file:// 不对应任何网页，返回 null。
 */

export interface ParsedRemote {
  /** 主机名，不含端口，小写 */
  host: string;
  /** 仓库所属路径；GitLab 子组时为 group/sub */
  owner: string;
  repo: string;
  /** 仓库网页地址，只会是 http 或 https */
  web: string;
}

/** 去掉 URL 里的用户名与令牌：http(s) 的 userinfo 整段去掉，其他协议只去掉带密码的 userinfo */
export function stripCredentials(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/@]*)@(.*)$/i.exec(url.trim());
  if (!m) return url.trim();
  const [, scheme, userinfo, rest] = m;
  if (/^https?:\/\//i.test(scheme) || userinfo.includes(':')) return `${scheme}${rest}`;
  return url.trim();
}

function splitRepoPath(p: string): { owner: string; repo: string } | null {
  const segs = p.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const repo = segs[segs.length - 1].replace(/\.git$/i, '');
  if (!repo || segs.some(s => s === '.' || s === '..')) return null;
  return { owner: segs.slice(0, -1).join('/'), repo };
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export function parseRemote(raw: string): ParsedRemote | null {
  const url = stripCredentials(raw);
  if (!url || /^file:/i.test(url)) return null;

  // http(s)://host[:port]/owner/repo(.git)
  let m = /^(https?):\/\/([^/:?#]+)(:\d+)?(\/[^?#]*)?$/i.exec(url);
  if (m) {
    const [, scheme, hostRaw, port, p] = m;
    const host = hostRaw.toLowerCase();
    const rp = p ? splitRepoPath(p) : null;
    if (!rp || !HOST_RE.test(host)) return null;
    return { host, ...rp, web: `${scheme.toLowerCase()}://${host}${port ?? ''}/${rp.owner}/${rp.repo}` };
  }

  // ssh://[user@]host[:port]/owner/repo(.git)，网页端口与 ssh 端口无关，丢掉
  m = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?(\/.*)$/i.exec(url);
  if (m) {
    const host = m[1].toLowerCase();
    const rp = splitRepoPath(m[2]);
    if (!rp || !HOST_RE.test(host)) return null;
    return { host, ...rp, web: `https://${host}/${rp.owner}/${rp.repo}` };
  }

  // scp 风格 [user@]host:owner/repo(.git)；Windows 盘符（C:\ 或 C:/）不是主机
  m = /^(?:([^@/\\]+)@)?([^:/\\]+):(?!\/\/)(.+)$/.exec(url);
  if (m && m[2].length > 1 && !/^[\\/]/.test(m[3])) {
    const host = m[2].toLowerCase();
    const rp = splitRepoPath(m[3]);
    if (!rp || !HOST_RE.test(host)) return null;
    return { host, ...rp, web: `https://${host}/${rp.owner}/${rp.repo}` };
  }
  return null;
}

/** 分支名放进 URL 路径：各段编码，斜杠保留 */
function encBranch(b: string): string {
  return b.split('/').map(encodeURIComponent).join('/');
}

export type RemoteKind = 'github' | 'gitlab' | 'other';

export function remoteKind(r: ParsedRemote): RemoteKind {
  if (r.host.includes('gitlab')) return 'gitlab';
  if (r.host.includes('github')) return 'github';
  return 'other';
}

/**
 * 比较页（新建 PR / 合并请求）链接：GitHub 类主机为 compare 页，主机名含 gitlab 的为合并请求新建页，
 * 其他主机无法确定网页格式，返回 undefined。
 */
export function compareUrl(r: ParsedRemote, base: string, branch: string): string | undefined {
  if (!/^https?:\/\//i.test(r.web) || !base || !branch) return undefined;
  const kind = remoteKind(r);
  if (kind === 'github') return `${r.web}/compare/${encBranch(base)}...${encBranch(branch)}?expand=1`;
  if (kind === 'gitlab') {
    const q = `merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(base)}`;
    return `${r.web}/-/merge_requests/new?${q}`;
  }
  return undefined;
}

/** 复制用的命令行参数：双引号包裹，内部双引号与反斜杠转义 */
export function quoteArg(a: string): string {
  if (a && !/[\s"'\\&|<>^%$`]/.test(a)) return a;
  return `"${a.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** 降级时给用户复制的 gh pr create 命令 */
export function ghCreateCommand(base: string, branch: string, title: string, body: string): string {
  return ['gh', 'pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body].map((a, i) => (i < 3 ? a : quoteArg(a))).join(' ');
}
