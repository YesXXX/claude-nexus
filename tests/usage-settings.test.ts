import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Session } from '../src/shared/types';
import { UsageTracker } from '../src/main/usage-tracker';
import { UsageStore } from '../src/main/usage-store';
import { flagged1mFromClaudeSettings, usageEnabled } from '../src/main/usage-wiring';
import { defaultUsageSettings } from '../src/shared/usage-format';

let tmp: string;
let root: string;
let usageDir: string;
let sessions: Map<string, Session>;
const T0 = new Date(2026, 9, 17, 10).getTime();

function makeTracker(): UsageTracker {
  return new UsageTracker({
    dir: usageDir,
    root: () => root,
    getSession: id => sessions.get(id),
    listSessions: () => [...sessions.values()],
    now: () => T0,
    debounceMs: 60_000,
  });
}

function line(id: string, model: string, input: number): string {
  return JSON.stringify({
    type: 'assistant', timestamp: new Date(T0).toISOString(),
    message: { id, model, usage: { input_tokens: input, output_tokens: 1 } },
  }) + '\n';
}

let trackers: UsageTracker[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-settings-'));
  root = path.join(tmp, 'projects');
  fs.mkdirSync(path.join(root, 'p'), { recursive: true });
  usageDir = path.join(tmp, 'usage');
  sessions = new Map();
  trackers = [];
});

afterEach(() => {
  for (const t of trackers) t.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('上下文设置', () => {
  it('缺失时为默认值；保存后重启读回', () => {
    const t = makeTracker();
    trackers.push(t);
    expect(t.getSettings()).toEqual(defaultUsageSettings());
    const s = t.getSettings();
    s.contextWarnPct = 60;
    s.windows['glm-'] = 128_000;
    expect(t.setSettings(s)).toEqual({ ok: true });
    const again = makeTracker();
    trackers.push(again);
    expect(again.getSettings()).toEqual({ ...defaultUsageSettings(), contextWarnPct: 60, windows: { 'glm-': 128_000 } });
  });

  it('不合法的设置返回错误且不写盘', () => {
    const t = makeTracker();
    trackers.push(t);
    const s = { ...defaultUsageSettings(), contextWarnPct: 96, contextDangerPct: 90 };
    const r = t.setSettings(s);
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(usageDir, 'settings.json'))).toBe(false);
    expect(t.setSettings({ ...defaultUsageSettings(), windows: { x: 10 } }).ok).toBe(false);
    expect(t.setSettings('nope').ok).toBe(false);
    expect(t.getSettings()).toEqual(defaultUsageSettings());
  });

  it('设置文件损坏时使用默认值，不覆盖原文件', () => {
    fs.mkdirSync(usageDir, { recursive: true });
    const f = path.join(usageDir, 'settings.json');
    fs.writeFileSync(f, '{"contextWarnPct": "abc"');
    const store = new UsageStore(usageDir);
    expect(store.loadSettings()).toEqual(defaultUsageSettings());
    expect(fs.readFileSync(f, 'utf8')).toBe('{"contextWarnPct": "abc"');
  });

  it('旧版设置文件（含每日预算与单价覆盖）照常读取上下文相关字段', () => {
    fs.mkdirSync(usageDir, { recursive: true });
    fs.writeFileSync(path.join(usageDir, 'settings.json'), JSON.stringify({
      dailyBudgetUsd: 10, budgetAlertPcts: [80, 100], contextWarnPct: 70, contextDangerPct: 90,
      prices: { 'glm-*': { input: 1, output: 3 } }, windows: { 'glm-*': 128_000 },
    }));
    expect(new UsageStore(usageDir).loadSettings()).toEqual({ contextWarnPct: 70, contextDangerPct: 90, windows: { 'glm-*': 128_000 } });
  });

  it('窗口覆盖生效后上下文立即按新窗口重算', async () => {
    sessions.set('s1', {
      id: 's1', label: 'a', cwd: 'D:\\w', status: 'running', statusSince: T0, createdAt: T0 - 1000, escalated: false,
    });
    const f = path.join(root, 'p', 'c.jsonl');
    fs.writeFileSync(f, line('m1', 'mimo-v2', 100_000));
    const t = makeTracker();
    trackers.push(t);
    t.onHookMessage({ sessionId: 's1', event: { type: 'turn_completed' }, transcriptPath: f });
    await new Promise(r => setTimeout(r, 20));
    await t.whenIdle();
    expect(t.getSummary('s1')?.context).toMatchObject({ used: 100_000, window: 200_000, pct: 50, windowSource: 'default' });
    const s = t.getSettings();
    s.windows['mimo-*'] = 400_000;
    expect(t.setSettings(s)).toEqual({ ok: true });
    expect(t.getSummary('s1')?.context).toMatchObject({ window: 400_000, pct: 25, windowSource: 'setting' });
  });
});

describe('上下文统计装配', () => {
  it('CLAUDE_PANEL_USAGE=0 关闭统计', () => {
    expect(usageEnabled({})).toBe(true);
    expect(usageEnabled({ CLAUDE_PANEL_USAGE: '1' })).toBe(true);
    expect(usageEnabled({ CLAUDE_PANEL_USAGE: '0' })).toBe(false);
  });

  it('mock 模式或指定 transcript 根时不读 claude 设置', () => {
    const cfg = path.join(tmp, 'cfg');
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'claude-sonnet-5[1m]' } }));
    expect(flagged1mFromClaudeSettings({ CLAUDE_CONFIG_DIR: cfg, CLAUDE_PANEL_MOCK_CLAUDE: '1' })).toEqual([]);
    expect(flagged1mFromClaudeSettings({ CLAUDE_CONFIG_DIR: cfg, CLAUDE_PANEL_TRANSCRIPT_ROOT: root })).toEqual([]);
  });
});
