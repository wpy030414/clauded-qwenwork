#!/usr/bin/env node
// bridge-shim.mjs — 千问办公 → Claude Code 桥接翻译层 v2
//
// 被 @qoder-ai/qoder-agent-sdk（≥1.0.46，对应千问办公 ≥1.2.x）的 ProcessTransport
// 当作 CLI spawn（QODER_CLI_PATH 指向本文件）。
//
// v2 方针（2026-09-24，对照 QwenWorkCN 1.2.1 / SDK 1.0.46 / claude 2.1.278 实测）：
//   1. 参数「应翻译尽翻译」：能直传的直传（含隐藏旗标），有等效的转换，无等效的丢弃+记日志
//   2. 控制协议双向透明桥接：claude 原生支持的 control_request 直接转发（权限弹窗/上下文仪表盘/
//      set_model 等成为真功能）；claude 不支持的由 shim 合成应答兜底
//   3. 延迟 spawn：等 SDK 的 initialize 请求到达后再 spawn claude，以便把 initialize 携带的
//      systemPrompt / appendSystemPrompt / promptSuggestions 翻译成 CLI 旗标
import { spawn, execSync as _execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform, tmpdir } from 'node:os';

// ---------- 配置 ----------
const DEFAULT_CLAUDE_BIN = (() => {
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  }
  let npmPrefix = '';
  try { npmPrefix = _execSync('npm prefix -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  if (npmPrefix) {
    const candidate = join(npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude');
    if (existsSync(candidate)) return candidate;
  }
  for (const p of [
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
    join(homedir(), '.npm-global', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude'),
  ]) {
    if (existsSync(p)) return p;
  }
  return 'claude';
})();
const CLAUDE_BIN = process.env.QODER_BRIDGE_CLAUDE ?? DEFAULT_CLAUDE_BIN;
const BRIDGE_MODEL = process.env.QODER_BRIDGE_MODEL; // 可选：强制指定 claude 模型
// SDK 1.0.46 内置 protocol_version=1.5.0；major 必须一致，minor 落后会触发诊断降级提示
const PROTOCOL_VERSION = '1.5.0';
const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'logs');
const LEDGER_DIR = join(homedir(), '.qwenwork-bridge');
const LEDGER_FILE = join(LEDGER_DIR, 'ledger.jsonl');
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(LEDGER_DIR, { recursive: true });

const logFile = join(LOG_DIR, `bridge-${process.pid}-${Date.now()}.log`);
const log = (tag, data) => {
  try { appendFileSync(logFile, `${new Date().toISOString()} [${tag}] ${data}\n`); } catch {}
};
// 黑匣子：未捕获异常完整落盘（现场排查用，正常路径不受影响）
process.on('uncaughtException', (e) => {
  try {
    appendFileSync(logFile, `${new Date().toISOString()} [UNCAUGHT] ${e?.stack ?? String(e)}\n`);
  } catch {}
  process.exitCode = 1;
  // 给日志 flush 一点时间再退
  setTimeout(() => process.exit(1), 100);
});
process.on('unhandledRejection', (e) => {
  try {
    appendFileSync(logFile, `${new Date().toISOString()} [UNHANDLED-REJECTION] ${e?.stack ?? String(e)}\n`);
  } catch {}
});
const ledger = (entry) => {
  try { appendFileSync(LEDGER_FILE, JSON.stringify({ ts: Date.now(), ...entry }) + '\n'); } catch {}
};

// ---------- 协议常量 ----------
const controlResponse = (requestId, response) =>
  JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n';
const controlError = (requestId, error) =>
  JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } }) + '\n';

// initialize 应答需注入的 capabilities（claude 原生只报 3 项；SDK 用它做功能门控）
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1', 'session_rewind_v1', 'background_tasks_v1'];

// claude 原生支持的 control_request 子类型（2026-09-24 对 claude 2.1.278 实测）——直接转发
const FORWARD_NATIVE = new Set([
  'initialize', 'set_permission_mode', 'set_model', 'get_context_usage', 'interrupt',
  'stop_task', 'cancel_async_message', 'background_tasks', 'mcp_set_servers',
  'mcp_toggle', 'mcp_reconnect', 'mcp_authenticate', 'apply_flag_settings', 'seed_read_state',
]);

// claude 工具名 → qoder 工具名（UI 卡片渲染用；renderer 1.2.1 仅特判 Agent）
const TOOL_MAP = { Task: 'Agent' };
// qoder 工具名 → claude 工具名（翻译 app 下发的工具列表/权限规则用）
const Q2C_TOOL = {
  Agent: 'Task', Bash: 'Bash', Edit: 'Edit', Glob: 'Glob', Grep: 'Grep',
  NotebookEdit: 'NotebookEdit', Read: 'Read', Write: 'Write', Skill: 'Skill',
  WebFetch: 'WebFetch', WebSearch: 'WebSearch', AskUserQuestion: 'AskUserQuestion',
};
// claude 已知工具集合（过滤映射后仍不认识的名字，避免 --tools 传入未知名报错）
const CLAUDE_TOOLS = new Set([
  'Task', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'Edit',
  'EnterWorktree', 'ExitWorktree', 'Glob', 'Grep', 'ListAgents', 'NotebookEdit', 'Read',
  'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'Skill', 'TaskStop', 'WaitForMcpServers',
  'WebFetch', 'WebSearch', 'Workflow', 'Write', 'AskUserQuestion',
]);

// qoder permission-mode 词表 → claude 词表（camelCase）
const PM_MAP = {
  default: null,                    // claude 用主人自己的默认配置
  accept_edits: 'acceptEdits', acceptEdits: 'acceptEdits',
  dont_ask: 'dontAsk', dontAsk: 'dontAsk',
  bypassPermissions: 'bypassPermissions',
  auto: 'auto', plan: 'plan', manual: 'manual',
};

const INIT_RESPONSE_FALLBACK = () => ({
  commands: [], agents: [], skills: [], output_style: 'default', available_output_styles: [],
  models: [], account: {}, capabilities: CAPABILITIES, pid: process.pid,
});
const MODELS_FALLBACK = () => ({
  models: [{
    value: 'claude-bridge',
    displayName: 'Claude',
    description: '使用强大的 Claude Code 代理后端',
    modelId: 'claude-bridge',
    source: 'system',
    isDefault: true,
    // —— 视觉能力声明（千问办公前端通过 is_vl 或 capabilities.vision 判断）——
    is_vl: true,
    capabilities: { vision: true },
  }],
});

// ---------- 参数解析 v2 ----------
// 可重复出现的有值参数（收集为数组，逐个透传——避免旧版 Map 覆盖造成的参数损失）
const REPEATABLE = new Set(['--add-dir', '--plugin-dir', '--allowed-tools', '--disallowed-tools', '--mcp-config']);
const VALUE_ARGS = new Set([
  '--output-format', '--input-format', '--session-id', '--resume', '--agent',
  '--system-prompt', '--append-system-prompt', '--max-budget-usd', '--max-turns',
  '--permission-mode', '--permission-prompt-tool', '--settings',
  '--resume-session-at', '--resume-drops-turn', '--tools',
  '--allowed-tools', '--disallowed-tools', '--mcp-config', '--add-dir', '--plugin-dir',
  // —— 以下仅用于识别与等效翻译，不直传 ——
  '--workdir', '--proxy', '--model', '--context-window', '--max-output-tokens',
  '--images', '--include', '--caller-version', '--ide-type', '--org-id', '--email',
  '--extensions', '--storage-dir', '--setting-sources',
]);
const FLAG_ARGS = new Set([
  '--print', '--include-partial-messages', '--continue', '--fork-session',
  '--debug', '--no-session-persistence', '--session-mirror',
  '--yolo', '--bare', '--strict-mcp-config', '--disable-builtin-skills',
  '--porcelain', '--keep-data',
]);

function parseArgs(argv) {
  const values = new Map();   // name -> string[]（统一数组，规避重复覆盖）
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      const name = a.slice(0, eq);
      if (VALUE_ARGS.has(name)) { push(name, a.slice(eq + 1)); continue; }
      if (FLAG_ARGS.has(name)) { flags.add(name); continue; }
      log('DROP', a); continue;
    }
    if (VALUE_ARGS.has(a)) { push(a, argv[++i]); }
    else if (FLAG_ARGS.has(a)) { flags.add(a); }
    else { log('DROP', a); }
  }
  function push(k, v) { if (!values.has(k)) values.set(k, []); values.get(k).push(v); }
  const first = (k) => values.get(k)?.[0];
  const all = (k) => values.get(k) ?? [];

  // ---- 内部查询判定（SDK 1.0.46 不再下发 --bare；特征是 --tools "" 或 --disallowed-tools *）----
  const internal =
    all('--tools').includes('') ||
    all('--disallowed-tools').includes('*') ||
    flags.has('--bare');

  // ---- 等效翻译：workdir → spawn cwd；proxy → 子进程 env ----
  let cwd;
  const wd = first('--workdir');
  if (wd && isAbsolute(wd) && existsSync(wd)) cwd = wd;
  const proxy = first('--proxy');
  const childEnv = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'qwenwork-bridge' };
  if (proxy) { childEnv.HTTPS_PROXY = proxy; childEnv.HTTP_PROXY = proxy; }

  // ---- 组装 claude 参数 ----
  const claudeArgs = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'];
  for (const f of ['--include-partial-messages', '--continue', '--fork-session', '--debug', '--no-session-persistence', '--session-mirror']) {
    if (flags.has(f)) claudeArgs.push(f);
  }
  // --yolo → claude 等效旗标（claude 不认 --yolo，实测 unknown option）
  if (flags.has('--yolo')) claudeArgs.push('--dangerously-skip-permissions');

  for (const v of ['--agent', '--max-budget-usd', '--max-turns',
                   '--resume-session-at', '--resume-drops-turn']) {
    for (const val of all(v)) claudeArgs.push(v, val);
  }
  // ---- 会话语义适配（claude vs qoder 语义相反，见 D11）----
  //   qoder: --session-id 幂等可重复、--resume 容错
  //   claude: --session-id 仅新建（X 已存在 → already in use 退出 1）
  //           --resume 仅续接（X 不存在 → error result 退出 0）
  //   app 对同一 chat 反复下发同一 session-id，第二轮起必崩。
  //   修复：按 cwd 查 claude 会话文件是否存在，据此互转。
  {
    const sid = first('--session-id');
    const rid = first('--resume');
    const cwdForSession = wd && isAbsolute(wd) ? wd : process.cwd();
    const sessionExists = (id) => {
      if (!id) return false;
      const slug = cwdForSession.replace(/[^A-Za-z0-9]/g, '-');
      const dir = join(homedir(), '.claude', 'projects', slug);
      return existsSync(join(dir, `${id}.jsonl`));
    };
    if (sid && sessionExists(sid)) {
      log('SESSION-ADAPT', `--session-id ${sid} → --resume（claude 会话已存在）`);
      // 不推 --session-id，改推 --resume
      claudeArgs.push('--resume', sid);
    } else if (sid) {
      claudeArgs.push('--session-id', sid);
    }
    if (rid && !sessionExists(rid)) {
      log('SESSION-ADAPT', `--resume ${rid} → --session-id（claude 会话不存在，新建）`);
      // 不推 --resume，改推 --session-id
      claudeArgs.push('--session-id', rid);
    } else if (rid) {
      claudeArgs.push('--resume', rid);
    }
  }
  // resume-session-at / resume-drops-turn 若以 = 形式到达也已归一为分离形式
  for (const v of ['--add-dir', '--plugin-dir']) {
    for (const val of all(v)) claudeArgs.push(v, val);
  }
  // 权限工具：app 注册 canUseTool 时 SDK 会传 --permission-prompt-tool stdio；claude 原生支持
  // → 千问办公的原生权限弹窗经 shim 双向转发恢复
  for (const val of all('--permission-prompt-tool')) claudeArgs.push('--permission-prompt-tool', val);

  // MCP：qw-builtin 网关必须透传（千问办公的工具通道）
  // Windows CreateProcess 对命令行总长度有限制（32767 字符，cmd.exe 包装后 8191）
  // JSON 转义后长度膨胀，易触发 ENAMETOOLONG → 写入临时文件，直接传路径（claude 的 --mcp-config 支持文件路径）
  for (const val of all('--mcp-config')) {
    if (val.length > 100) {
      const tmpFile = join(tmpdir(), `qwenwork-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
      writeFileSync(tmpFile, val, 'utf8');
      claudeArgs.push('--mcp-config', tmpFile);
      log('MCP-FILE', `wrote ${val.length} chars → ${tmpFile}`);
    } else {
      claudeArgs.push('--mcp-config', val);
    }
  }
  // （--strict-mcp-config 故意丢弃：让主人既有 MCP 与 qw-builtin 共存，见 DECISIONS D5）

  // 权限模式：词表归一后透传
  const pm = PM_MAP[first('--permission-mode') ?? 'default'];
  if (pm) claudeArgs.push('--permission-mode', pm);

  // 工具集翻译：qoder 工具名 → claude 工具名，未知名字丢弃；空结果回落 default。
  // 注意 claude 的 --tools 是变长参数，必须用 = 形式传值，否则会吞掉下一个参数
  for (const raw of all('--tools')) {
    if (raw === '' || raw === 'default') { claudeArgs.push(`--tools=${raw}`); continue; } // `--tools=` 即空串（禁用全部工具）
    const mapped = raw.split(',').map((t) => mapToolToken(t.trim(), Q2C_TOOL)).filter(Boolean);
    if (mapped.length > 0) claudeArgs.push(`--tools=${mapped.join(',')}`);
    else claudeArgs.push('--tools=default');
  }
  // allowed/disallowed tools：带规则的工具名（如 Bash(git *)）翻译 basename 后透传
  for (const val of all('--allowed-tools')) {
    const mapped = mapToolToken(val, Q2C_TOOL);
    if (mapped) claudeArgs.push('--allowed-tools', mapped);
  }
  for (const val of all('--disallowed-tools')) {
    if (val === '*') continue; // 内部查询特征值，不透传
    const mapped = mapToolToken(val, Q2C_TOOL);
    if (mapped) claudeArgs.push('--disallowed-tools', mapped);
  }

  // settings 转换：qoder/SDK 生成的 settings → 过滤出 claude 认识的字段后内联 JSON 传入
  const settingsRaw = first('--settings');
  const converted = convertSettings(settingsRaw);
  if (converted) claudeArgs.push('--settings', converted);

  // 模型：app 传的 qwen-* 模型名对 claude 无意义，丢弃；QODER_BRIDGE_MODEL 显式覆盖
  if (BRIDGE_MODEL) claudeArgs.push('--model', BRIDGE_MODEL);

  // 明确丢弃并记日志（claude 无对应旗标，透传即启动失败）：
  //   --caller-version --ide-type --org-id --email --porcelain --keep-data --extensions
  //   --storage-dir --setting-sources --disable-builtin-skills（故意：保留主人侧 claude skills）
  //   --bare（claude 的 --bare 是严格 API-key 模式，透传会破坏 OAuth 登录，绝不透传）
  //   --images --include --context-window --max-output-tokens --allowed-mcp-server-names
  // systemPrompt / appendSystemPrompt / promptSuggestions：SDK 经 initialize 请求下发，
  // 在延迟 spawn 阶段翻译为 --system-prompt / --append-system-prompt / --prompt-suggestions
  for (const dropped of ['--images', '--include', '--context-window', '--max-output-tokens',
                         '--allowed-mcp-server-names', '--caller-version', '--ide-type',
                         '--org-id', '--email', '--porcelain', '--keep-data', '--extensions',
                         '--storage-dir', '--setting-sources', '--disable-builtin-skills']) {
    if (values.has(dropped)) log('DROP-ARG', `${dropped}=${JSON.stringify(all(dropped))}`);
  }

  return { internal, claudeArgs, childEnv, cwd: cwd ?? process.cwd(), sessionId: first('--session-id') ?? null };
}

// 工具名映射：支持 "Tool" 与 "Tool(rule)" 两种形态；映射后必须是 claude 已知工具，否则丢弃
function mapToolToken(token, map) {
  if (!token) return null;
  const paren = token.indexOf('(');
  const base = paren >= 0 ? token.slice(0, paren) : token;
  const rule = paren >= 0 ? token.slice(paren) : '';
  const mapped = map[base] ?? (CLAUDE_TOOLS.has(base) ? base : null);
  return mapped ? mapped + rule : null;
}

// qoder settings → claude settings：白名单键过滤（permissions 语法同源：mcp__server__tool）
function convertSettings(raw) {
  if (!raw) return null;
  let obj;
  try {
    obj = raw.trim().startsWith('{') ? JSON.parse(raw) : JSON.parse(readFileSync(raw, 'utf8'));
  } catch (e) { log('SETTINGS-PARSE-FAIL', e.message); return null; }
  const out = {};
  let touched = false;
  // claude 认识且语义一致的键
  for (const k of ['permissions', 'env', 'outputStyle', 'includeCoAuthoredLine', 'cleanupPeriodDays']) {
    if (obj[k] !== undefined) { out[k] = obj[k]; touched = true; }
  }
  return touched ? JSON.stringify(out) : null;
}

// ---------- 内部查询：自答，不 spawn claude ----------
function runInternal() {
  log('MODE', 'internal (self-answered, no claude spawn)');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== 'control_request') return;
    const req = msg.request ?? {};
    const subtype = req.subtype ?? req.type ?? 'unknown';
    let resp;
    switch (subtype) {
      case 'initialize': resp = INIT_RESPONSE_FALLBACK(); break;
      case 'get_models': resp = MODELS_FALLBACK(); break;
      default: resp = {};
    }
    process.stdout.write(controlResponse(msg.request_id, resp));
  });
  rl.on('close', () => { log('EXIT', 'code=0 (internal)'); process.exitCode = 0; });
}

// ---------- 真实会话：延迟 spawn + 双向桥接 ----------
function runSession(parsed) {
  log('MODE', `real session sessionId=${parsed.sessionId}`);
  log('CLAUDE-ARGS', JSON.stringify(parsed.claudeArgs));
  log('CWD', parsed.cwd);

  let child = null;
  let claudeReady = false;
  const pendingStdin = [];             // claude 就绪前缓冲的 stdin 行
  const forwardedIds = new Set();      // shim 转发给 claude 的 SDK 请求 id（应答需回传 SDK）
  const claudePendingIds = new Set();  // claude 发出、等待 SDK 应答的请求 id
  const fwdTimers = new Map();         // request_id -> 兜底定时器
  const pendingFwdSubtypes = new Map(); // 转发请求 id -> 子类型（兜底合成 / initialize 合并用）
  const pendingFwdReqs = new Map();     // 转发请求 id -> 原始 request
  let claudeModels = null;             // claude initialize 应答里的 models（供 get_models 合成）
  let lastUserText = '';

  const claudeCommand = /\.(mjs|js)$/i.test(CLAUDE_BIN) ? [process.execPath, CLAUDE_BIN] : [CLAUDE_BIN];

  function spawnClaude() {
    if (child) return;
    try {
      // 检查命令行总长度，超过 8000 字符时警告
      const cmdLineLen = parsed.claudeArgs.join(' ').length;
      if (cmdLineLen > 8000) {
        log('SPAWN-WARN', `命令行长度 ${cmdLineLen} 接近 Windows 限制`);
        // 打印每个参数的长度，找出膨胀的参数
        parsed.claudeArgs.forEach((arg, i) => {
          if (arg.length > 100) {
            log('SPAWN-DEBUG-ARG', `[${i}] ${arg.length} chars: ${arg.substring(0, 200)}...`);
          }
        });
      }

      child = spawn(claudeCommand[0], [...claudeCommand.slice(1), ...parsed.claudeArgs], {
        cwd: parsed.cwd,
        env: parsed.childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      log('SPAWN-FAIL', `${e.message} | code=${e.code} | errno=${e.errno}`);
      log('SPAWN-DEBUG', `command=${claudeCommand[0]} | args.length=${parsed.claudeArgs.length} | cwd=${parsed.cwd}`);
      process.stderr.write(`[qwenwork-bridge] spawn claude failed: ${e.message}\n`);
      process.exitCode = 1;
      try { process.stdin.destroy(); } catch {}
      return;
    }
    child.on('error', (e) => {
      log('ERROR', e.message);
      process.stderr.write(`[qwenwork-bridge] spawn claude failed: ${e.message}\n`);
      process.exitCode = 1;
      try { process.stdin.destroy(); } catch {}
    });
    child.on('exit', (code, signal) => {
      log('EXIT', `code=${code} signal=${signal}`);
      process.exitCode = code ?? 1;
    });
    let stderrBuf = '';
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderrBuf += s;
      process.stderr.write(d);
      log('STDERR', s.trim());
    });
    child.on('exit', () => {
      if (stderrBuf) log('STDERR-FULL', stderrBuf.trim());
    });
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, () => { try { child?.kill(sig); } catch {} });
    }
    child.on('spawn', () => { claudeReady = true; flush(); });
    pumpClaudeStdout();
  }

  const flush = () => {
    if (!claudeReady) return;
    for (const l of pendingStdin.splice(0)) {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(l + '\n');
    }
  };
  const toClaude = (line) => {
    if (child && claudeReady && !child.stdin.destroyed && !child.stdin.writableEnded) {
      log('TO-CLAUDE', `direct ${String(line).slice(0, 60)}`);
      child.stdin.write(line + '\n');
    } else {
      log('TO-CLAUDE', `buffered(pending=${pendingStdin.length + 1}) ${String(line).slice(0, 60)}`);
      pendingStdin.push(line);
    }
  };
  // 转发控制请求时登记子类型（兜底合成 / initialize 合并要用）
  const forwardToClaude = (line) => {
    try {
      const m = JSON.parse(line);
      if (m.type === 'control_request' && m.request_id) {
        pendingFwdSubtypes.set(m.request_id, m.request?.subtype ?? m.request?.type ?? 'unknown');
        pendingFwdReqs.set(m.request_id, m.request ?? {});
      }
    } catch {}
    toClaude(line);
  };

  // ---- stdin（SDK → claude）：控制请求路由 / 控制应答回流 / 用户消息透传 ----
  const stdinRl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  stdinRl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.type === 'control_request') {
      const req = msg.request ?? {};
      const subtype = req.subtype ?? req.type ?? 'unknown';

      if (subtype === 'initialize') {
        // 延迟 spawn 的意义所在：把 initialize 携带的宿主配置翻译成 CLI 旗标
        // systemPrompt / appendSystemPrompt 可能超长（实测 39KB+），Windows CreateProcess
        // 命令行总长限制 32767 字符 → 超过阈值写入临时文件，用 @file 语法传入
        if (req.systemPrompt !== undefined && !parsed.claudeArgs.includes('--system-prompt') && !parsed.claudeArgs.includes('--system-prompt-file')) {
          const sp = String(req.systemPrompt);
          if (sp.length > 200) {
            const tmpFile = join(tmpdir(), `qwenwork-sysprompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
            writeFileSync(tmpFile, sp, 'utf8');
            parsed.claudeArgs.push('--system-prompt-file', tmpFile);
            log('SYSPROMPT-FILE', `wrote ${sp.length} chars → ${tmpFile}`);
          } else {
            parsed.claudeArgs.push('--system-prompt', sp);
          }
        }
        if (req.appendSystemPrompt !== undefined && !parsed.claudeArgs.includes('--append-system-prompt') && !parsed.claudeArgs.includes('--append-system-prompt-file')) {
          const asp = String(req.appendSystemPrompt);
          if (asp.length > 200) {
            const tmpFile = join(tmpdir(), `qwenwork-appendsysprompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
            writeFileSync(tmpFile, asp, 'utf8');
            parsed.claudeArgs.push('--append-system-prompt-file', tmpFile);
            log('APPENDSYSPROMPT-FILE', `wrote ${asp.length} chars → ${tmpFile}`);
          } else {
            parsed.claudeArgs.push('--append-system-prompt', asp);
          }
        }
        if (req.promptSuggestions === true) parsed.claudeArgs.push('--prompt-suggestions', 'true');
        if (req.hooks && Object.keys(req.hooks).length > 0) log('HOOKS-DECLINED', `app hooks 不经 claude 执行: ${Object.keys(req.hooks).join(',')}`);
        spawnClaude();
      } else if (!child) {
        // 非标准序列（initialize 未到先来别的请求）：防御性 spawn
        spawnClaude();
      }

      if (FORWARD_NATIVE.has(subtype)) {
        // 转发给 claude 原生处理；超时/Unsupported 由兜底合成
        forwardedIds.add(msg.request_id);
        forwardToClaude(line);
        log('CTRL-FWD', `${subtype} id=${msg.request_id}`);
        const timeoutMs = subtype === 'initialize' ? 8000 : subtype === 'interrupt' ? 5000 : 6000;
        const t = setTimeout(() => {
          if (!forwardedIds.has(msg.request_id)) return;
          forwardedIds.delete(msg.request_id);
          log('CTRL-FWD-TIMEOUT', `${subtype} id=${msg.request_id} → shim 合成兜底`);
          if (subtype === 'interrupt') { try { child?.kill('SIGTERM'); } catch {} }
          process.stdout.write(controlResponse(msg.request_id, synthFor(subtype, req)));
        }, timeoutMs);
        t.unref?.();
        fwdTimers.set(msg.request_id, t);
        return;
      }

      // shim 合成应答
      log('CTRL-SYNTH', `${subtype} id=${msg.request_id}`);
      process.stdout.write(controlResponse(msg.request_id, synthFor(subtype, req)));
      return;
    }

    if (msg.type === 'control_response') {
      // SDK 应答 claude 发出的请求（can_use_tool 权限弹窗等）→ 回流 claude
      const rid = msg.response?.request_id;
      if (rid && claudePendingIds.has(rid)) {
        claudePendingIds.delete(rid);
        toClaude(line);
        log('CTRL-BACK', `id=${rid} → claude`);
      }
      return;
    }

    if (msg.type === 'user' && msg.message) {
      log('USER-IN', `child=${!!child} ready=${claudeReady} ${extractText(msg.message).slice(0, 30)}`);
      if (!child) spawnClaude(); // 防御：user 先于 initialize 到达
      const text = extractText(msg.message);
      if (text) lastUserText = text;
      toClaude(line); // 原帧透传（claude 容忍多余字段）
      flush();
    }
  });
  stdinRl.on('close', () => {
    if (child && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  });
  // 兜底：3 秒内没有任何触发 spawn 的帧（异常序列）也强制 spawn，避免 SDK initialize 超时
  setTimeout(() => { if (!child) { log('SPAWN-GUARD', 'timeout without trigger, force spawn'); spawnClaude(); } }, 3000).unref?.();

  // ---- 合成应答表 ----
  function synthFor(subtype, req) {
    switch (subtype) {
      case 'initialize': return INIT_RESPONSE_FALLBACK();
      case 'get_models':
        if (Array.isArray(claudeModels) && claudeModels.length > 0) {
          return { models: claudeModels.map((m, i) => ({
            value: m.value ?? m.id ?? String(m),
            displayName: m.displayName ?? m.value ?? m.id ?? String(m),
            description: m.description ?? 'Claude Code (bridge)',
            modelId: m.modelId ?? m.id ?? m.value ?? String(m),
            source: 'system', isDefault: m.isDefault ?? i === 0,
            // —— 视觉能力注入：Claude 全系列支持 vision ——
            is_vl: true,
            capabilities: { vision: true },
          })) };
        }
        return MODELS_FALLBACK();
      case 'generate_session_title':
        return { title: (String(req.description ?? lastUserText ?? '').trim() || '会话').slice(0, 20) };
      case 'account_info': return { account: {} };
      case 'get_usage_info': return { usage: null, session: null, usage_error: 'bridge: 用量请看 ~/.qwenwork-bridge/ledger.jsonl' };
      default: return {};
    }
  }

  // ---- stdout（claude → SDK）：事件改写 + 控制帧回流 ----
  function pumpClaudeStdout() {
    const outRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    outRl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }

      // claude 对转发请求的应答：initialize 需合并注入，其余原样回传 SDK
      if (msg.type === 'control_response') {
        const rid = msg.response?.request_id;
        if (rid && forwardedIds.has(rid)) {
          forwardedIds.delete(rid);
          const t = fwdTimers.get(rid); if (t) { clearTimeout(t); fwdTimers.delete(rid); }
          const subtypeOf = msg.response.subtype;
          if (subtypeOf === 'error') {
            // claude 不认识该子类型（版本差异）→ shim 兜底合成
            const original = pendingFwdSubtypes.get(rid) ?? 'unknown';
            log('CTRL-FWD-ERROR', `${original}: ${String(msg.response.error).slice(0, 120)} → shim 合成兜底`);
            process.stdout.write(controlResponse(rid, synthFor(original, pendingFwdReqs.get(rid) ?? {})));
            return;
          }
          if (pendingFwdSubtypes.get(rid) === 'initialize' && msg.response.response && typeof msg.response.response === 'object') {
            const merged = mergeInitializeResponse(msg.response.response);
            claudeModels = merged.models ?? claudeModels;
            msg.response.response = merged;
          }
          process.stdout.write(JSON.stringify(msg) + '\n');
          return;
        }
        // 未知 id 的应答：透传（无害）
        process.stdout.write(line + '\n');
        return;
      }

      // claude 发出的请求（can_use_tool 权限弹窗等）→ 转给 SDK，应答经 stdin 回流
      if (msg.type === 'control_request') {
        claudePendingIds.add(msg.request_id);
        log('CTRL-UPSTREAM', `${msg.request?.subtype ?? msg.request?.type ?? '?'} id=${msg.request_id}`);
        process.stdout.write(line + '\n');
        return;
      }

      if (msg.type === 'system' && msg.subtype === 'init') {
        msg.protocol_version = PROTOCOL_VERSION;
        if (Array.isArray(msg.tools)) msg.tools = msg.tools.map((t) => TOOL_MAP[t] ?? t);
        // SDK 读 init 事件的 commands 字段；claude 报的是 slash_commands（字符串数组）
        if (msg.commands === undefined && Array.isArray(msg.slash_commands)) {
          msg.commands = msg.slash_commands.map((name) => ({ name, description: '' }));
        }
        process.stdout.write(JSON.stringify(msg) + '\n');
        return;
      }

      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use' && TOOL_MAP[block.name]) block.name = TOOL_MAP[block.name];
        }
        process.stdout.write(JSON.stringify(msg) + '\n');
        return;
      }

      if (msg.type === 'result') {
        ledger({
          sessionId: msg.session_id ?? parsed.sessionId,
          model: msg.model ?? null,
          total_cost_usd: msg.total_cost_usd ?? 0,
          num_turns: msg.num_turns ?? 0,
          duration_ms: msg.duration_ms ?? 0,
          is_error: msg.is_error ?? false,
          result_preview: String(msg.result ?? '').slice(0, 120),
        });
        process.stdout.write(JSON.stringify(msg) + '\n');
        return;
      }

      process.stdout.write(line + '\n');
    });
  }
}

// claude 的 initialize 应答 → SDK 期望形状：补 capabilities / skills / 视觉能力
function mergeInitializeResponse(resp) {
  const merged = { ...resp };
  if (!Array.isArray(merged.capabilities)) merged.capabilities = CAPABILITIES;
  if (!Array.isArray(merged.skills)) merged.skills = [];
  // —— 视觉能力注入：Claude 全系列支持 vision，千问办公前端通过 is_vl / capabilities.vision 判断 ——
  if (Array.isArray(merged.models)) {
    merged.models = merged.models.map((m) => {
      if (typeof m !== 'object' || m === null) return m;
      return { ...m, is_vl: m.is_vl ?? true, capabilities: { vision: true, ...(m.capabilities ?? {}) } };
    });
  }
  return merged;
}

function extractText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
  }
  return '';
}

// ---------- 入口 ----------
const parsed = parseArgs(process.argv.slice(2));
log('ARGV', JSON.stringify(process.argv.slice(2)));
log('ENV', JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^QODER/i.test(k)))));
log('CLAUDE-BIN', CLAUDE_BIN);

if (parsed.internal) runInternal();
else runSession(parsed);
