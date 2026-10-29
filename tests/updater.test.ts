import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UpdateManifest, UpdatePublicKey, keyIdOf, signManifest } from '../src/main/update-manifest';
import { SHOW_CHECK_COOLDOWN_MS, Updater, UpdaterOptions, resolvePublicKeys } from '../src/main/updater';
import { UpdateCheckResult, describeCheckResult } from '../src/shared/update-status';

vi.spyOn(console, 'log').mockImplementation(() => undefined);

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const KEYS: UpdatePublicKey[] = [{ keyId: keyIdOf(publicKey), pem: PUBLIC_PEM }];

let tmp: string;
let shareDir: string;
let configFile: string;
let downloadRoot: string;
let sent: { channel: string; payload: unknown }[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-updater-'));
  shareDir = path.join(tmp, 'share');
  configFile = path.join(tmp, 'home', 'update-config.json');
  downloadRoot = path.join(tmp, 'updates');
  fs.mkdirSync(shareDir);
  sent = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeUpdater(over: Partial<UpdaterOptions> = {}): Updater {
  return new Updater({
    currentVersion: '0.2.0',
    configFile,
    downloadRoot,
    publicKeys: KEYS,
    enabled: true,
    send: (channel, payload) => sent.push({ channel, payload }),
    confirmInstall: () => true,
    quit: () => undefined,
    spawnInstaller: () => undefined,
    quitDelayMs: 0,
    ...over,
  });
}

/** 在共享目录放一个安装包并写入签名清单，返回安装包内容 */
function publish(version: string, opts: { sign?: boolean; patch?: Partial<UpdateManifest>; content?: Buffer } = {}): Buffer {
  const content = opts.content ?? crypto.randomBytes(600 * 1024);
  const file = `ClaudePanel-Setup-v${version}.exe`;
  fs.writeFileSync(path.join(shareDir, file), content);
  let m: UpdateManifest = {
    productName: 'Claude 会话面板',
    version,
    file,
    size: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    notes: '- 新功能',
    pubDate: new Date().toISOString(),
  };
  if (opts.sign !== false) m = signManifest(m, privateKey);
  fs.writeFileSync(path.join(shareDir, 'latest.json'), JSON.stringify({ ...m, ...opts.patch }));
  return content;
}

function configure(u: Updater): void {
  u.setUpdateDir(shareDir);
}

/** 等待 update:error 或 quit 等异步结果出现 */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise(r => setTimeout(r, 10));
  }
}

describe('更新目录配置', () => {
  it('未配置或配置文件损坏时为 null', () => {
    const u = makeUpdater();
    expect(u.getUpdateDir()).toBeNull();
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, '{坏');
    expect(u.getUpdateDir()).toBeNull();
  });

  it('保存合法目录（去首尾空白）后可读回，getConfig 带当前版本', () => {
    const u = makeUpdater();
    expect(u.setUpdateDir(`  ${shareDir}  `)).toBe(shareDir);
    expect(u.getConfig()).toEqual({ dir: shareDir, currentVersion: '0.2.0' });
  });

  it('空路径、不存在的路径、文件路径都拒绝且不写配置', () => {
    const u = makeUpdater();
    const file = path.join(tmp, 'a.txt');
    fs.writeFileSync(file, 'x');
    expect(() => u.setUpdateDir('  ')).toThrow('目录路径不能为空');
    expect(() => u.setUpdateDir(42)).toThrow('目录路径不能为空');
    expect(() => u.setUpdateDir(path.join(tmp, 'nope'))).toThrow('目录不存在');
    expect(() => u.setUpdateDir(file)).toThrow('路径不是文件夹');
    expect(fs.existsSync(configFile)).toBe(false);
  });
});

describe('checkNow', () => {
  it('未启用时自动检查返回 disabled，手动检查不受限', async () => {
    const u = makeUpdater({ enabled: false });
    expect((await u.checkNow('startup')).status).toBe('disabled');
    expect((await u.checkNow('show')).status).toBe('disabled');
    expect((await u.checkNow('manual')).status).toBe('not-configured');
  });

  it('目录无清单或清单损坏返回 no-manifest', async () => {
    const u = makeUpdater();
    configure(u);
    expect((await u.checkNow('manual')).status).toBe('no-manifest');
    fs.writeFileSync(path.join(shareDir, 'latest.json'), '{"version":"9.9.9"}');
    expect((await u.checkNow('manual')).status).toBe('no-manifest');
  });

  it('清单不比当前新时返回 up-to-date，且不要求签名', async () => {
    const u = makeUpdater();
    configure(u);
    publish('0.2.0', { sign: false });
    expect((await u.checkNow('manual')).status).toBe('up-to-date');
    publish('0.1.0', { sign: false });
    expect((await u.checkNow('manual')).status).toBe('up-to-date');
    expect(sent).toEqual([]);
  });

  it('发现新版本：推送 update:available 并返回版本号', async () => {
    const u = makeUpdater();
    configure(u);
    const content = publish('0.3.0');
    const r = await u.checkNow('startup');
    expect(r).toEqual({ status: 'update-available', currentVersion: '0.2.0', availableVersion: '0.3.0' });
    expect(sent).toEqual([{
      channel: 'update:available',
      payload: {
        version: '0.3.0', currentVersion: '0.2.0', notes: '- 新功能',
        fileName: 'ClaudePanel-Setup-v0.3.0.exe', fileSize: content.length,
      },
    }]);
  });

  it('新版本未签名、签名被篡改或公钥不认识都拒绝', async () => {
    const u = makeUpdater();
    configure(u);
    publish('0.3.0', { sign: false });
    let r = await u.checkNow('manual');
    expect(r.status).toBe('check-failed');
    expect(r.error).toContain('签名无效');

    publish('0.3.0', { patch: { notes: '- 被篡改的说明' } });
    expect((await u.checkNow('manual')).status).toBe('check-failed');

    publish('0.3.0');
    r = await makeUpdater({ publicKeys: [] }).checkNow('manual');
    expect(r.status).toBe('check-failed');
    expect(sent).toEqual([]);
  });

  it('安装包缺失或大小与清单不一致返回 check-failed', async () => {
    const u = makeUpdater();
    configure(u);
    publish('0.3.0');
    fs.writeFileSync(path.join(shareDir, 'ClaudePanel-Setup-v0.3.0.exe'), 'short');
    let r = await u.checkNow('manual');
    expect(r.status).toBe('check-failed');
    expect(r.error).toContain('大小不一致');

    fs.rmSync(path.join(shareDir, 'ClaudePanel-Setup-v0.3.0.exe'));
    r = await u.checkNow('manual');
    expect(r.status).toBe('check-failed');
    expect(r.error).toContain('没有安装包');
  });

  it('窗口重显触发的检查有冷却，手动与启动检查不受冷却影响', async () => {
    let now = 1_000_000;
    const u = makeUpdater({ now: () => now });
    configure(u);
    expect((await u.checkNow('show')).status).toBe('no-manifest');
    expect((await u.checkNow('show')).status).toBe('cooldown');
    expect((await u.checkNow('manual')).status).toBe('no-manifest');
    expect((await u.checkNow('startup')).status).toBe('no-manifest');
    now += SHOW_CHECK_COOLDOWN_MS;
    expect((await u.checkNow('show')).status).toBe('no-manifest');
  });
});

describe('startInstall', () => {
  it('没有检查到的更新时不安装', () => {
    const r = makeUpdater().startInstall();
    expect(r.started).toBe(false);
    expect(r.error).toContain('没有可安装的更新');
  });

  it('用户在确认框取消时不下载', async () => {
    const spawnInstaller = vi.fn();
    const u = makeUpdater({ confirmInstall: () => false, spawnInstaller });
    configure(u);
    publish('0.3.0');
    await u.checkNow('manual');
    expect(u.startInstall()).toEqual({ started: false });
    expect(fs.existsSync(downloadRoot)).toBe(false);
    expect(spawnInstaller).not.toHaveBeenCalled();
  });

  it('切换更新目录后旧检查结果作废', async () => {
    const u = makeUpdater();
    configure(u);
    publish('0.3.0');
    await u.checkNow('manual');
    configure(u);
    expect(u.startInstall().started).toBe(false);
  });

  it('校验通过：复制到下载目录、推送进度、拉起安装器后退出', async () => {
    const spawned: string[] = [];
    let quitCalls = 0;
    const u = makeUpdater({ spawnInstaller: f => spawned.push(f), quit: () => { quitCalls++; } });
    configure(u);
    const content = publish('0.3.0', { content: crypto.randomBytes(2 * 1024 * 1024 + 3) });
    await u.checkNow('manual');

    expect(u.startInstall()).toEqual({ started: true });
    expect(u.startInstall()).toEqual({ started: true });   // 重复点击不重复下载
    await waitFor(() => quitCalls > 0);

    expect(spawned).toHaveLength(1);
    expect(path.dirname(path.dirname(spawned[0]))).toBe(downloadRoot);
    expect(path.basename(spawned[0])).toBe('ClaudePanel-Setup-v0.3.0.exe');
    expect(fs.readFileSync(spawned[0]).equals(content)).toBe(true);

    const progress = sent.filter(s => s.channel === 'update:progress').map(s => s.payload as { percent: number; received: number; total: number });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toEqual({ received: content.length, total: content.length, percent: 100 });
    expect(sent.some(s => s.channel === 'update:error')).toBe(false);
    expect(quitCalls).toBe(1);
  });

  it('检查后安装包被替换（大小相同内容不同）时拒绝安装并清理下载目录', async () => {
    const spawnInstaller = vi.fn();
    const quit = vi.fn();
    const u = makeUpdater({ spawnInstaller, quit });
    configure(u);
    const content = publish('0.3.0');
    await u.checkNow('manual');
    fs.writeFileSync(path.join(shareDir, 'ClaudePanel-Setup-v0.3.0.exe'), crypto.randomBytes(content.length));

    expect(u.startInstall()).toEqual({ started: true });
    await waitFor(() => sent.some(s => s.channel === 'update:error'));

    expect(sent.find(s => s.channel === 'update:error')!.payload).toEqual({ message: '安装包校验失败，已拒绝安装' });
    expect(spawnInstaller).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(fs.readdirSync(downloadRoot)).toEqual([]);
    // 失败后可再次发起安装
    expect(u.startInstall()).toEqual({ started: true });
    await waitFor(() => sent.filter(s => s.channel === 'update:error').length === 2);
  });

  it('cleanStaleDownloads 清掉遗留安装包', () => {
    fs.mkdirSync(path.join(downloadRoot, 'old'), { recursive: true });
    fs.writeFileSync(path.join(downloadRoot, 'old', 'x.exe'), 'x');
    makeUpdater().cleanStaleDownloads();
    expect(fs.existsSync(downloadRoot)).toBe(false);
  });
});

describe('resolvePublicKeys', () => {
  it('仅在允许时追加测试公钥，文件不可读时忽略', () => {
    const other = crypto.generateKeyPairSync('ed25519').publicKey;
    const pemPath = path.join(tmp, 'test.pub.pem');
    fs.writeFileSync(pemPath, other.export({ type: 'spki', format: 'pem' }).toString());

    expect(resolvePublicKeys(KEYS, false, pemPath)).toEqual(KEYS);
    expect(resolvePublicKeys(KEYS, true, undefined)).toEqual(KEYS);
    expect(resolvePublicKeys(KEYS, true, path.join(tmp, 'missing.pem'))).toEqual(KEYS);

    const keys = resolvePublicKeys(KEYS, true, pemPath);
    expect(keys).toHaveLength(2);
    expect(keys[1].keyId).toBe(keyIdOf(other));
  });
});

describe('describeCheckResult', () => {
  it('每种状态都有中文说明，失败时带具体原因', () => {
    const statuses: UpdateCheckResult['status'][] = [
      'disabled', 'cooldown', 'not-configured', 'no-manifest', 'up-to-date', 'check-failed', 'update-available',
    ];
    for (const status of statuses) {
      expect(describeCheckResult({ status, currentVersion: '0.2.0', availableVersion: '0.3.0' })).toBeTruthy();
    }
    expect(describeCheckResult({ status: 'check-failed', currentVersion: '0.2.0', error: '签名无效' })).toContain('签名无效');
  });
});
