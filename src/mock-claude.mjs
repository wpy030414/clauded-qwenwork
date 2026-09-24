#!/usr/bin/env node
// mock-claude.mjs — 测试专用 claude 替身：模拟 claude 2.1.278 的 stream-json + 控制协议行为
// 由 bridge-shim.test.mjs 通过 QODER_BRIDGE_CLAUDE 指向，验证 shim 的翻译与双向桥接。
// 真实 claude 已实测的行为在 mock 中一一对应：
//   initialize/set_permission_mode/interrupt → success 应答（initialize 无 capabilities/skills 字段）
//   get_models/set_goal 等 → error "Unsupported control request subtype: ..."（shim 应兜底合成）
//   工具调用前发 can_use_tool 控制请求（等宿主应答 allow 后才继续）
import { createInterface } from 'node:readline';

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const ok = (rid, response) => send({ type: 'control_response', response: { subtype: 'success', request_id: rid, response } });
const err = (rid, error) => send({ type: 'control_response', response: { subtype: 'error', request_id: rid, error } });

let initSent = false;
let waitingCanUse = null; // { resolve } | null

function handleControl(msg) {
  const req = msg.request ?? {};
  const subtype = req.subtype ?? req.type ?? 'unknown';
  switch (subtype) {
    case 'initialize':
      // 形状对齐真实 claude：没有 capabilities、没有 skills（shim 必须合并注入）
      ok(msg.request_id, {
        commands: [{ name: 'mock-cmd', description: 'mock command', argumentHint: '' }],
        agents: [{ name: 'mock-agent', description: 'mock agent' }],
        output_style: 'default', available_output_styles: ['default', 'explanatory'],
        models: [{ id: 'claude-mock-1', displayName: 'Mock Opus' }, { id: 'claude-mock-2', displayName: 'Mock Sonnet' }],
        account: { type: 'oauth' }, pid: process.pid, current_permission_mode: 'default',
      });
      break;
    case 'set_permission_mode':
      ok(msg.request_id, { mode: req.mode ?? 'default' });
      break;
    case 'interrupt':
      ok(msg.request_id, { still_queued: [] });
      break;
    default:
      // 对齐真实 claude：不认识的子类型返回 Unsupported（shim 应捕获并兜底合成）
      err(msg.request_id, `Unsupported control request subtype: ${subtype}`);
  }
}

async function handleUser(msg) {
  const sid = 'mock-session';
  if (!initSent) {
    initSent = true;
    // 形状对齐真实 claude 的 system/init：tools 用 claude 名（Task），命令列表在 slash_commands
    send({
      type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sid,
      tools: ['Task', 'Bash', 'Write'], mcp_servers: [], model: 'claude-mock-1',
      slash_commands: ['mock-cmd', 'mock-skill'],
      // —— 测试断言用的回显字段（shim 透传未知字段）——
      _argv: process.argv.slice(2), _cwd: process.cwd(),
      _env_HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      _env_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
    });
  }
  // 1) Task 工具调用（断言 claude→qoder 方向的 Task→Agent 映射）
  send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Task', input: { prompt: 'sub' } }] }, session_id: sid });
  send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'subagent done' }] }, session_id: sid });
  // 2) Write 工具调用 → 先发 can_use_tool 控制请求，等宿主应答
  send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: 'x.txt', content: 'y' } }] }, session_id: sid });
  const rid = `mock-cr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  send({ type: 'control_request', request_id: rid, request: { subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write', input: { file_path: 'x.txt', content: 'y' }, description: 'Write file', permission_suggestions: [], tool_use_id: 'tu2' } });
  const allowed = await new Promise((resolve) => {
    waitingCanUse = { resolve };
    setTimeout(() => { if (waitingCanUse) { waitingCanUse = null; resolve(false); } }, 15000).unref?.();
  });
  if (allowed) {
    send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'File created' }] }, session_id: sid });
  } else {
    send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'permission denied' }] }, session_id: sid });
  }
  send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'MOCK_TURN_DONE' }] }, session_id: sid });
  send({ type: 'result', subtype: 'success', session_id: sid, total_cost_usd: 0.42, num_turns: 1, duration_ms: 5, is_error: false, result: 'MOCK_DONE', model: 'claude-mock-1' });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') { handleControl(msg); return; }
  if (msg.type === 'control_response') {
    const r = msg.response;
    if (waitingCanUse && r?.subtype === 'success' && r.request_id) {
      const { resolve } = waitingCanUse; waitingCanUse = null;
      resolve(r.response?.behavior === 'allow');
    }
    return;
  }
  if (msg.type === 'user' && msg.message) { handleUser(msg).catch(() => process.exit(1)); }
});
rl.on('close', () => { setTimeout(() => process.exit(0), 50); });
