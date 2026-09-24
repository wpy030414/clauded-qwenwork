# Spec: module-bridge-shim — 千问办公 → Claude Code 桥接翻译层 v2

实现契约。目标：让 Agent 完成任务时，从「千问办公 UI → qoder CLI」改道为「千问办公 UI → claude CLI」。

**v2 方针（2026-09-24，对照 QwenWorkCN 1.2.1 / SDK 1.0.46 / claude 2.1.278 实测）**：
1. 参数「应翻译尽翻译」：能直传的直传（含隐藏旗标），有等效的转换，无等效的丢弃+记日志
2. 控制协议双向透明桥接：claude 原生支持的 control_request 直接转发（权限弹窗/上下文仪表盘/set_model 等成为真功能）；claude 不支持的由 shim 合成应答兜底
3. 延迟 spawn：等 SDK 的 initialize 请求到达后再 spawn claude，以便把 initialize 携带的 systemPrompt/appendSystemPrompt/promptSuggestions 翻译成 CLI 旗标

## 要实现什么

一个 Node.js 翻译层（`src/bridge-shim.mjs`），被 `@qoder-ai/qoder-agent-sdk` 的 ProcessTransport 当作「qoder CLI」spawn（通过 `QODER_CLI_PATH` 环境变量触发）。它：

1. 把 qoder 的 CLI 参数翻译/过滤成 claude 参数；
2. 拦截并应答 SDK 发来的 `control_request` 帧；
3. 把 claude 的 stream-json 事件改写为 SDK 期望的事件后回流；
4. 维护成本台账。

## 输入 / 输出

- **启动**：`node src/bridge-shim.mjs <qoder-cli-args...>`（SDK 检测到 `.mjs` 路径时自动以 node 执行；cwd 由 SDK 传入）。
- **stdin（JSONL）**：`control_request` 帧 + `control_response` 帧（SDK 对 claude 请求的应答）+ `user` 消息（`{type:"user",session_id,message:{...}}`）。
- **stdout（JSONL）**：`system/init`、`assistant`、`user`、`result`、`control_response` 等事件，最后正常退出（退出码 0；SDK 视 41 为认证过期，勿误用）。
- **stderr**：日志（SDK 会记录并回传 app）；shim 同时完整落盘 `src/logs/bridge-<pid>-<ts>.log`。

## 行为契约

### 1. 参数翻译（白名单驱动，见 `src/bridge-shim.mjs` 的 `VALUE_ARGS`/`FLAG_ARGS`）

**基础帧（硬编码注入）**：`-p --output-format stream-json --input-format stream-json --verbose`

**透传有值参数**（`VALUE_ARGS` 集合）：

| 参数 | 备注 |
|---|---|
| `--session-id` / `--resume` | 会话语义适配（D11）：按 cwd 查 `~/.claude/projects/<slug>/<id>.jsonl` 是否存在来互转 |
| `--add-dir` / `--agent` / `--plugin-dir` | 透传 |
| `--system-prompt` / `--append-system-prompt` | 超过 200 字符时写入 `%TEMP%` 临时文件，用 `--system-prompt-file` / `--append-system-prompt-file` 传入（D12） |
| `--max-budget-usd` / `--max-turns` | 透传 |
| `--output-format` / `--input-format` / `--model` | 透传（但 `--output-format stream-json` 会触发追加 `--verbose`） |
| `--mcp-config` | 超过 100 字符时写入 `%TEMP%` 临时文件，直接传文件路径（D12）；`--strict-mcp-config` 丢弃（让主人既有 MCP 共存） |
| `--permission-prompt-tool` | 透传（claude 原生支持，配 `--permission-prompt-tool stdio` 恢复千问办公原生权限弹窗） |
| `--tools` / `--allowed-tools` / `--disallowed-tools` | 工具名翻译（qoder → claude），未知名字丢弃；空结果回落 `--tools=default` |
| `--settings` | qoder settings → claude settings：白名单键过滤（permissions/env/outputStyle/includeCoAuthoredLine/cleanupPeriodDays）后内联 JSON 传入 |

**透传无值参数**（`FLAG_ARGS` 集合）：`--print --bare --continue --fork-session --include-partial-messages --debug --no-session-persistence --strict-mcp-config --yolo --session-mirror`

**等效翻译**：
- `--yolo` → `--dangerously-skip-permissions`（claude 不认 `--yolo`，实测 unknown option）
- `--workdir` → spawn cwd（不传旗标，直接设 spawn 选项）
- `--proxy` → 子进程 env `HTTPS_PROXY`/`HTTP_PROXY`（不传旗标）
- `--permission-mode default` → 不传（用 claude 默认）；`bypassPermissions`/`accept_edits`/`dont_ask`/`auto`/`plan` 按 claude 词汇表归一后透传（`PM_MAP`）

**丢弃参数**（不在白名单，记日志 `DROP-ARG`）：
- `--images` / `--include` / `--context-window` / `--max-output-tokens` / `--allowed-mcp-server-names`
- `--caller-version` / `--ide-type` / `--org-id` / `--email` / `--porcelain` / `--keep-data` / `--extensions`
- `--storage-dir` / `--setting-sources` / `--disable-builtin-skills`（故意：保留主人侧 claude skills）
- `--bare`（claude 的 `--bare` 是严格 API-key 模式，透传会破坏 OAuth 登录，绝不透传）
- 未知参数：丢弃并记日志（保守原则）

**模型**：app 传的 `qwen-*` 模型名丢弃；仅当 `QODER_BRIDGE_MODEL` 环境变量设置时才显式传 `--model`。

### 2. 控制协议双向桥接（v2 核心变化）

v2 不再拦截所有 `control_request` 本地自答，而是分三路：

#### 路径 A：claude 原生支持 → 直接转发（`FORWARD_NATIVE` 集合）

以下子类型直接转发给 claude，claude 的 `control_response` 原样回传 SDK：

`initialize` / `set_permission_mode` / `set_model` / `get_context_usage` / `interrupt` / `stop_task` / `cancel_async_message` / `background_tasks` / `mcp_set_servers` / `mcp_toggle` / `mcp_reconnect` / `mcp_authenticate` / `apply_flag_settings` / `seed_read_state`

转发时登记 request_id，设超时兜底（initialize 8s / interrupt 5s / 其余 6s）；超时或 claude 返回 `subtype: "error"` 时由 shim 合成兜底应答（`synthFor()`）。

`initialize` 应答特殊处理：claude 原生应答与 shim 合并注入 `capabilities`（claude 原生只报 3 项，SDK 用它做功能门控）和 `skills:[]`。

#### 路径 B：claude 不支持 → shim 合成应答

| 请求 | 响应策略 |
|---|---|
| `get_models` | 若 claude initialize 返回了 models 列表则映射为 SDK 形状；否则回落 `{models:[{value:"claude-bridge", displayName:"Claude", ...}]}` |
| `generate_session_title` | 用 `req.description` 或 `lastUserText` 截断 20 字生成 `{title}` |
| `account_info` | `{account:{}}` |
| `get_usage_info` | `{usage:null, session:null, usage_error:"bridge: 用量请看 ~/.qwenwork-bridge/ledger.jsonl"}` |
| 其他未识别 | 返回 `{}`（成功空值；绝不把 control_request 原文写入 claude stdin） |

应答格式严格按 SDK 约定：`{"type":"control_response","response":{"subtype":"success","request_id":<原id>,"response":<值>}}`；错误用 `{"subtype":"error","error":...,"code":...}`。

#### 路径 C：claude 发出的 control_request → 转给 SDK

claude 会发出 `can_use_tool`（权限弹窗）等 control_request → shim 登记 `claudePendingIds` 后原样转给 SDK → SDK 的 `control_response` 经 stdin 回流 claude。双向透明。

### 3. 事件改写（claude stdout → SDK）

| claude 事件 | 改写 |
|---|---|
| `system/init` | 注入 `protocol_version:"1.5.0"`（SDK 1.0.46 内置版本）；`tools[]` 中做 `Task→Agent`/`TodoWrite→TaskCreate` 工具名映射；`commands` 字段从 `slash_commands` 字符串数组合成（SDK 读 init 事件的 commands 字段）；其余字段（cwd/session_id/capabilities/skills/agents/...）透传 |
| `assistant` 消息 | `message.content[]` 中 `tool_use.name`：`Task→Agent`、`TodoWrite→TaskCreate`；其余工具名不改（app 按未知工具渲染通用卡片） |
| `result` | 透传；**同时记入成本台账** |
| 其他 | 透传（JSON 解析失败的行也原样透传） |

### 4. 内部查询（省钱优化）

检测条件（任一命中）：`--tools` 值为空串 / `--disallowed-tools` 值为 `*` / `--bare` 标志。

> SDK 1.0.46 不再下发 `--bare`；主要特征是 `--tools ""` 或 `--disallowed-tools *`。

命中后进入 `runInternal()` 模式：本地应答 `initialize` + `get_models` 等 control_request，不 spawn claude，等 stdin EOF 后 exit 0。节省 70%+ 的无效 token 消耗。

### 5. 会话语义适配（D11）

qoder 与 claude 对 `--session-id`/`--resume` 语义相反：
- qoder：`--session-id` 幂等（已存在则续接），`--resume` 容错（不存在则新建）。
- claude：`--session-id` 仅新建（已存在 → 退出 1），`--resume` 仅续接（不存在 → 退出 0）。

shim 按 cwd 查 claude 会话文件 `~/.claude/projects/<cwd-slug>/<id>.jsonl` 是否存在，据此互转：
- `--session-id <X>` 且文件已存在 → 改推 `--resume <X>`。
- `--resume <X>` 且文件不存在 → 改推 `--session-id <X>`。
- 其余情况原样透传。

cwd slug 算法：`cwd.replace(/[^A-Za-z0-9]/g, '-')`，与 claude 自身的 projects 目录命名一致。

### 6. cwd 与工作区

- **继承 SDK 传入的 cwd**（app 工作区目录，如 `~\.qwenworkcn\workspace\<chatId>`），让 claude 直接落在千问办公的工作流路径上。
- 文件操作权限遵循主人既有 claude 权限配置（`~/.claude/settings.json` 的 allow 列表）。
- 如需操作其他目录，通过 `--add-dir` 或 claude 既有权限配置放行。

### 7. 成本台账

每次 `result` 事件：追加一行 JSON 到 `~/.qwenwork-bridge/ledger.jsonl`：
`{ts, sessionId, model, total_cost_usd, num_turns, duration_ms, is_error, result_preview}`（`result_preview` 为 `msg.result` 截断 120 字）。

### 8. Windows 命令行长度规避（D12）

Windows `CreateProcess` 命令行总长度限制 32767 字符（`cmd.exe` 包装后 8191）。shim 对超长参数写入临时文件：

| 参数 | 阈值 | 临时文件 | claude 旗标 |
|---|---|---|---|
| `systemPrompt`（initialize 携带） | > 200 字符 | `%TEMP%/qwenwork-sysprompt-<ts>-<rand>.txt` | `--system-prompt-file` |
| `appendSystemPrompt`（initialize 携带） | > 200 字符 | `%TEMP%/qwenwork-appendsysprompt-<ts>-<rand>.txt` | `--append-system-prompt-file` |
| `--mcp-config` | > 100 字符 | `%TEMP%/qwenwork-mcp-<ts>-<rand>.json` | `--mcp-config <file>`（claude 支持文件路径） |

spawn 前检测命令行总长度，超 8000 字符时记日志 `SPAWN-WARN` 并打印膨胀参数 `SPAWN-DEBUG-ARG`。

### 9. 黑匣子（D14）

- `process.on('uncaughtException')`：完整 stack 写入当前 logFile（`[UNCAUGHT]`），100ms 后 `process.exit(1)`。
- `process.on('unhandledRejection')`：完整 stack 写入当前 logFile（`[UNHANDLED-REJECTION]`）。
- `child.stderr`：逐行写入 logFile（`[STDERR]`），子进程退出时汇总完整 stderr（`[STDERR-FULL]`）。
- spawn 异常捕获：`try/catch` 包裹 `spawn()`，失败时记 `[SPAWN-FAIL]` + `[SPAWN-DEBUG]` 并输出 stderr 摘要。

## 约束

- **不修改 app.asar / 不修改 SDK**；唯一外部改动是环境变量 `QODER_CLI_PATH` + `QODERCLI_PATH`（跨平台注册）。
- 保持协议保守：无法翻译的帧宁可丢弃/报成功，不可把 control_request 原文写入 claude stdin。
- 退出码：正常 0；claude 异常退出时同样以非 0 退出并输出 stderr 摘要（SDK 会包装为 QoderCliProcessError 上报）。
- 信号透杀：shim 收到 SIGTERM/SIGINT 时必须 kill claude 子进程，避免孤儿进程。
- 兼容性：进程可能被并发 spawn（主对话 + 内部查询），shim 无状态或按 `--session-id` 分文件存储。
- **跨平台**：
  - Windows: `QODER_CLI_PATH` 指向 `.mjs` 文件（SDK 自动识别并用 node 执行）。
  - macOS: `QODER_CLI_PATH` 指向 `.sh` wrapper（绕过 SDK PATH 限制，wrapper 内部探测 node 绝对路径）。

## 实现与测试

### 文件清单

| 文件 | 职责 |
|---|---|
| `src/bridge-shim.mjs` | 核心翻译层（参数翻译 + 控制协议应答 + 事件改写 + 台账） |
| `src/bridge-shim-wrapper.sh` | macOS shell wrapper（绕过 SDK PATH 限制，探测 node 绝对路径） |
| `src/bridge-shim.test.mjs` | 自动化测试（模拟 SDK 调用 shim，验证内部查询 + 真实会话多轮） |
| `src/index.mjs` | `pnpm apply`/`pnpm unapply`：注册/撤销 `QODER_CLI_PATH` + `QODERCLI_PATH` 两个环境变量（跨平台：Windows 注册表 + macOS `LaunchAgent`） |

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `QODER_BRIDGE_CLAUDE` | 覆盖 `claude` 可执行文件路径 | Windows: `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`；macOS: 自动探测 npm prefix 或常见路径 |
| `QODER_BRIDGE_MODEL` | 强制指定 claude 模型别名 | 不设置（由 claude 自行选择） |
| `QODER_BRIDGE_NODE` | macOS 专用：覆盖 node 可执行文件路径 | 自动探测 `/opt/homebrew/bin/node` 等常见路径 |
| `CLAUDE_CODE_ENTRYPOINT` | shim 传给 claude 的标记（内部） | `qwenwork-bridge` |

### 运行日志

每次 shim 启动在 `src/logs/bridge-<pid>-<ts>.log` 落盘（已 .gitignore）：记录 ARGV、ENV（QODER*）、CWD、MODE（internal/real session）、CTRL-UNHANDLED、EXIT。

### 实现步骤（已完成）

1. ✅ **Spy 阶段**：写只记录不改写的 `spy.mjs`，设 `QODER_CLI_PATH=spy.mjs`，重启千问办公走完整任务，产出真实协议样本（`src/logs/spy-*.log`）。
2. ✅ 依据样本校准 spec 的应答表与改写表。
3. ✅ 实现 `src/bridge-shim.mjs`。
4. ✅ 冒烟测试：`src/bridge-shim.test.mjs` 模拟 SDK 验证事件流。
5. ✅ **macOS 平台适配**：新增 `bridge-shim-wrapper.sh`，解决 SDK PATH 限制导致 spawn 失败的问题。
6. 待办：联调（设 `QODER_CLI_PATH` → 重启 app → 全流程验证）。**已部分通过**（单轮会话成功），多轮/技能/回归待补。

## 验收标准

- [x] 自动化测试通过（`node src/bridge-shim.test.mjs`：内部查询 + 真实会话多轮）。
- [x] 千问办公内发送任务：回复流式渲染，无报错弹窗（2026-08-21 14:18 首条 ledger `is_error: false` 会话落地，cost $0.0477，18063ms）。
- [ ] 多轮对话上下文连续（第二轮的 `--resume` 命中同一 claude 会话）。
- [ ] 子代理调用在 UI 显示为 Agent 卡片（Task→Agent 映射生效）。
- [ ] Bash/Edit/Write 等文件操作在 app 工作区可见可查。
- [ ] 主人既有 claude 配置生效（权限允许列表、MCP、skills、CLAUDE.md）。
- [ ] 千问内置 docx/pptx/xlsx/pdf skills 复制到 `~/.claude/skills/` 后可由 claude 调用（Skill 工具触发）。
- [ ] 台账文件 `~/.qwenwork-bridge/ledger.jsonl` 逐次记录 `total_cost_usd`。
- [ ] `pnpm unapply` 后 app 恢复原引擎（回退开关有效）。
- [ ] 千问办公更新到新版本后挂点仍生效（回归检查项）。

## 已知降级（验收时向用户明示）

- 图像生成（ImageGen/ImageSearch）不可用。
- 千问 UI 的「额度/用量」面板无 qoder 数据（由 shim 台账兜底）。
- claude 专属工具（Cron/Workflow/DesignSync/SendMessage 等）在 UI 中显示为通用工具卡片。
- 权限弹窗体验改为 claude 侧配置驱动（shim 对 `can_use_tool` 等请求返回空成功）。

## 实测校准记录（2026-08-21，Spy 阶段样本）

样本归档：`src/logs/spy-*.log`。已用实测校准的要点：

1. **查询分两类**（shim 已按此分治）：
   - 内部查询：`--bare`（模型列表）或 `--disallowed-tools *`（闲置建议）；SDK 传 `--disallowed-tools *` 时同时带 `--tools` 全列表。特征命中即自答。
   - 真实会话：带 `--session-id <uuid>` + `--mcp-config`（qw-builtin 网关）+ cwd=`~\.qwenworkcn\workspace\<chatId>`。
2. **多轮=同进程常驻**：两轮对话 SPAWN 仅 1 次；SDK 不关闭 stdin，CLI 持续处理到 EOF。claude `-p --input-format stream-json` 原生同构（实测 MULTITURN_OK：同 session 两轮 result、上下文连续）。
3. **`initialize` 应答实测形状**：`{commands:[],agents:[],skills:[],output_style:"default",available_output_styles:[],models:[],account:{},capabilities:[interrupt_receipt_v1,interrupt_cancel_queued_v1,msg_lifecycle_v1,session_rewind_v1,background_tasks_v1],pid}`。
4. **`get_models` 应答**：`{models:[{value,displayName,description,modelId,source,isDefault,...}]}`（真实值为 qwork-advanced/qwork-lite 等，带 Credit 描述）。
5. **`can_use_tool` 请求**：`{subtype:"can_use_tool",tool_name,tool_use_id("call_00_..."格式),display_name,description,input}`——app 侧自动放行；claude 不发此类请求（权限由 claude 配置接管）。
6. **CLI→SDK 方向**：`get_model_policy`（app 经 SDK 的 resolveModel 回调应答）、`fetch_job_token`（SDK 应答 JWT）。claude 不发，SDK 不强制。
7. **hooks**：app 经 initialize 传入 hook 定义（`SessionStart/PreToolUse` + `hookCallbackIds`），CLI 触发时走 `hook_callback` control 请求。claude 用自身 hooks 系统，shim 不实现该通道。
8. **user 消息帧**：`{type:"user",session_id,message:{role:"user",content:[{type:"text",text}]}}`；第二轮消息不含历史（上下文靠进程内会话）；可能带 `<system-reminder>`（awareness 记忆 diff），属文本内容自然透传。
9. **`--session-id` 必须合法 UUID**：claude 校验格式（实测非 UUID 报错退出码 1）。
10. **`--mcp-config` 必须透传**：qw-builtin 是 app 本地工具网关（127.0.0.1 端口 + x-api-key）；**丢弃 `--strict-mcp-config`** 让主人既有 MCP（钉钉 DWS 等）共存。
11. **`--settings` 丢弃**（outputStyle/aiCodeStatistics 非 claude 字段）；`--setting-sources` 丢弃（claude 默认 user/project/local）；`--tools` 丢弃（claude 默认全套工具，含主人特色工具）；`--permission-mode default`→不传，`bypassPermissions`→透传。
12. **`--verbose` 追加**：claude 2.x 要求（实测报错「requires --verbose」）。
13. **spy 实验教训**：SDK 对 CLI 的退出码 0/41 语义敏感；spy/shim 被杀（SIGTERM）时需透杀子进程，否则 qoderclicn/claude 变孤儿。
14. **台账**：`~/.qwenwork-bridge/ledger.jsonl` 已实测落盘（`total_cost_usd/num_turns/duration_ms/is_error/result_preview`）。

## 联调校准记录（2026-08-21，真实千问办公联调）

1. **双环境变量必须同时注册**：首次只注册 `QODER_CLI_PATH`（有下划线）时 shim 完全没被调用（`src/logs/` 目录为空）。解包 SDK 发现 App 壳层读 `QODER_CLI_PATH`，SDK 内核 `resolveExecutable()` 读 `QODERCLI_PATH`（无下划线）。两者一并注册后 shim 才被调用（详见 DECISIONS.md D6）。
2. **`binaryPathComputed` 缓存**：App 启动时计算一次 CLI 路径后缓存，**必须杀干净所有 QwenWorkCN 进程完全重启**才能重读环境变量（DECISIONS.md D6 的更准确理解）。
3. **claude 必须绝对路径**：shim 首次 spawn 时日志报 `spawn claude ENOENT`，千问办公进程的 PATH 不含 npm 全局 bin 目录。改为绝对路径（Windows: `%APPDATA%\npm\...\claude.exe`；macOS: 自动探测）后成功（详见 DECISIONS.md D7）。
4. **macOS PATH 限制**：SDK 的 `buildQoderAgentSdkRuntimeEnv` 把 PATH 硬编码为 `/usr/bin:/bin:/usr/sbin:/sbin`，不含 `/opt/homebrew/bin`，导致 `.mjs` 文件 spawn 时报 "executable not found"。新增 shell wrapper 探测 node 绝对路径后解决（详见 DECISIONS.md D8）。
5. **首条成功会话**：sessionId `bfce2bb1-862a-4141-9229-3cca29fe6d6f`，cost $0.047655，1 turn，18063ms，`is_error: false`。

### 已通过的自测（src/bridge-shim.test.mjs）

- 内部查询：initialize+get_models 应答、exit 0 ✓
- 真实会话两轮：initialize 应答 → user×2 → result×2（同 session）→ exit 0，init 注入 protocol_version ✓
