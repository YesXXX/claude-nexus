import * as fs from 'fs';
import { readJson, writeJsonAtomic } from './json-store';
import { log } from './logger';
import { DEFAULT_SKIN, isSkinId, type SkinId } from '../shared/skins';

/**
 * 外观偏好：<panelHome>/appearance.json，结构 { version: 1, skin }，原子写入。
 * 文件损坏或皮肤 id 不认识时改名为 appearance.json.bak-<时间> 留档，回退默认皮肤，面板照常可用。
 */

interface FileShape { version: 1; skin: SkinId }

export class AppearanceStore {
  private current: SkinId = DEFAULT_SKIN;

  constructor(readonly file: string) {}

  load(): void {
    this.current = DEFAULT_SKIN;
    if (!fs.existsSync(this.file)) return;
    const raw = readJson<unknown>(this.file, { tag: 'appearance' });
    const skin = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).skin : undefined;
    if (!isSkinId(skin)) {
      this.backupBroken();
      return;
    }
    this.current = skin;
  }

  private backupBroken(): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = `${this.file}.bak-${stamp}`;
    try {
      fs.renameSync(this.file, bak);
      log('appearance', `外观偏好文件损坏，已备份为 ${bak} 并回退默认皮肤`);
    } catch (err) {
      log('appearance', `外观偏好文件损坏且备份失败：${String(err)}`);
    }
  }

  skin(): SkinId {
    return this.current;
  }

  /** 校验并保存；id 不认识返回 false 且不落盘 */
  set(v: unknown): boolean {
    if (!isSkinId(v)) return false;
    this.current = v;
    const data: FileShape = { version: 1, skin: v };
    writeJsonAtomic(this.file, data, { tag: 'appearance' });
    return true;
  }
}
