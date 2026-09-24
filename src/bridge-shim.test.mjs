// bridge-shim.test.mjs — 密闭测试：用 mock-claude.mjs 替身验证 shim v2 的翻译与双向桥接
// 运行：node src/bridge-shim.test.mjs（不消耗任何 API 额度）
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, 'bridge-shim.mjs');
const MOCK = join(HERE, 'mock-claude.mjs');

let failures = 0;
const ok = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 测试 1：内部查询（--tools "" + --disallowed-tools *，SDK 1.0.46 特征）----------
async function t1_internal() {
  console.log('\n===== 1. 内部查询：本地自答，不 spawn claude =====');
  const marker = join(tmpdir(), `bridge-mock-marker-${Date.now()}`);
  const c = spawn('node', [SHIM,
    '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--tools', '', '--disallowed-tools', '*',
  ], {
    cwd: HERE, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, QODER_BRIDGE_CLAUDE: MOCK, MOCK_SPAWN_MARKER: marker },
  });
  const responses = [];
  const done = new Promise((resolve) => {
    const rl = createInterface({ input: c.stdout, crlfDelay: Infinity });
    c.stdin.write(JSON.stringify({ type: 'control_request', request_id: 't1-init', request: { type: 'initialize', subtype: 'initialize' } }) + '\n');
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.type !== 'control_response') return;
        responses.push(msg);
        if (responses.length === 1) {
          c.stdin.write(JSON.stringify({ type: 'control_request', request_id: 't1-models', request: { type: 'get_models', subtype: 'get_models' } }) + '\n');
        } else {
          c.stdin.end();
        }
      } catch {}
    });
    c.on('exit', resolve);
  });
  const code = await done;
  ok(code === 0, '内部查询 exit 0');
  ok(responses.length === 2, `恰好 2 个 control_response (got ${responses.length})`);
  ok(Array.isArray(responses[0]?.response?.response?.capabilities) && responses[0].response.response.capabilities.length >= 5,
    'initialize 自答含 capabilities');
  ok(Array.isArray(responses[1]?.response?.response?.models) && responses[1].response.response.models.length > 0,
    'get_models 自答含 models');
  ok(!existsSync(marker), '未 spawn claude（mock 无 marker）');
}

// ---------- 测试 2：真实会话全流程（参数翻译 + 双向控制桥接 + 事件改写 + 两轮对话）----------
async function t2_session() {
  console.log('\n===== 2. 真实会话：翻译 + 桥接 + 两轮 =====');
  const workdir = mkdtempSync(join(tmpdir(), 'bridge-wd-'));
  const argv = [
    // SDK 1.0.46 buildArgs 会下发的代表性参数
    '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--tools', 'Agent,Bash,TaskCreate,ImageGen,Write',
    '--allowed-tools', 'Skill', '--disallowed-tools', 'Bash(rm -rf *)',
    '--permission-mode', 'accept_edits', '--permission-prompt-tool', 'stdio',
    '--session-id', '12345678-1234-1234-1234-123456789abc',
    '--max-turns', '2', '--yolo',
    '--workdir', workdir, '--proxy', 'http://proxy.test:3128',
    '--caller-version', '1.2.1', '--ide-type', 'qwenwork', '--model', 'qwork-advanced',
    '--settings', '{"permissions":{"allow":["Bash(echo *)"]},"outputStyle":"default","aiCodeStatistics":true}',
    '--setting-sources', '', '--disable-builtin-skills', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{"qw-builtin":{"type":"http","url":"http://127.0.0.1:54365/x"}}}',
  ];
  const c = spawn('node', [SHIM, ...argv], { cwd: HERE, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, QODER_BRIDGE_CLAUDE: MOCK } });
  const SID = '12345678-1234-1234-1234-123456789abc';
  const userMsg = (text) => JSON.stringify({ type: 'user', session_id: SID, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';

  const seen = { initEvent: null, initResp: null, results: [], canUseReq: null, modelsResp: null, pmResp: null, goalResp: null, interruptResp: null, agentToolSeen: false, taskToolSeen: false };
  const done = new Promise((resolve) => {
    const rl = createInterface({ input: c.stdout, crlfDelay: Infinity });
    c.stderr.on('data', (d) => process.stderr.write('[shim] ' + d));
    // SDK 序列：先 initialize（带 systemPrompt/promptSuggestions，验证延迟 spawn 翻译）
    c.stdin.write(JSON.stringify({ type: 'control_request', request_id: 's-init', request: { type: 'initialize', subtype: 'initialize', systemPrompt: '你是千问办公的 mock 引导。', promptSuggestions: true } }) + '\n');

    rl.on('line', (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'control_response') {
        const r = msg.response;
        if (r.request_id === 's-init') {
          seen.initResp = r;
          // initialize 应答后：并发发 get_models（claude 不支持→shim 合成）与 set_permission_mode（转发）
          c.stdin.write(JSON.stringify({ type: 'control_request', request_id: 's-models', request: { type: 'get_models', subtype: 'get_models' } }) + '\n');
          c.stdin.write(JSON.stringify({ type: 'control_request', request_id: 's-pm', request: { type: 'set_permission_mode', subtype: 'set_permission_mode', mode: 'plan' } }) + '\n');
          c.stdin.write(JSON.stringify({ type: 'control_request', request_id: 's-goal', request: { type: 'set_goal', subtype: 'set_goal', goal: 'x' } }) + '\n');
          c.stdin.write(userMsg('第一轮：请开始'));
        } else if (r.request_id === 's-models') seen.modelsResp = r;
        else if (r.request_id === 's-pm') seen.pmResp = r;
        else if (r.request_id === 's-goal') seen.goalResp = r;
        else if (r.request_id === 's-int') seen.interruptResp = r;
      } else if (msg.type === 'control_request') {
        // claude 上行的 can_use_tool → 宿主应答 allow（验证反向桥接）
        seen.canUseReq = msg;
        c.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { behavior: 'allow', updatedInput: msg.request?.input } } }) + '\n');
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        seen.initEvent = msg;
      } else if (msg.type === 'assistant' && msg.message?.content) {
        for (const b of msg.message.content) {
          if (b.type === 'tool_use') {
            if (b.name === 'Agent') seen.agentToolSeen = true;
            if (b.name === 'Task') seen.taskToolSeen = true;
          }
        }
      } else if (msg.type === 'result') {
        seen.results.push(msg);
        if (seen.results.length === 1) {
          c.stdin.write(userMsg('第二轮：继续'));
        } else {
          c.stdin.write(JSON.stringify({ type: 'control_request', request_id: 's-int', request: { type: 'interrupt', subtype: 'interrupt' } }) + '\n');
          setTimeout(() => c.stdin.end(), 200);
        }
      }
    });
    c.on('exit', resolve);
  });
  const code = await done;

  // ---- initialize 应答（转发 + 合并）----
  ok(seen.initResp?.subtype === 'success', 'initialize 转发应答 success');
  const ir = seen.initResp?.response ?? {};
  ok(Array.isArray(ir.capabilities) && ir.capabilities.length >= 5, `initialize 合并注入 capabilities (got ${ir.capabilities?.length})`);
  ok(Array.isArray(ir.skills), 'initialize 合并注入 skills');
  ok(Array.isArray(ir.commands) && ir.commands.some((x) => x.name === 'mock-cmd'), 'initialize 透传 claude commands');

  // ---- get_models（claude Unsupported → shim 用 claude initialize models 合成）----
  ok(seen.modelsResp?.subtype === 'success', 'get_models 兜底合成 success');
  ok(JSON.stringify(seen.modelsResp?.response?.models ?? []).includes('claude-mock-1'), 'get_models 由 claude initialize.models 映射');

  // ---- set_permission_mode 转发 ----
  ok(seen.pmResp?.subtype === 'success' && seen.pmResp?.response?.mode === 'plan', 'set_permission_mode 原生转发生效');

  // ---- set_goal（claude Unsupported → shim 合成）----
  ok(seen.goalResp?.subtype === 'success', 'set_goal 兜底合成 success');

  // ---- interrupt 转发 ----
  ok(seen.interruptResp?.subtype === 'success' && 'still_queued' in (seen.interruptResp?.response ?? {}), 'interrupt 原生转发 still_queued');

  // ---- can_use_tool 反向桥接 ----
  ok(seen.canUseReq?.request?.subtype === 'can_use_tool' && seen.canUseReq.request.tool_name === 'Write', 'can_use_tool 上行转发到宿主');
  ok(seen.results[0]?.result === 'MOCK_DONE' && seen.results[0]?.is_error === false, 'can_use_tool 应答 allow 后工具执行（第一轮 result 成功）');

  // ---- system/init 事件改写 ----
  const ie = seen.initEvent ?? {};
  ok(ie.protocol_version === '1.5.0', `init 注入 protocol_version=1.5.0 (got ${ie.protocol_version})`);
  ok(Array.isArray(ie.tools) && ie.tools.includes('Agent') && !ie.tools.includes('Task'), `init tools Task→Agent 映射 (${JSON.stringify(ie.tools)})`);
  ok(Array.isArray(ie.commands) && ie.commands.length === 2 && ie.commands[0]?.name === 'mock-cmd', 'init slash_commands→commands 翻译');

  // ---- assistant 工具名映射 ----
  ok(seen.agentToolSeen && !seen.taskToolSeen, 'assistant tool_use Task→Agent 映射');

  // ---- 参数翻译（mock 回显的 argv/cwd/env）----
  const a = ie._argv ?? [];
  const has = (flag) => a.includes(flag);
  const val = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; };
  const eq = a.filter((x) => x.startsWith('--tools='));
  ok(!has('--yolo') && has('--dangerously-skip-permissions'), '--yolo → --dangerously-skip-permissions');
  ok(!has('--bare') && !has('--caller-version') && !has('--ide-type') && !has('--model') && !has('--setting-sources') && !has('--strict-mcp-config') && !has('--disable-builtin-skills'),
    '炸弹/无意义旗标全部过滤');
  ok(eq.length === 1 && eq[0] === '--tools=Task,Bash,Write', `--tools 名映射+未知丢弃 (got ${JSON.stringify(eq)})`);
  ok(val('--max-turns') === '2', '--max-turns 直传');
  ok(val('--permission-prompt-tool') === 'stdio', '--permission-prompt-tool 直传');
  ok(val('--allowed-tools') === 'Skill', '--allowed-tools 直传');
  ok(val('--disallowed-tools') === 'Bash(rm -rf *)', '--disallowed-tools 规则形态保留');
  ok(a.includes('--permission-mode') && a[a.indexOf('--permission-mode') + 1] === 'acceptEdits', '--permission-mode accept_edits → acceptEdits');
  ok(val('--system-prompt') === '你是千问办公的 mock 引导。', 'initialize.systemPrompt → --system-prompt（延迟 spawn）');
  ok(has('--prompt-suggestions'), 'initialize.promptSuggestions → --prompt-suggestions');
  const sIdx = a.indexOf('--settings');
  if (sIdx >= 0) {
    let s = {}; try { s = JSON.parse(a[sIdx + 1]); } catch {}
    ok(s.permissions?.allow?.[0] === 'Bash(echo *)' && s.aiCodeStatistics === undefined,
      '--settings 白名单过滤转换（permissions 保留、qoder 专属字段剔除）');
  } else ok(false, '--settings 转换后传入');
  ok(ie._cwd === workdir.replace(/\\/g, '/').replace(/\/$/, '') || ie._cwd === workdir, `--workdir → spawn cwd (${ie._cwd})`);
  ok(ie._env_HTTPS_PROXY === 'http://proxy.test:3128', '--proxy → HTTPS_PROXY env');
  ok(ie._env_ENTRYPOINT === 'qwenwork-bridge', 'CLAUDE_CODE_ENTRYPOINT 标记');
  ok(a.includes('--mcp-config') && val('--mcp-config')?.includes('qw-builtin'), '--mcp-config 透传');

  // ---- 会话生命周期 ----
  ok(seen.results.length === 2, `同进程两轮 result (got ${seen.results.length})`);
  ok(code === 0, `exit 0 (got ${code})`);

  rmSync(workdir, { recursive: true, force: true });
}

await t1_internal();
await t2_session();
console.log(`\n===== 结果: ${failures === 0 ? '全部通过' : failures + ' 项失败'} =====`);
process.exit(failures === 0 ? 0 : 1);
