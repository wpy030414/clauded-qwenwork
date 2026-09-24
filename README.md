# clauded-qwenwork

把千问办公（QwenWorkCN）的 Agent 引擎替换为 Claude Code 的桥接工程。

## 这个项目是什么？

千问办公（`QwenWorkCN`，阿里出品的 Electron 办公应用，`C:\Program Files\QwenWorkCN`）自带一套本地 Agent 引擎（`qoderclicn.exe` CLI + `@qoder-ai/qoder-agent-sdk` + worker runtime）。本项目的目标是：**保留千问办公的 UI 界面，把任务执行与计费全部改道 Claude Code**。

## 为什么存在？

千问办公的 UI（文档 / 表格 / PPT / 技能卡片 / 任务展示）体验不错，但其 Agent harness 能力弱。Claude Code 的 harness（工具、技能、MCP、权限、会话管理）更强，且计费透明。两者协议同构（qoder CLI 是 Claude Code CLI 的 fork），让替换成为可能。

## 当前状态

- 2026-08-21：**探索完成 + 首版实现 + 端到端联调通过**。bridge shim 已编写（`src/bridge-shim.mjs`），注册/撤销工具已就绪（`src/index.mjs`），支持 Windows 和 macOS 双平台。自动化测试与真实千问办公联调均已通过（ledger 首条 `is_error: false` 会话落地）。
- 2026-08-22：macOS 注入方式从 LSEnvironment 升级为 LaunchAgent（`~/Library/LaunchAgents` plist + `launchctl setenv`），与 App 本体解耦，千问办公升级不再破坏注入链路。
- 2026-09-24：bridge shim 升级至 v2——双向控制协议桥接（claude 原生 control_request 直接转发，权限弹窗/上下文仪表盘等成为真功能）、参数应翻译尽翻译、Windows 命令行长度限制规避（超长 systemPrompt/mcp-config 写入临时文件用 `--*-file` 语法传入）、会话语义适配（D11：`--session-id`/`--resume` 按 cwd 查 claude 会话文件互转）。
- Spy 阶段已完成，协议样本已用于校准实现。
- 待持续验证：技能复用、多轮会话稳定性、千问办公新版本回归。

## 如何安装和运行

### 前提

- 已安装千问办公（Windows: `C:\Program Files\QwenWorkCN`，macOS: `/Applications/QwenWorkCN.app`）并能正常登录使用。
- 已安装 Claude Code CLI 且 `claude` 命令在 `PATH` 中可用（或通过 `QODER_BRIDGE_CLAUDE` 环境变量指定路径）。
- Node.js 已安装（用于执行 shim 脚本）。
- pnpm 已安装。

### 步骤

```bash
# 1. 安装依赖
pnpm install

# 2. 注册环境变量
#    Windows: 写入 HKCU\Environment 注册表并广播变更
#    macOS:   写 ~/Library/LaunchAgents plist（登录时自动 setenv）+ launchctl setenv 即时生效
pnpm apply

# 3. 重启千问办公，所有 Agent 查询即走 Claude Code
```

撤销（恢复原引擎）：

```bash
pnpm unapply
```

### 环境变量（可选）

| 变量 | 说明 |
|---|---|
| `QODER_BRIDGE_CLAUDE` | 覆盖 `claude` 可执行文件路径（默认走 `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`，因千问办公进程的 `PATH` 通常不含 npm 全局目录） |
| `QODER_BRIDGE_NODE` | **macOS 专用**：覆盖 `node` 可执行文件路径（默认走 `/opt/homebrew/bin/node`，因千问办公进程的 `PATH` 通常不含 Homebrew 目录） |
| `QODER_BRIDGE_MODEL` | 强制指定 claude 模型别名（默认不指定，由 claude 自行选择） |

> **踩坑提示** 若首次 `pnpm apply` 后千问办公仍走原引擎，请确认两件事：
> 1. 杀干净所有 `QwenWorkCN` 进程再启动（app 有 `binaryPathComputed` 缓存，仅完全重启才会重读环境变量）；
> 2. shim 的 `src/logs/` 目录若为空 = shim 从未被调用，说明环境变量没生效（Windows: 用 `reg query HKCU\Environment` 核对；macOS: 用 `launchctl getenv QODER_CLI_PATH` 核对，并确认 `~/Library/LaunchAgents/com.clauded.qwenwork-bridge.plist` 存在）。
>
> **关于千问办公升级**：LaunchAgent（macOS）/ 注册表（Windows）与 App 本体解耦，千问办公版本升级不会破坏注入链路；升级后若失效，原因是 App 不再读 `QODER_CLI_PATH`/`QODERCLI_PATH` 这两个挂点（与注入方式无关），跑一次 `pnpm apply` + 看 `src/logs/` 即可确认。
>
> **macOS 平台特殊说明**：千问办公的 `PATH` 环境变量被限制为 `/usr/bin:/bin:/usr/sbin:/sbin`，不含 `/opt/homebrew/bin`，因此 shell wrapper（`src/bridge-shim-wrapper.sh`）会显式查找 node 和 claude 的完整路径。

## 核心技术

- Electron 应用逆向（asar 解包分析）
- `@qoder-ai/qoder-agent-sdk`（1.0.46）JSONL 流协议 + control_request 控制协议（wire protocol 1.5.0）
- Claude Code CLI 2.1.278 `--output-format stream-json` 协议
- Node.js 翻译层（参数翻译 / 双向控制协议桥接 / 事件改写 / 成本台账）
- **Windows**: 注册表 `HKCU\Environment` 用户级环境变量 + `WM_SETTINGCHANGE` 广播
- **macOS**: LaunchAgent（`~/Library/LaunchAgents` plist 登录时 `launchctl setenv` 自动注入，重启电脑不失效）+ shell wrapper 绕过 PATH 限制
