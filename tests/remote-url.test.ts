import { describe, it, expect } from 'vitest';
import { compareUrl, ghCreateCommand, parseRemote, quoteArg, remoteKind, stripCredentials } from '../src/shared/remote-url';

describe('stripCredentials', () => {
  it('去掉 https 的用户名与令牌', () => {
    expect(stripCredentials('https://user:ghp_abc@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(stripCredentials('https://ghp_abc@github.com/o/r.git')).toBe('https://github.com/o/r.git');
  });
  it('ssh 只去掉带密码的 userinfo，scp 风格原样', () => {
    expect(stripCredentials('ssh://git@host.com/o/r.git')).toBe('ssh://git@host.com/o/r.git');
    expect(stripCredentials('ssh://u:secret@host.com/o/r.git')).toBe('ssh://host.com/o/r.git');
    expect(stripCredentials('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
  });
});

describe('parseRemote', () => {
  it('https，带与不带 .git 后缀', () => {
    expect(parseRemote('https://github.com/o/r.git')).toEqual({ host: 'github.com', owner: 'o', repo: 'r', web: 'https://github.com/o/r' });
    expect(parseRemote('https://github.com/o/r')?.web).toBe('https://github.com/o/r');
  });
  it('https 带凭据与端口：凭据去掉，网页保留端口', () => {
    expect(parseRemote('https://u:t@git.corp.com:8443/team/app.git')).toEqual({
      host: 'git.corp.com', owner: 'team', repo: 'app', web: 'https://git.corp.com:8443/team/app',
    });
  });
  it('scp 风格', () => {
    expect(parseRemote('git@github.com:o/r.git')).toEqual({ host: 'github.com', owner: 'o', repo: 'r', web: 'https://github.com/o/r' });
  });
  it('ssh:// 带端口：网页地址不带 ssh 端口', () => {
    expect(parseRemote('ssh://git@gitlab.example.com:2222/g/sub/r.git')).toEqual({
      host: 'gitlab.example.com', owner: 'g/sub', repo: 'r', web: 'https://gitlab.example.com/g/sub/r',
    });
  });
  it('GitLab 子组', () => {
    const r = parseRemote('https://gitlab.com/a/b/c/repo.git');
    expect(r?.owner).toBe('a/b/c');
    expect(r?.repo).toBe('repo');
  });
  it('本地路径、file:// 与残缺地址返回 null', () => {
    expect(parseRemote('C:\\repos\\bare.git')).toBeNull();
    expect(parseRemote('C:/repos/bare.git')).toBeNull();
    expect(parseRemote('/srv/git/bare.git')).toBeNull();
    expect(parseRemote('../bare.git')).toBeNull();
    expect(parseRemote('file:///C:/repos/bare.git')).toBeNull();
    expect(parseRemote('https://github.com/only-owner')).toBeNull();
    expect(parseRemote('')).toBeNull();
  });
});

describe('compareUrl', () => {
  it('GitHub 类主机为 compare 页，分支里的斜杠保留', () => {
    const r = parseRemote('https://github.com/o/r.git')!;
    expect(remoteKind(r)).toBe('github');
    expect(compareUrl(r, 'main', 'nexus/1a2b3c4d')).toBe('https://github.com/o/r/compare/main...nexus/1a2b3c4d?expand=1');
  });
  it('主机名含 gitlab 为合并请求新建页', () => {
    const r = parseRemote('git@gitlab.com:g/sub/r.git')!;
    expect(compareUrl(r, 'main', 'feat/x')).toBe(
      'https://gitlab.com/g/sub/r/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fx&merge_request%5Btarget_branch%5D=main',
    );
  });
  it('其他主机不生成链接', () => {
    const r = parseRemote('https://bitbucket.org/o/r.git')!;
    expect(remoteKind(r)).toBe('other');
    expect(compareUrl(r, 'main', 'b')).toBeUndefined();
  });
  it('分支名里的特殊字符被编码，不会跑出路径', () => {
    const r = parseRemote('https://github.com/o/r.git')!;
    expect(compareUrl(r, 'main', 'a?b#c')).toBe('https://github.com/o/r/compare/main...a%3Fb%23c?expand=1');
  });
});

describe('ghCreateCommand', () => {
  it('标题与说明加引号转义', () => {
    expect(quoteArg('plain')).toBe('plain');
    expect(quoteArg('a "b"')).toBe('"a \\"b\\""');
    expect(ghCreateCommand('main', 'nexus/x', 'feat: 标题 "q"', '- a\n- b')).toBe(
      'gh pr create --base main --head nexus/x --title "feat: 标题 \\"q\\"" --body "- a\n- b"',
    );
  });
});
