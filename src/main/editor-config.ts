import * as fs from 'fs';
import { readJson, writeJsonAtomic } from './json-store';
import { log } from './logger';
import { EDITOR_COMMAND_MAX, tokenizeEditorCommand } from './editor-launch';

/**
 * 外部编辑器命令配置：<panelHome>/editor.json，结构 { version: 1, command }，原子写入。
 * 保存时校验：切分得开（引号闭合）、含 {file} 占位符、长度与控制字符受限。
 * 文件损坏或结构不对时改名为 editor.json.bak-<时间> 留档，按未配置处理，面板照常可用。
 */

interface FileShape { version: 1; command: string }

/** 空串表示未配置（保持默认程序打开） */
export class EditorConfigStore {
  private cmd = '';

  constructor(readonly file: string) {}

  load(): void {
    this.cmd = '';
    if (!fs.existsSync(this.file)) return;
    const raw = readJson<unknown>(this.file, { tag: 'editor' });
    const cmd = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).command : undefined;
    if (typeof cmd !== 'string') {
      this.backupBroken();
      return;
    }
    this.cmd = cmd;
  }

  private backupBroken(): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = `${this.file}.bak-${stamp}`;
    try {
      fs.renameSync(this.file, bak);
      log('editor', `编辑器配置文件损坏，已备份为 ${bak} 并按未配置处理`);
    } catch (err) {
      log('editor', `编辑器配置文件损坏且备份失败：${String(err)}`);
    }
  }

  /** 当前配置的命令；空串为未配置 */
  command(): string {
    return this.cmd;
  }

  /**
   * 校验并保存：空串清除配置；返回错误文本，成功为空串。
   * 清除配置不做占位符校验（用户只是想恢复默认打开方式）。
   */
  set(v: unknown): string {
    if (typeof v !== 'string') return '参数无效';
    const cmd = v.trim().replace(/\r\n?|\n/g, ' ');
    if (cmd.length > EDITOR_COMMAND_MAX) return `命令过长（上限 ${EDITOR_COMMAND_MAX} 字）`;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(cmd)) return '命令里不能有控制字符';
    if (cmd) {
      const t = tokenizeEditorCommand(cmd);
      if (!t.ok) return t.error;
      if (!t.argv.some(a => a.includes('{file}'))) return '命令里需要 {file} 占位符（如 code -g {file}:{line}）';
    }
    this.cmd = cmd;
    const data: FileShape = { version: 1, command: cmd };
    writeJsonAtomic(this.file, data, { tag: 'editor' });
    return '';
  }
}
