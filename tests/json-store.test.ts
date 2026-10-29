import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readJson, writeJsonAtomic } from '../src/main/json-store';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-json-'));
process.env.CLAUDE_PANEL_HOME = TMP;

describe('json-store', () => {
  it('原子写：自动建目录、写完不留 .tmp，读回一致', () => {
    const file = path.join(TMP, 'a', 'b', 'x.json');
    expect(writeJsonAtomic(file, { a: 1, s: '中文' })).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(readJson(file)).toEqual({ a: 1, s: '中文' });
    expect(fs.readFileSync(file, 'utf8')).toContain('\n  "a": 1');
  });

  it('indent=0 输出紧凑单行；覆盖已有文件', () => {
    const file = path.join(TMP, 'compact.json');
    writeJsonAtomic(file, { v: 1 });
    writeJsonAtomic(file, { v: 2 }, { indent: 0 });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"v":2}');
  });

  it('不存在、损坏都返回 null', () => {
    expect(readJson(path.join(TMP, 'missing.json'))).toBeNull();
    const bad = path.join(TMP, 'bad.json');
    fs.writeFileSync(bad, '{坏');
    expect(readJson(bad)).toBeNull();
  });

  it('目标是目录时写入失败返回 false 且不留 .tmp', () => {
    const dir = path.join(TMP, 'is-dir.json');
    fs.mkdirSync(dir);
    expect(writeJsonAtomic(dir, { x: 1 })).toBe(false);
    expect(fs.existsSync(`${dir}.tmp`)).toBe(false);
  });
});
