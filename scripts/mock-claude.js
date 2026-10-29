#!/usr/bin/env node
/**
 * 假 claude：模拟真实 CLI 的启动参数、对话记录与 hook 上报，供开发态与 e2e 使用。
 *
 * 参数：--settings（忽略）、--session-id <id>、--resume <id>、--fork-session、--name、--model、--permission-mode。
 * 环境变量：
 *   CLAUDE_PANEL_TRANSCRIPT_ROOT    对话记录根目录（CLAUDE_PANEL_MOCK_PROJECTS 为旧名），
 *                                   缺省 <panelHome>/mock-claude/projects
 *   CLAUDE_PANEL_MOCK_NO_TRANSCRIPT=1  不写对话记录
 *   CLAUDE_PANEL_MOCK_RESUME_FAIL=1    续接一律按找不到对话失败
 *   CLAUDE_PANEL_MOCK_MODEL            用量记录里的模型，缺省 claude-opus-5
 *   CLAUDE_PANEL_MOCK_INPUT_LOG        设置时把每次读到的原始 stdin 追加为一行 {"t":毫秒,"data":"原样字符串"}
 *   CLAUDE_PANEL_MOCK_TRUST=1          启动先显示目录信任确认，回车或 1 继续、2 退出；确认前不上报任何 hook
 *   CLAUDE_PANEL_MOCK_NO_PERMISSION=1  回合内不请求权限，直接执行到 Stop
 *   CLAUDE_PANEL_MOCK_EDIT             相对工作目录的文件名：每轮把任务首行追加进去
 *   CLAUDE_PANEL_MOCK_TURN_MS          回合内执行工具的耗时，缺省 500 毫秒
 *
 * 启动上报 SessionStart 后输出 ESC[?2004h（粘贴模式开启）。终端下以原始模式读输入：
 * 粘贴开始与结束标记之间的多行算一条任务（回显「收到任务（N 行）」），回车单独提交。
 * 每条任务走一轮：UserPromptSubmit → PreToolUse → 权限通知 → 等 y/a/n → PostToolUse → Stop；输入 /exit 以退出码 0 退出。
 *
 * 显式设置了 CLAUDE_PANEL_TRANSCRIPT_ROOT 时，每轮还写带用量的 assistant 记录（同一 message.id 三行，
 * output 依次 1、800、2000，最后一行 input 1000、缓存写 20000、缓存读 100000），便于手算断言。
 * 任务文本含 big 时缓存读改为 829000（上下文约为 1M 窗口的 85%）；含 unknown 时模型改为 mock-unknown-1；
 * 含 sub 时额外写 subagents/agent-mock1.jsonl 并上报 SubagentStart / SubagentStop；含 compact 时先写一条压缩边界。
 * 任务行是文件操作指令（write / edit / rm / sh，见 parseFileOps）时按指令逐个上报工具调用并真实改文件。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

let postEvent = async () => {};
try {
  ({ postEvent } = require('./hook-client'));
} catch {
  // 单独运行时没有 hook-client 也能用，上报静默丢弃
}

/** 解析命令行参数；未知参数忽略 */
function parseArgs(argv) {
  const out = { sessionId: '', resumeId: '', fork: false, name: '', model: '', permissionMode: '' };
  const takesValue = { '--session-id': 'sessionId', '--resume': 'resumeId', '--name': 'name', '--model': 'model', '--permission-mode': 'permissionMode', '--settings': '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fork-session') { out.fork = true; continue; }
    if (Object.prototype.hasOwnProperty.call(takesValue, a)) {
      const key = takesValue[a];
      const v = argv[i + 1] ?? '';
      i++;
      if (key) out[key] = v;
    }
  }
  return out;
}

function panelHome() {
  return process.env.CLAUDE_PANEL_HOME || path.join(os.homedir(), '.claude-session-panel');
}

function transcriptRoot() {
  return process.env.CLAUDE_PANEL_TRANSCRIPT_ROOT
    || process.env.CLAUDE_PANEL_MOCK_PROJECTS
    || path.join(panelHome(), 'mock-claude', 'projects');
}

/** 与真实 CLI 一致：cwd 中的非字母数字字符替换为 - */
function projectDirName(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function transcriptPathOf(id) {
  return path.join(transcriptRoot(), projectDirName(process.cwd()), `${id}.jsonl`);
}

/** 对话记录中用户消息的条数（用量记录不算历史）；文件不存在或为空返回 -1 */
function countLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text) return -1;
    return text.split('\n').filter(l => l.includes('"type":"user"')).length;
  } catch {
    return -1;
  }
}

/** 一轮的用量数字：最后一行的完整用量，前两行只是 output 不同 */
function turnUsage(task) {
  return {
    model: /unknown/i.test(task) ? 'mock-unknown-1' : (process.env.CLAUDE_PANEL_MOCK_MODEL || 'claude-opus-5'),
    input: 1000,
    cacheWrite: 20000,
    cacheRead: /big/i.test(task) ? 829000 : 100000,
  };
}

function assistantLine(sessionId, msgId, u, output, sidechain) {
  return JSON.stringify({
    type: 'assistant',
    uuid: crypto.randomUUID(),
    sessionId,
    isSidechain: sidechain,
    timestamp: new Date().toISOString(),
    message: {
      id: msgId, type: 'message', role: 'assistant', model: u.model,
      content: [{ type: 'text', text: sidechain ? '子代理完成' : '处理中' }],
      usage: {
        input_tokens: u.input,
        cache_creation_input_tokens: u.cacheWrite,
        cache_read_input_tokens: u.cacheRead,
        output_tokens: output,
        cache_creation: { ephemeral_5m_input_tokens: u.cacheWrite, ephemeral_1h_input_tokens: 0 },
      },
    },
  });
}

function compactLine(sessionId) {
  return JSON.stringify({
    type: 'system', subtype: 'compact_boundary', uuid: crypto.randomUUID(), sessionId,
    timestamp: new Date().toISOString(), content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens: 121000, postTokens: 30000 },
  });
}

/** 子代理记录：与真实 CLI 一致放在主记录同名目录的 subagents 下 */
function agentPathOf(transcript, agentId) {
  return path.join(transcript.slice(0, -'.jsonl'.length), 'subagents', `agent-${agentId}.jsonl`);
}

/** 打印后以给定退出码结束，等 stdout 刷完再退出 */
function exitWith(message, code) {
  process.stdout.write(`${message}\n`, () => process.exit(code));
}

/** 按行排队读取输入，每次取一条提交（单行输入或一整段粘贴） */
function lineQueue() {
  const buffered = [];
  const waiters = [];
  const submit = line => {
    const w = waiters.shift();
    if (w) w(line);
    else buffered.push(line);
  };
  const tty = !!process.stdin.isTTY;
  // 终端下用原始模式：ConPTY 只在原始模式下原样透传粘贴标记，也不会把回车前的输入按行切开
  if (tty) process.stdin.setRawMode(true);
  const parser = createInputParser({
    submit,
    echo: text => { if (tty) process.stdout.write(text); },
    interrupt: () => exitWith('', 130),
  });
  const logFile = process.env.CLAUDE_PANEL_MOCK_INPUT_LOG;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (logFile) {
      try { fs.appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), data: chunk })}\n`); } catch { /* 记录失败不影响处理 */ }
    }
    parser.feed(chunk);
  });
  return () => new Promise(resolve => {
    if (buffered.length) resolve(buffered.shift());
    else waiters.push(resolve);
  });
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * 输入解析：模拟 TUI 输入框。粘贴开始与结束标记之间的内容整段并入输入框（其中的换行不提交），
 * 粘贴之外的回车（\r、\n 或 \r\n）提交输入框内容；其他 ESC 控制序列整段忽略；Ctrl+C 中断；退格删除一个字符。
 * 标记被切在两个数据块之间时，残缺部分留到下一块再判断。
 */
function createInputParser({ submit, echo = () => {}, interrupt = () => {} }) {
  let pending = '';
  let box = '';
  let inPaste = false;
  let lastCR = false;
  const pasteText = text => text.replace(/\r\n?/g, '\n');
  const feed = chunk => {
    pending += chunk;
    while (pending) {
      if (inPaste) {
        const end = pending.indexOf(PASTE_END);
        if (end >= 0) {
          box += pasteText(pending.slice(0, end));
          pending = pending.slice(end + PASTE_END.length);
          inPaste = false;
          const lines = box.split('\n').length;
          echo(lines > 1 ? `[粘贴 ${lines} 行]` : '');
          continue;
        }
        // 末尾可能是半个结束标记：保留到下一块
        let keep = 0;
        for (let k = Math.min(PASTE_END.length - 1, pending.length); k > 0; k--) {
          if (PASTE_END.startsWith(pending.slice(-k))) { keep = k; break; }
        }
        box += pasteText(pending.slice(0, pending.length - keep));
        pending = pending.slice(pending.length - keep);
        return;
      }
      const ch = pending[0];
      if (ch === '\x1b') {
        const seq = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(pending);
        if (!seq) {
          // 可能是被切开的控制序列：长度不足以判断时等下一块；否则丢掉单独的 ESC
          if (/^\x1b(\[[0-?]*[ -/]*)?$/.test(pending)) return;
          pending = pending.slice(pending[1] === '[' ? 1 : 2);
          continue;
        }
        pending = pending.slice(seq[0].length);
        if (seq[0] === PASTE_START) inPaste = true;
        lastCR = false;
        continue;
      }
      pending = pending.slice(1);
      if (ch === '\n' && lastCR) { lastCR = false; continue; }
      lastCR = ch === '\r';
      if (ch === '\r' || ch === '\n') {
        const line = box;
        box = '';
        echo('\r\n');
        submit(line);
      } else if (ch === '\x03') {
        interrupt();
      } else if (ch === '\x7f' || ch === '\b') {
        if (box) { box = box.slice(0, -1); echo('\b \b'); }
      } else if (ch >= ' ' || ch === '\t') {
        box += ch;
        echo(ch);
      } else {
        // 其余控制字符不进输入框，按控制台习惯回显为 ^X
        echo(`^${String.fromCharCode(ch.charCodeAt(0) + 64)}`);
      }
    }
  };
  return { feed };
}

/**
 * 模拟一次子代理：上报 SubagentStart，写子代理记录（sidechain，input 500、缓存读 10000、output 1000），
 * 再上报带 agent_transcript_path 的 SubagentStop
 */
async function runSubagent(sessionId, transcript, u, post) {
  const agentId = 'mock1';
  const file = agentPathOf(transcript, agentId);
  await post({ hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'general-purpose' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sub = { model: u.model, input: 500, cacheWrite: 0, cacheRead: 10000 };
  const msgId = `msg_mock_sub_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  fs.appendFileSync(file, `${assistantLine(sessionId, msgId, sub, 1000, true)}\n`);
  await sleep(200);
  await post({
    hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: 'general-purpose',
    agent_transcript_path: file, last_assistant_message: '子代理完成',
  });
}

/**
 * 文件操作指令：任务里每一行形如下面的写法都算一次工具调用，有指令时不再走默认的 Bash echo。
 * 路径相对工作目录，也可写绝对路径；text 缺省为 mock；父目录不存在时自动创建。
 *   write <path> [text]  Write 工具：整个文件写成 text
 *   edit <path> [text]   Edit 工具：在文件末尾追加一行 text
 *   rm <path>            Bash 工具：删除文件
 *   sh <path> [text]     Bash 工具：在文件末尾追加一行 text
 */
function parseFileOps(task) {
  const ops = [];
  for (const raw of task.split('\n')) {
    const m = /^(write|edit|rm|sh)\s+(\S+)(?:\s+(.*))?$/.exec(raw.trim());
    if (m) ops.push({ op: m[1], file: path.resolve(process.cwd(), m[2]), text: m[3] ?? 'mock' });
  }
  return ops;
}

/** 一次文件操作的工具名与参数（PreToolUse 上报用） */
function opToolCall(o) {
  if (o.op === 'write') return { tool_name: 'Write', tool_input: { file_path: o.file, content: `${o.text}\n` } };
  if (o.op === 'edit') return { tool_name: 'Edit', tool_input: { file_path: o.file, old_string: '', new_string: `${o.text}\n` } };
  if (o.op === 'rm') return { tool_name: 'Bash', tool_input: { command: `rm ${JSON.stringify(o.file)}` } };
  return { tool_name: 'Bash', tool_input: { command: `echo ${o.text} >> ${JSON.stringify(o.file)}` } };
}

function applyFileOp(o) {
  try {
    if (o.op === 'rm') {
      fs.rmSync(o.file, { force: true });
    } else {
      fs.mkdirSync(path.dirname(o.file), { recursive: true });
      if (o.op === 'write') fs.writeFileSync(o.file, `${o.text}\n`);
      else fs.appendFileSync(o.file, `${o.text}\n`);
    }
    console.log(`${o.op} ${o.file}`);
  } catch (err) {
    console.log(`${o.op} ${o.file} 失败：${err.message}`);
  }
}

async function main() {
  // 一次性打印模式（claude -p）：读完 stdin 后输出一条固定的提交信息，供「请 Claude 生成」自测
  if (process.argv.includes('-p')) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const bytes = Buffer.concat(chunks).length;
    process.stdout.write(`\`\`\`\nfeat: mock 生成的提交信息\n\n根据 ${bytes} 字节的提示词生成\n\`\`\`\n`);
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const noTranscript = process.env.CLAUDE_PANEL_MOCK_NO_TRANSCRIPT === '1';
  let id = args.sessionId || crypto.randomUUID();
  let source = 'startup';
  let history = 0;

  if (args.resumeId) {
    const from = transcriptPathOf(args.resumeId);
    const lines = process.env.CLAUDE_PANEL_MOCK_RESUME_FAIL === '1' ? -1 : countLines(from);
    if (lines < 0) {
      await sleep(200);
      exitWith(`No conversation found with session ID: ${args.resumeId}`, 1);
      return;
    }
    source = 'resume';
    history = lines;
    if (args.fork) {
      id = args.sessionId || crypto.randomUUID();
      if (!noTranscript) {
        const to = transcriptPathOf(id);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
    } else {
      id = args.resumeId;
    }
  }

  const transcript = transcriptPathOf(id);
  const post = async payload => {
    try {
      await postEvent({ session_id: id, transcript_path: transcript, cwd: process.cwd(), ...payload });
    } catch {
      // 面板未运行或端口文件缺失：放弃上报
    }
  };

  console.log(`mock-claude 已启动，等待任务输入（回车提交）…`);
  console.log(`CLAUDE_CODE_CHILD=${process.env.CLAUDE_CODE_CHILD ?? ''}`);
  console.log(`会话 ${id}${args.name ? `，名称 ${args.name}` : ''}${args.model ? `，模型 ${args.model}` : ''}`);
  if (source === 'resume') {
    console.log(args.fork ? `已分叉自 ${args.resumeId}，历史 ${history} 条` : `已续接，历史 ${history} 条`);
  }
  const nextLine = lineQueue();
  // 与真实 CLI 一致：目录信任确认在任何 hook 之前，确认前不上报 SessionStart、不开启粘贴模式
  if (process.env.CLAUDE_PANEL_MOCK_TRUST === '1') {
    console.log('Do you trust the files in this folder?');
    console.log(`  ${process.cwd()}`);
    console.log('❯ 1. Yes, proceed');
    console.log('  2. No, exit');
    for (;;) {
      const pick = (await nextLine()).trim();
      if (pick === '2') { exitWith('已取消信任确认', 1); return; }
      if (pick === '' || pick === '1') break;
    }
    console.log('已信任此目录');
  }
  await post({ hook_event_name: 'SessionStart', source });
  // 与真实 TUI 一致：输入框就绪后开启粘贴模式
  process.stdout.write('\x1b[?2004h');

  const noPermission = process.env.CLAUDE_PANEL_MOCK_NO_PERMISSION === '1';
  const editFile = process.env.CLAUDE_PANEL_MOCK_EDIT;
  const turnMs = Math.max(0, Number(process.env.CLAUDE_PANEL_MOCK_TURN_MS) || 500);
  for (;;) {
    const task = (await nextLine()).trim();
    if (!task) continue;
    // 与真实 CLI 的 /exit 一致：正常退出（退出码 0），不写对话记录
    if (task === '/exit') {
      exitWith('已退出', 0);
      return;
    }
    if (!noTranscript) {
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.appendFileSync(transcript, `${JSON.stringify({ type: 'user', text: task })}\n`);
    }
    // 用量记录只在显式指定记录根目录时写（测试与隔离实例用临时目录）
    const withUsage = !noTranscript && !!process.env.CLAUDE_PANEL_TRANSCRIPT_ROOT;
    const u = turnUsage(task);
    const msgId = `msg_mock_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const writeUsage = output => {
      if (withUsage) fs.appendFileSync(transcript, `${assistantLine(id, msgId, u, output, false)}\n`);
    };
    if (withUsage && /compact/i.test(task)) fs.appendFileSync(transcript, `${compactLine(id)}\n`);
    const taskLines = task.split('\n');
    const head = taskLines[0].trim();
    // 多行任务（粘贴进来的整段）只算一条，回显行数
    console.log(taskLines.length > 1
      ? `收到任务（${taskLines.length} 行）："${head}"，开始处理…`
      : `收到任务："${task}"，开始处理…`);
    await post({ hook_event_name: 'UserPromptSubmit', prompt: task });
    writeUsage(1);
    const ops = parseFileOps(task);
    if (ops.length > 0) {
      let allowed = true;
      for (let i = 0; i < ops.length && allowed; i++) {
        const call = opToolCall(ops[i]);
        await post({ hook_event_name: 'PreToolUse', ...call });
        if (i === 0 && !noPermission) {
          await post({ hook_event_name: 'Notification', message: `Claude needs your permission to use ${call.tool_name}` });
          const a = (await nextLine()).trim().toLowerCase();
          allowed = a === 'y' || a === 'a';
          if (!allowed) break;
        }
        await sleep(Math.min(turnMs, 100));
        applyFileOp(ops[i]);
        await post({ hook_event_name: 'PostToolUse', tool_name: call.tool_name, tool_input: call.tool_input });
      }
      writeUsage(2000);
      await post({ hook_event_name: 'Stop' });
      console.log(allowed ? '回合结束，等待下一次输入（Ctrl+C 退出）…' : '已拒绝，等待下一次输入（Ctrl+C 退出）…');
      continue;
    }
    // 与真实 claude 一致：PreToolUse 携带工具参数，随后的权限 Notification 只有提示文本
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `echo ${head}` } });
    let answer = 'y';
    if (!noPermission) {
      await post({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
      answer = (await nextLine()).trim().toLowerCase();
    }
    if (answer === 'y' || answer === 'a') {
      if (withUsage && /sub/i.test(task)) await runSubagent(id, transcript, u, post);
      await sleep(turnMs);
      console.log(`$ echo ${head}\n${head}`);
      // 模拟改文件：把任务首行追加到工作目录下的指定文件，供改动统计与自动验证自测
      if (editFile) {
        try { fs.appendFileSync(path.resolve(process.cwd(), editFile), `${head}\n`); } catch { /* 写失败不影响回合 */ }
      }
      writeUsage(800);
      await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
      writeUsage(2000);
      await post({ hook_event_name: 'Stop' });
      console.log('回合结束，等待下一次输入（Ctrl+C 退出）…');
    } else {
      console.log('已拒绝，等待下一次输入（Ctrl+C 退出）…');
      await post({ hook_event_name: 'Stop' });
    }
  }
}

if (require.main === module) {
  main().catch(() => process.exit(1));
}

module.exports = { parseArgs, projectDirName, agentPathOf, createInputParser };
