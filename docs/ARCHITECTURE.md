# ARCHITECTURE — 千问办公内部结构解剖与换芯架构

回答「系统整体是如何组织的」。

## 一、现状解剖（2026-08-21 实测）

### 1. 安装布局

```
C:\Program Files\QwenWorkCN\
├── Launcher.exe          # 启动器（多版本管理）
├── Updater.exe           # 更新器（Squirrel 风格）
├── updater.cfg           # 当前版本 0.1.8-26081406
└── 0.1.8-26081406\       # 版本目录（历史版本保留：0.1.6/0.1.7）
    ├── QwenWorkCN.exe    # Electron 主程序（204MB）
    ├── resources\
    │   ├── app.asar      # 154MB 应用代码（已解包分析）
    │   ├── app.asar.unpacked\node_modules\   # 原生模块（117MB）
    │   ├── bin\          # qoderclicn.exe / qoderclicn-legacy.exe / qwenwork.exe / 辅助 exe
    │   ├── skills\       # 内置技能：create-skill docx find-skills media-generation pdf
    │   │                 #   plugin-creator pptx qw-pages qw-pages-supabase
    │   │                 #   qwenwork-guidance xlsx（均为 SKILL.md + toolkit）
    │   ├── commands\     # create-command.md（slash 命令）
    │   ├── legokits\     # 插件体系（plugin-market-data.json）
    │   ├── vm-boot\      # 沙箱引导
    │   └── ...
```

用户数据：`%APPDATA%\QwenWorkCN\`、`~/.qoder-cn\`（CLI 配置目录，等价 `~/.claude`）、`~/.qwenworkcn\`。

### 2. Agent 引擎三层结构（替换目标）

```
out/main/index.js（Electron 主进程，打包为 out/main/main.js）
   └─ @qoder-ai/qoder-agent-sdk（asar 内 node_modules，npm:@ali/qoder-agent-sdk-next@1.0.20）
        ├─ 默认：WorkerFallbackTransport → 加载 worker runtime 到 worker_threads 进程内执行
        └─ 设置 QODER_CLI_PATH 后：ProcessTransport → spawn 外部 CLI 二进制，JSONL 流通信
             └─ qoderclicn.exe v1.1.18（resources\bin，bun 编译，Claude Code CLI 的 fork）
                  └─ qoder-worker-runtime.obf.mjs（36MB 混淆：agent 循环/工具/skills/MCP/hooks）
```

### 3. 协议面（SDK ↔ CLI）

- 启动参数：`--print --output-format stream-json --input-format stream-json [--include-partial-messages]`，
  叠加 `--model --resume/--continue/--session-id --fork-session --permission-mode --yolo/--dangerously-skip-permissions --allowed-tools --disallowed-tools --tools --mcp-config --strict-mcp-config --allowed-mcp-server-names --settings --setting-sources --plugin-dir --add-dir --max-turns --agent --debug --no-session-persistence --extensions --permission-prompt-tool` 等。
- 双向 JSONL：stdin = control_request 帧 + 用户消息；stdout = `system/init`（握手）、`assistant`、`user`、`result`、`control_response` 等事件。
- 握手：`system/init.protocol_version`（SDK 1.0.46 内置 1.5.0，major 必须为 1；缺省仅警告）；`capabilities` 数组（如 `background_tasks_v1`）。
- 控制协议（control_request/control_response，qoder 特有，claude 原生支持部分子类型）：
  - **claude 原生支持**（v2 直接转发）：`initialize`、`set_permission_mode`、`set_model`、`get_context_usage`、`interrupt`、`stop_task`、`cancel_async_message`、`background_tasks`、`mcp_set_servers`、`mcp_toggle`、`mcp_reconnect`、`mcp_authenticate`、`apply_flag_settings`、`seed_read_state`。
  - **shim 合成应答**：`get_models`、`generate_session_title`、`account_info`、`get_usage_info`、`can_use_tool`（claude 不发，SDK 侧自动放行）等。
  - **双向桥接**：claude 发出的 `control_request`（如 `can_use_tool` 权限弹窗）→ 转给 SDK，SDK 应答经 stdin 回流 claude。
- 退出码语义：41 = 认证过期（触发 app 重新登录），0 = 正常。

### 4. App 实际使用面（main.js 中确认）

- 三类查询：主对话（query-runtime）、闲置建议生成（`disallowedTools:["*"]`）、内部意图分类（tool-budget / command-intent，`tools:[]`、`maxTurns:1`）——全部经同一 transport 工厂，`QODER_CLI_PATH` 一设全接管。
- 使用的 SDK 能力：`resolveModel`(14)、`stopTask`(12)、`getContextUsage`(5)、`getAvailableModels`(4)、`setPermissionMode`(3)、`generateSessionTitle`(3)、`canUseTool`(1)。
- app 对 result 事件消费：`duration_ms`(59)、`is_error`(17)、`num_turns`(2)；不读 `total_cost_usd`（成本展示来自 qoder 云端用量接口）。
- renderer 按 qoder 工具名渲染卡片：`Agent`(260)、`ImageGen`(5)、`TaskCreate`(3)、`ImageSearch`(2)。

### 5. qoder CLI 与 Claude CLI 差异清单（shim 必读）

| 类别 | 说明 |
|---|---|
| 必加参数 | claude 2.x 要求 `--output-format stream-json` 必须配 `--verbose`（qoder 不需要） |
| qoder 特有参数（需过滤） | `--caller-version --ide-type --session-mirror --porcelain --keep-data --workdir --org-id --email --extensions --disable-builtin-skills --permission-prompt-tool --yolo --max-turns --tools`（空串形式） |
| 直接兼容参数 | `--print --output-format --input-format --include-partial-messages --resume --continue --fork-session --session-id --permission-mode --dangerously-skip-permissions --allowed-tools --disallowed-tools --mcp-config --strict-mcp-config --allowed-mcp-server-names --settings --plugin-dir --add-dir --model --agent --debug --no-session-persistence --bare` |
| 参数值翻译 | `--permission-mode bypassPermissions` ↔ `bypassPermissions`（claude 同词）；app 传 `--setting-sources ""`（空）→ shim 应丢弃，让 claude 加载用户/项目设置；model 名 qwen-* → claude 别名 |
| 工具名映射 | claude `Task`（子代理）→ qoder `Agent`；claude `TodoWrite` → qoder `TaskCreate`；qoder `ImageGen/ImageSearch` 无对应（缺失） |
| 事件差异 | claude `system/init` 无 `protocol_version` → shim 注入 `protocol_version:"1.5.0"`；`capabilities` claude 自带 |
| 控制协议 | claude 原生支持部分 control_request（initialize/set_permission_mode/set_model/get_context_usage/interrupt 等）→ v2 直接转发；其余由 shim 合成应答 |
| 输入格式 | SDK 的 stdin 消息含 `uuid/session_id` 等附加字段，claude 容忍多余字段 |
| 会话语义 | qoder `--session-id` 幂等、`--resume` 容错；claude 语义相反 → shim 按 cwd 查会话文件互转（D11） |
| 命令行长度 | Windows CreateProcess 限制 32767 字符 → 超长 systemPrompt/mcp-config 写入临时文件用 `--*-file` 语法传入（D12） |

## 二、换芯后架构（当前实现态 v2，2026-09-24）

```
千问办公 UI（不变）
   └─ Electron 主进程（不变，asar 不动）
        └─ qoder-agent-sdk 1.0.46 ProcessTransport
             （环境变量 QODER_CLI_PATH + QODERCLI_PATH 双注册触发；App 壳层读前者作为
              options.pathToQoderCLIExecutable 传 SDK，优先级最高；SDK 内核备用读后者）
             ├─ Windows: node src/bridge-shim.mjs（SDK 自动识别 .mjs 后缀，用 node 执行）
             └─ macOS:   src/bridge-shim-wrapper.sh → node src/bridge-shim.mjs
                  ├─ 参数翻译/过滤 → spawn claude（Windows: %APPDATA%\npm\...\claude.exe
                  │   macOS: /opt/homebrew/bin/claude，可被 QODER_BRIDGE_CLAUDE 覆盖）
                  ├─ stdin：双向控制协议桥接（v2 方针）
                  │   ├─ claude 原生支持的 control_request（initialize/set_permission_mode/
                  │   │   set_model/get_context_usage/interrupt/stop_task/mcp_* 等）直接转发
                  │   ├─ claude 不支持的由 shim 合成应答兜底（get_models/generate_session_title/
                  │   │   account_info/get_usage_info 等）
                  │   ├─ claude 发出的 control_request（can_use_tool 权限弹窗等）→ 转给 SDK，
                  │   │   SDK 应答经 stdin 回流 claude（双向透明）
                  │   └─ 用户消息帧原样透传
                  ├─ stdout：claude stream-json 事件改写（init 注入 protocol_version 1.5.0、
                  │   工具名映射 Task→Agent）后回流 SDK
                  ├─ 内部查询（--tools "" / --disallowed-tools *）：本地自答，不 spawn claude
                  ├─ 会话语义适配（D11）：--session-id/--resume 按 cwd 查 ~/.claude/projects/
                  │   <slug>/<id>.jsonl 是否存在来互转（qoder 幂等 vs claude 互斥）
                  ├─ Windows 命令行长度规避（D12）：超长 systemPrompt/appendSystemPrompt/
                  │   mcp-config 写入 %TEMP% 临时文件，用 --*-file 语法传入
                  ├─ cwd 策略：继承 SDK 传入 cwd（app 工作区目录）
                  ├─ 成本台账：每次 result.total_cost_usd 记入 ~/.qwenwork-bridge/ledger.jsonl
                  └─ 黑匣子（D14）：uncaughtException/unhandledRejection/stderr 完整落盘
```

### 辅助工具

```
src/index.mjs（pnpm apply / pnpm unapply，跨平台）
   ├─ Windows:
   │   ├─ apply：reg add HKCU\Environment /v QODER_CLI_PATH + QODERCLI_PATH → src/bridge-shim.mjs 绝对路径
   │   │         + WM_SETTINGCHANGE 广播（PowerShell P/Invoke SendMessageTimeout）
   │   └─ unapply：reg delete → 广播 → 千问办公重启后恢复原引擎
   └─ macOS:
       ├─ apply：写 ~/Library/LaunchAgents/com.clauded.qwenwork-bridge.plist（RunAtLoad 登录时 setenv）
       │         + launchctl setenv 即时生效（QODER_CLI_PATH + QODERCLI_PATH → bridge-shim-wrapper.sh 绝对路径）
       └─ unapply：launchctl unsetenv ×2 + 删除 plist → 千问办公重启后恢复原引擎

src/bridge-shim-wrapper.sh（macOS 专用 shell wrapper）
   ├─ 被 QODER_CLI_PATH 指向（替代 .mjs 文件）
   ├─ 探测 node 绝对路径（/opt/homebrew/bin/node 等），绕过 SDK PATH 限制
   └─ exec node bridge-shim.mjs 启动真正的翻译层
```

### 数据流（一次任务，v2 双向桥接）

1. 用户在 UI 发送消息 → renderer → IPC → main.js → SDK `query()`。
2. SDK 构造参数 → spawn `node src/bridge-shim.mjs --print --output-format stream-json ...`。
3. shim 解析参数，判定查询类型：
   - **内部查询**（`--tools ""` / `--disallowed-tools *`）→ 本地自答 `initialize` + `get_models` 后等 stdin EOF 退出，不 spawn claude。
   - **真实会话** → 过滤 qoder 参数、补 `-p --verbose`、会话语义适配（D11：`--session-id`/`--resume` 互转）、超长参数写入临时文件（D12：`--system-prompt-file`/`--mcp-config` 文件路径）→ spawn `claude`（优先 `QODER_BRIDGE_CLAUDE`，回退绝对路径），附带 `CLAUDE_CODE_ENTRYPOINT=qwenwork-bridge`。
4. SDK 经 stdin 先发 `control_request(initialize)` 帧 → shim 延迟 spawn claude，把 initialize 携带的 `systemPrompt`/`appendSystemPrompt`/`promptSuggestions` 翻译成 CLI 旗标后再 spawn。
5. **双向控制协议桥接**：
   - SDK → claude 方向：`FORWARD_NATIVE` 集合命中的请求（initialize/set_permission_mode/set_model/get_context_usage/interrupt 等）直接转发给 claude，claude 的 `control_response` 原样回传 SDK；未命中的由 shim 合成应答兜底。
   - claude → SDK 方向：claude 发出的 `control_request`（如 `can_use_tool` 权限弹窗）→ 转给 SDK，SDK 应答经 stdin 回流 claude。
6. 用户消息帧透传 → claude 处理 → stdout 事件流 → shim 改写（注入 protocol_version 1.5.0、Task→Agent）→ SDK → main.js → renderer 渲染（文本流、工具卡片、结果）。
7. claude 退出码 0 → shim 退出 0 → SDK 正常收尾；`result` 事件携带 `total_cost_usd` 由 shim 记台账。
8. 异常路径：uncaughtException/unhandledRejection/spawn 失败/子进程 stderr 完整落盘 `src/logs/bridge-<pid>-<ts>.log`（D14）。

### 外部系统

- Claude API / 主人已有的 Claude 登录态（计费通道，不变）。
- 千问办公云端（登录、账号、office 能力）仍走原通道，仅 Agent 执行改道。
- 主人已有的 claude 配置（`~/.claude/settings.json`、MCP、skills、hooks、permissions）在 claude 侧自动生效。
- qw-builtin MCP 网关（千问办公本地工具，127.0.0.1 端口）经 `--mcp-config` 透传给 claude。
