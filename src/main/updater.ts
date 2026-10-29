import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { log } from './logger';
import {
  UpdateManifest, UpdatePublicKey, compareVersions, keyIdOf, sha256File, validateShape, verifySignature,
} from './update-manifest';
import type {
  UpdateCheckResult, UpdateConfig, UpdateInstallStart, UpdateProgress,
} from '../shared/update-status';

/**
 * 共享目录更新：
 * 读更新目录下的 latest.json → 结构校验 → 与当前版本比较 → Ed25519 验签（公钥内嵌在 update-pubkey.ts）→
 * 校验安装包实际大小 → 流式复制到本机私有随机目录（带进度与 sha256 校验）→ 启动前再算一次 sha256 →
 * detached 拉起安装器 → 走正常退出链路（before-quit 里终止托管会话）。
 *
 * 不直接依赖 electron：版本号、路径、推送、退出确认与退出动作都由调用方注入，便于单测。
 */

export type CheckReason = 'startup' | 'show' | 'manual';

export interface UpdaterOptions {
  currentVersion: string;
  /** 更新目录配置文件（JSON：{ dir }） */
  configFile: string;
  /** 安装包下载根目录，每次下载再建一个随机子目录 */
  downloadRoot: string;
  publicKeys: readonly UpdatePublicKey[];
  /** 是否允许自动检查（仅安装版）；手动检查不受限，便于开发态验证更新流程 */
  enabled: boolean;
  /** 推送事件到渲染层 */
  send: (channel: string, payload: unknown) => void;
  /** 安装前确认：仍有活跃会话时询问用户，返回 false 表示取消 */
  confirmInstall: () => boolean;
  /** 安装器拉起后退出应用（不再二次确认） */
  quit: () => void;
  spawnInstaller?: (file: string) => void;
  now?: () => number;
  /** 安装器拉起到退出之间的间隔，测试可调小 */
  quitDelayMs?: number;
}

/** 窗口重显触发的检查冷却，避免启动检查与首次 show 双重弹窗 */
export const SHOW_CHECK_COOLDOWN_MS = 30_000;

interface PendingUpdate {
  version: string;
  notes: string;
  fileName: string;
  filePath: string;
  size: number;
  sha256: string;
}

/**
 * 验签公钥列表：开发态允许通过环境变量指向的 PEM 文件追加一把测试公钥，安装版忽略
 */
export function resolvePublicKeys(
  embedded: readonly UpdatePublicKey[], allowTestKey: boolean, testKeyPath: string | undefined,
): UpdatePublicKey[] {
  const keys = [...embedded];
  if (allowTestKey && testKeyPath) {
    try {
      const pem = fs.readFileSync(testKeyPath, 'utf8');
      keys.push({ keyId: keyIdOf(crypto.createPublicKey(pem)), pem });
    } catch (err) {
      log('update', `测试公钥加载失败：${(err as Error).message}`);
    }
  }
  return keys;
}

/** 流式复制文件，过程中按 100ms 节流回调进度并增量计算 sha256 */
function copyWithHash(
  src: string, dest: string, onProgress: (p: UpdateProgress) => void,
): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const total = fs.statSync(src).size;
    let received = 0;
    let lastPushAt = 0;
    const rs = fs.createReadStream(src, { highWaterMark: 256 * 1024 });
    const ws = fs.createWriteStream(dest);
    rs.on('data', chunk => {
      hash.update(chunk);
      received += chunk.length;
      const now = Date.now();
      if (now - lastPushAt >= 100 || received >= total) {
        lastPushAt = now;
        onProgress({ received, total, percent: total ? Math.floor((received / total) * 100) : 100 });
      }
    });
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', () => resolve({ sha256: hash.digest('hex'), size: received }));
    rs.pipe(ws);
  });
}

export class Updater {
  private readonly now: () => number;
  private readonly spawnInstaller: (file: string) => void;
  private inFlight = false;
  private installing = false;
  private lastShowCheckAt = -Infinity;
  /** 最近一次检查到的更新：安装只认它，渲染层无法传参指定安装任意文件 */
  private pending: PendingUpdate | null = null;

  constructor(private readonly opts: UpdaterOptions) {
    this.now = opts.now ?? Date.now;
    this.spawnInstaller = opts.spawnInstaller
      ?? (file => spawn(file, [], { detached: true, stdio: 'ignore' }).unref());
  }

  /** 清理上次遗留的安装包（安装器可能仍占用文件，失败不影响运行） */
  cleanStaleDownloads(): void {
    try { fs.rmSync(this.opts.downloadRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  getConfig(): UpdateConfig {
    return { dir: this.getUpdateDir(), currentVersion: this.opts.currentVersion };
  }

  /** 读取配置的更新目录；未配置或配置文件损坏返回 null */
  getUpdateDir(): string | null {
    try {
      const cfg = JSON.parse(fs.readFileSync(this.opts.configFile, 'utf8')) as { dir?: unknown };
      return typeof cfg.dir === 'string' && cfg.dir.trim() ? cfg.dir.trim() : null;
    } catch {
      return null;
    }
  }

  /** 保存更新目录：必须存在、是文件夹且可读，不合法抛错；成功返回规整后的路径 */
  setUpdateDir(dir: unknown): string {
    if (typeof dir !== 'string' || !dir.trim()) throw new Error('目录路径不能为空');
    const trimmed = dir.trim();
    let stat: fs.Stats;
    try { stat = fs.statSync(trimmed); } catch { throw new Error(`目录不存在或无法访问：${trimmed}`); }
    if (!stat.isDirectory()) throw new Error('路径不是文件夹');
    fs.accessSync(trimmed, fs.constants.R_OK);
    fs.mkdirSync(path.dirname(this.opts.configFile), { recursive: true });
    fs.writeFileSync(this.opts.configFile, JSON.stringify({ dir: trimmed }, null, 2), 'utf8');
    this.pending = null;   // 换了目录，旧检查结果作废
    return trimmed;
  }

  /**
   * 执行一次检查。目录未配置、不可达、无清单等环境问题不抛错，用 status 区分；
   * 只有发现新版本时才推送 update:available
   */
  async checkNow(reason: CheckReason): Promise<UpdateCheckResult> {
    const currentVersion = this.opts.currentVersion;
    if (!this.opts.enabled && reason !== 'manual') return { status: 'disabled', currentVersion };
    if (reason === 'show') {
      if (this.now() - this.lastShowCheckAt < SHOW_CHECK_COOLDOWN_MS) return { status: 'cooldown', currentVersion };
      this.lastShowCheckAt = this.now();
    }
    if (this.inFlight || this.installing) return { status: 'cooldown', currentVersion };
    this.inFlight = true;
    try {
      return this.check(currentVersion);
    } catch (err) {
      return { status: 'check-failed', currentVersion, error: (err as Error).message || '检查更新失败' };
    } finally {
      this.inFlight = false;
    }
  }

  private check(currentVersion: string): UpdateCheckResult {
    const dir = this.getUpdateDir();
    if (!dir) return { status: 'not-configured', currentVersion };

    const manifest = this.readManifest(dir);
    if (!manifest) return { status: 'no-manifest', currentVersion };

    // 不比当前新的清单不会被使用，无需验签（共享目录残留旧版清单时不反复报错）
    if (compareVersions(manifest.version, currentVersion) <= 0) return { status: 'up-to-date', currentVersion };

    if (!verifySignature(manifest, this.opts.publicKeys)) {
      log('update', `拒绝 v${manifest.version} 的更新清单：签名无效`);
      return { status: 'check-failed', currentVersion, error: '更新清单签名无效，已拒绝（请联系发布者）' };
    }

    // 文件名已由结构校验保证不含路径，安装包必须直接位于更新目录内
    const filePath = path.join(dir, manifest.file);
    let actualSize: number;
    try { actualSize = fs.statSync(filePath).size; } catch {
      return { status: 'check-failed', currentVersion, error: `更新目录中没有安装包 ${manifest.file}` };
    }
    if (actualSize !== manifest.size) {
      return { status: 'check-failed', currentVersion, error: '更新目录中的安装包与清单大小不一致' };
    }

    this.pending = {
      version: manifest.version,
      notes: manifest.notes ?? '',
      fileName: manifest.file,
      filePath,
      size: manifest.size,
      sha256: manifest.sha256,
    };
    log('update', `发现新版本 v${manifest.version}（当前 v${currentVersion}）`);
    this.opts.send('update:available', {
      version: manifest.version,
      currentVersion,
      notes: this.pending.notes,
      fileName: manifest.file,
      fileSize: manifest.size,
    });
    return { status: 'update-available', currentVersion, availableVersion: manifest.version };
  }

  /** 读取 latest.json；文件不存在、JSON 损坏或字段不合法都返回 null */
  private readManifest(dir: string): UpdateManifest | null {
    try {
      const m: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
      return validateShape(m) ? m : null;
    } catch {
      return null;
    }
  }

  /**
   * 开始安装上次检查到的更新：先同步做退出确认（有活跃会话时），确认后异步下载，
   * 进度、失败经 update:progress / update:error 推送
   */
  startInstall(): UpdateInstallStart {
    if (this.installing) return { started: true };
    if (!this.pending) return { started: false, error: '没有可安装的更新，请先检查更新' };
    if (!this.opts.confirmInstall()) return { started: false };
    this.installing = true;
    void this.downloadAndInstall(this.pending);
    return { started: true };
  }

  /**
   * 安装包复制到随机私有目录，大小与 sha256 必须与已验签的清单一致；
   * 拉起前再算一次 sha256，缩小「校验到使用」的时间窗口
   */
  private async downloadAndInstall(info: PendingUpdate): Promise<void> {
    const downloadDir = path.join(this.opts.downloadRoot, crypto.randomBytes(8).toString('hex'));
    const dest = path.join(downloadDir, info.fileName);
    const fail = (message: string): void => {
      try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      this.installing = false;
      log('update', `安装 v${info.version} 失败：${message}`);
      this.opts.send('update:error', { message });
    };
    try {
      fs.mkdirSync(downloadDir, { recursive: true });
      const result = await copyWithHash(info.filePath, dest, p => this.opts.send('update:progress', p));
      if (result.size !== info.size) { fail('安装包校验失败（大小不一致），已拒绝安装'); return; }
      if (result.sha256 !== info.sha256) { fail('安装包校验失败，已拒绝安装'); return; }
      if ((await sha256File(dest)) !== info.sha256) { fail('安装包校验失败，已拒绝安装'); return; }

      log('update', `安装包校验通过，拉起安装器并退出：${info.fileName}`);
      this.spawnInstaller(dest);
      setTimeout(() => this.opts.quit(), this.opts.quitDelayMs ?? 500);
    } catch (err) {
      fail((err as Error).message || '下载更新失败');
    }
  }
}
