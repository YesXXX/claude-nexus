import type { ResumeSettings } from '../shared/types';
import { readJson, writeJsonAtomic } from './json-store';

/** 续接设置缺省值：启动时询问、退出时询问、历史 300 条 / 90 天 */
export const DEFAULT_RESUME_SETTINGS: ResumeSettings = {
  onStartup: 'ask',
  onQuit: 'ask',
  historyMaxCount: 300,
  historyMaxDays: 90,
};

const STARTUP_VALUES: readonly ResumeSettings['onStartup'][] = ['auto', 'ask', 'never'];
const QUIT_VALUES: readonly ResumeSettings['onQuit'][] = ['ask', 'keep', 'end'];
const COUNT_RANGE: [number, number] = [20, 5000];
const DAYS_RANGE: [number, number] = [1, 3650];

function inRange(v: unknown, [min, max]: [number, number]): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/**
 * 把改动合并进当前设置：枚举值不认识、数值不是整数或超出范围的字段直接忽略，其余照写。
 * 返回新对象，不修改入参。
 */
export function mergeResumeSettings(base: ResumeSettings, patch: unknown): ResumeSettings {
  const next = { ...base };
  if (typeof patch !== 'object' || patch === null) return next;
  const p = patch as Record<string, unknown>;
  if (STARTUP_VALUES.includes(p.onStartup as ResumeSettings['onStartup'])) next.onStartup = p.onStartup as ResumeSettings['onStartup'];
  if (QUIT_VALUES.includes(p.onQuit as ResumeSettings['onQuit'])) next.onQuit = p.onQuit as ResumeSettings['onQuit'];
  if (inRange(p.historyMaxCount, COUNT_RANGE)) next.historyMaxCount = p.historyMaxCount;
  if (inRange(p.historyMaxDays, DAYS_RANGE)) next.historyMaxDays = p.historyMaxDays;
  return next;
}

/** `<panelHome>/resume-settings.json` 的读写：文件缺失或损坏时用缺省值兜底，单个字段非法只回退该字段 */
export class ResumeSettingsStore {
  private value: ResumeSettings;

  constructor(private readonly file: string) {
    this.value = mergeResumeSettings(DEFAULT_RESUME_SETTINGS, readJson(file, { tag: 'settings' }));
  }

  get(): ResumeSettings {
    return { ...this.value };
  }

  /** 合并合法字段并落盘，返回合并后的设置；没有变化时不写盘 */
  set(patch: unknown): ResumeSettings {
    const next = mergeResumeSettings(this.value, patch);
    const changed = (Object.keys(next) as (keyof ResumeSettings)[]).some(k => next[k] !== this.value[k]);
    if (changed) {
      this.value = next;
      writeJsonAtomic(this.file, next, { tag: 'settings' });
    }
    return this.get();
  }
}
