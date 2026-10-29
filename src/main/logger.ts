import * as fs from 'fs';
import * as path from 'path';

/** 调试日志：stdout + 文件双写。
 *  文件流懒初始化（由 main/index.ts 显式调用 initFileLogging），
 *  单元测试不调用它，因此不会在测试环境写文件。 */
let stream: fs.WriteStream | null = null;

export function initFileLogging(logsDir: string): string {
  fs.mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, `panel-${new Date().toISOString().slice(0, 10)}.log`);
  stream = fs.createWriteStream(file, { flags: 'a' });
  return file;
}

export function log(tag: string, msg: string): void {
  const time = new Date().toISOString().slice(11, 23);  // HH:mm:ss.SSS
  const line = `[${time}] [${tag}] ${msg}`;
  console.log(line);
  stream?.write(line + '\n');
}
