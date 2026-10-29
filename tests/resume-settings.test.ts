import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DEFAULT_RESUME_SETTINGS, mergeResumeSettings, ResumeSettingsStore } from '../src/main/resume-settings';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-rs-')), 'resume-settings.json');
}

describe('mergeResumeSettings', () => {
  it('合法字段照写，不修改入参', () => {
    const base = { ...DEFAULT_RESUME_SETTINGS };
    const next = mergeResumeSettings(base, { onStartup: 'auto', onQuit: 'keep', historyMaxCount: 20, historyMaxDays: 3650 });
    expect(next).toEqual({ onStartup: 'auto', onQuit: 'keep', historyMaxCount: 20, historyMaxDays: 3650 });
    expect(base).toEqual(DEFAULT_RESUME_SETTINGS);
  });

  it('非法枚举、非整数与越界数值各自忽略，其余字段不受影响', () => {
    const next = mergeResumeSettings(DEFAULT_RESUME_SETTINGS, {
      onStartup: 'sometimes', onQuit: 'end', historyMaxCount: 19, historyMaxDays: 1.5,
    });
    expect(next).toEqual({ ...DEFAULT_RESUME_SETTINGS, onQuit: 'end' });
    expect(mergeResumeSettings(DEFAULT_RESUME_SETTINGS, { historyMaxCount: 5001, historyMaxDays: 0 })).toEqual(DEFAULT_RESUME_SETTINGS);
    expect(mergeResumeSettings(DEFAULT_RESUME_SETTINGS, { historyMaxCount: '300' })).toEqual(DEFAULT_RESUME_SETTINGS);
  });

  it('非对象补丁返回原设置的副本', () => {
    expect(mergeResumeSettings(DEFAULT_RESUME_SETTINGS, null)).toEqual(DEFAULT_RESUME_SETTINGS);
    expect(mergeResumeSettings(DEFAULT_RESUME_SETTINGS, 'x')).toEqual(DEFAULT_RESUME_SETTINGS);
  });
});

describe('ResumeSettingsStore', () => {
  it('文件缺失时为缺省值：询问 / 询问 / 300 条 / 90 天', () => {
    const store = new ResumeSettingsStore(tmpFile());
    expect(store.get()).toEqual({ onStartup: 'ask', onQuit: 'ask', historyMaxCount: 300, historyMaxDays: 90 });
  });

  it('写入后重新加载仍在；get 返回副本', () => {
    const file = tmpFile();
    const store = new ResumeSettingsStore(file);
    store.set({ onQuit: 'keep' });
    const got = store.get();
    got.onQuit = 'end';
    expect(store.get().onQuit).toBe('keep');
    expect(new ResumeSettingsStore(file).get()).toMatchObject({ onQuit: 'keep', onStartup: 'ask' });
  });

  it('没有变化不写盘', () => {
    const file = tmpFile();
    const store = new ResumeSettingsStore(file);
    store.set({ onStartup: 'ask', bogus: 1 });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('文件损坏或字段非法时按字段回退缺省值', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{坏');
    expect(new ResumeSettingsStore(file).get()).toEqual(DEFAULT_RESUME_SETTINGS);
    fs.writeFileSync(file, JSON.stringify({ onStartup: 'never', onQuit: 'later', historyMaxDays: -1 }));
    expect(new ResumeSettingsStore(file).get()).toEqual({ ...DEFAULT_RESUME_SETTINGS, onStartup: 'never' });
  });
});
