import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseHelp, probeCapabilities, currentCaps, setCurrentCaps, CONSERVATIVE_CAPS, MOCK_CAPS,
} from '../src/main/cli-capabilities';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-caps-'));
process.env.CLAUDE_PANEL_HOME = TMP;

/** 2.1.278 帮助文本节选（参数名与真实输出一致） */
const HELP_NEW = `Usage: claude [options] [command] [prompt]

Options:
  -d, --debug [filter]              Enable debug mode
  -c, --continue                    Continue the most recent conversation in the current directory
  -r, --resume [value]              Resume a conversation by session ID, or open interactive picker
  --fork-session                    When resuming, create a new session ID instead of reusing the original
  --model <model>                   Model for the current session
  -n, --name <name>                 Name for this session
  --permission-mode <mode>          Permission mode to use for the session
  --session-id <uuid>               Use a specific session ID for the conversation (must be a valid UUID)
  --settings <file-or-json>         Path to a settings JSON file
`;

/** 旧版样本：去掉 --session-id / --fork-session / --name */
const HELP_OLD = `Usage: claude [options]
  -c, --continue                    Continue the most recent conversation
  -r, --resume [sessionId]          Resume a conversation
  --model <model>                   Model for the current session
  --settings <file-or-json>         Path to a settings JSON file
`;

afterEach(() => setCurrentCaps(null));

describe('parseHelp', () => {
  it('新版帮助：全部支持', () => {
    expect(parseHelp(HELP_NEW)).toEqual({ resume: true, sessionId: true, forkSession: true, name: true });
  });
  it('旧版帮助：只支持 --resume', () => {
    expect(parseHelp(HELP_OLD)).toEqual({ resume: true, sessionId: false, forkSession: false, name: false });
  });
  it('--name 必须是 -n, --name 形式（不被 --model-name 之类误判）', () => {
    expect(parseHelp('  --model-name <x>\n  --names').name).toBe(false);
  });
});

describe('probeCapabilities', () => {
  it('版本未变时直接用缓存，不跑 --help', async () => {
    const cacheFile = path.join(TMP, 'c1.json');
    const calls: string[] = [];
    const run = async (args: string[]): Promise<string> => {
      calls.push(args[0]);
      return args[0] === '--version' ? '2.1.278 (Claude Code)\n' : HELP_NEW;
    };
    const first = await probeCapabilities({ run, cacheFile, now: () => 7 });
    expect(first).toEqual({ version: '2.1.278 (Claude Code)', resume: true, sessionId: true, forkSession: true, name: true, probedAt: 7 });
    expect(calls).toEqual(['--version', '--help']);
    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).version).toBe('2.1.278 (Claude Code)');

    calls.length = 0;
    const second = await probeCapabilities({ run, cacheFile, now: () => 8 });
    expect(second.probedAt).toBe(7);
    expect(calls).toEqual(['--version']);
  });

  it('版本变化时重新解析帮助', async () => {
    const cacheFile = path.join(TMP, 'c2.json');
    fs.writeFileSync(cacheFile, JSON.stringify({ ...MOCK_CAPS, version: '2.1.278' }));
    const run = async (args: string[]): Promise<string> => (args[0] === '--version' ? '1.0.0' : HELP_OLD);
    const caps = await probeCapabilities({ run, cacheFile, now: () => 1 });
    expect(caps).toMatchObject({ version: '1.0.0', sessionId: false, forkSession: false, name: false });
  });

  it('探测失败回落保守能力，并成为 currentCaps', async () => {
    const cacheFile = path.join(TMP, 'c3.json');
    const caps = await probeCapabilities({ run: async () => { throw new Error('ENOENT'); }, cacheFile });
    expect(caps).toEqual(CONSERVATIVE_CAPS);
    expect(currentCaps({})).toEqual(CONSERVATIVE_CAPS);

    const helpFails = await probeCapabilities({
      run: async args => { if (args[0] === '--help') throw new Error('timeout'); return '2.0.0'; }, cacheFile,
    });
    expect(helpFails).toMatchObject({ version: '2.0.0', resume: true, sessionId: false });
  });

  it('mock 模式能力全开；未探测时为保守值', () => {
    expect(currentCaps({ CLAUDE_PANEL_MOCK_CLAUDE: '1' })).toBe(MOCK_CAPS);
    expect(currentCaps({})).toBe(CONSERVATIVE_CAPS);
  });
});
