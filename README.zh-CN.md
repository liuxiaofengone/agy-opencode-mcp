# Antigravity OpenCode Delegate (`agy-opencode-mcp`)

[English](README.md) | **简体中文**

适用于 **Antigravity (`agy`)** 的原生插件与 Stdio MCP 桥接器：让 Antigravity 专注于需求规划、`git diff` 审查与独立验收，同时将只读代码库分析与有明确边界的开发任务委派给本机 **OpenCode 2**（`opencode`）执行。

本项目由 [liuxiaofengone/opencode-mcp](https://github.com/liuxiaofengone/opencode-mcp)（上游 fork 自 [yuriisamohvalov-creator/opencode-mcp](https://github.com/yuriisamohvalov-creator/opencode-mcp)）移植而来，完整保留 MIT 协议与上游版权归属（见 [NOTICE.md](NOTICE.md)）。

## 项目核心特点

- **职责清晰分离**：Antigravity 负责规范制定、方案拆解、代码审查与最终验收；本机 OpenCode 2 在隔离的 `--format json` 会话中执行受控任务，并返回结构化结果与 Git 变更摘要（`diffStat`、`statusShort`）。
- **原生 Antigravity 插件包（`plugins/opencode-delegate/`）**：内置 [plugin.json](plugins/opencode-delegate/plugin.json)、[mcp_config.json](plugins/opencode-delegate/mcp_config.json)（`${PLUGIN_ROOT}/mcp/server.mjs`，`timeoutSeconds: 3660`）、[assets/logo.svg](plugins/opencode-delegate/assets/logo.svg) 以及适配 Antigravity 协同规范的 [SKILL.md](plugins/opencode-delegate/skills/opencode-delegate/SKILL.md) 与 [reference.md](plugins/opencode-delegate/skills/opencode-delegate/reference.md)。
- **免安装单文件 `esbuild` 产物**：[build-plugin.mjs](scripts/build-plugin.mjs) 将 `server.mjs` 与 `src/` 打包为 `plugins/opencode-delegate/mcp/server.mjs` 并纳入 Git 跟踪，用户安装插件后无需 `npm install` 即可离线运行。
- **全量懒加载与 Schema 兼容**：全部 6 个工具（`opencode_doctor`、`opencode_models`、`opencode_status`、`opencode_execute`、`opencode_start`、`opencode_cancel`）均通过 `call_mcp_tool` 懒加载调用（[mcp_config.json](plugins/opencode-delegate/mcp_config.json) 刻意不配置 `"eager": true`，避免 Antigravity 丢弃工具），且所有整型 schema 上限严格控制在 32 位有符号整数范围内。
- **强制显式模型选择与本机目录查询**：每次 `opencode_execute` / `opencode_start` 都必须传入完整的 `provider/model[#variant]`（缺失或格式错误会在启动 CLI 前以 `MODEL_REQUIRED` / `MODEL_INVALID` 拒绝，绝不使用默认模型或免费模型兜底）。可通过 `opencode_models` 先列出本机已配置模型供用户选择。
- **默认只读与会话隔离**：默认 `readOnly: true`、`standalone: true`、`autoApprove: false`，通过 `OPENCODE_CONFIG_CONTENT` 注入隔离只读代理 `agy-mcp-reader`（同时覆盖新旧权限字段，拒绝 `edit`、`write`、`patch`、`bash`、`shell`、`task`、`external_directory`、`webfetch`、`websearch`）。禁用会话续接（`sessionId`、`continueSession: true` 均会被拒绝），确保每次调用的 `cwd` 与权限生效。*（注：OpenCode 权限并非 OS 级沙箱，仍需在任务描述中排除 `.env`、私钥等敏感文件。）*
- **无 Shell 启动、凭据脱敏与进程树清理**：始终以 `shell: false` 启动本机原生可执行文件，拒绝将 `.cmd`/`.bat`/`.ps1` 包装脚本作为 `OPENCODE_BIN`；对输出和错误中的 `server password`、`Bearer`、API Key 等凭据自动脱敏并限制行/文本/stderr 长度；在超时、取消或 MCP 断连时强杀所属进程树（Windows 使用 `taskkill.exe /T /F`，POSIX 使用进程组 `SIGTERM`/`SIGKILL`）。
- **后台异步任务生命周期管理**：`opencode_start`、`opencode_status`、`opencode_cancel` 支持最多 4 个并发后台任务（内存中保留最近 50 条已结束任务结果），并持续更新 `elapsedMs` 与 `lastEventAgeMs`，帮助区分模型思考/工具调用与真正卡死。
- **零依赖插件校验器与跨平台测试**：[validate-plugin.mjs](scripts/validate-plugin.mjs) 零第三方依赖校验清单版本、UTF-8 BOM、`${PLUGIN_ROOT}` 相对路径、防符号链接/目录联接逃逸及机器路径泄漏；仓库附带 49 项自动化测试及 Linux / Windows / macOS（Node 22 & 24）CI 矩阵。

## MCP 工具一览

| 工具名 | 加载方式 | 用途说明 | 关键说明 |
| --- | --- | --- | --- |
| `opencode_doctor` | Lazy | 检查本机 OpenCode 原生二进制路径、`--version`，可选 `deep: true` 探测模型目录 | 纯只读诊断；拒绝 `.cmd`/`.bat`/`.ps1` |
| `opencode_models` | Lazy | 通过 `opencode models --standalone` 列出并去重 `provider/model` ID | 支持 `provider` 前缀过滤；不触发推理 |
| `opencode_status` | Lazy | 查询后台任务状态（`running` / `cancelling` / `completed` / `failed` / `cancelled`） | 实时更新 `elapsedMs` 与 `lastEventAgeMs` |
| `opencode_execute` | Lazy | 在全新会话中同步执行有明确边界的任务 | 必填 `task`、`cwd`、`model`；默认超时 `900000` ms |
| `opencode_start` | Lazy | 启动后台任务并立即返回 `jobId` | 最多 4 个并发；配合 `opencode_status` 轮询 |
| `opencode_cancel` | Lazy | 中止指定后台任务并清理其本地进程树 | 需持续轮询 `opencode_status` 至 `cancelled` |

## 环境要求

- **Node.js >= 22**
- **Antigravity（`agy` CLI）**
- 本机已安装 **OpenCode 2.x** 并配置好可用模型服务（可通过 `opencode --version`、`opencode models` 验证）

## 安装插件

Windows PowerShell：

```powershell
git clone https://github.com/liuxiaofengone/agy-opencode-mcp.git
Set-Location agy-opencode-mcp
agy plugin validate ./plugins/opencode-delegate --strict
agy plugin install ./plugins/opencode-delegate
agy plugin list --json
```

> **Windows 目录联接（junction）说明**：如果本地仓库位于目录联接路径下（导致 `agy plugin install` 报路径/重命名错误），请直接将 `plugins/opencode-delegate` 复制到 `~/.gemini/config/plugins/opencode-delegate`，随后运行 `agy plugin validate ~/.gemini/config/plugins/opencode-delegate --strict` 确认通过。

如果未能自动找到 OpenCode 原生可执行文件，请在已安装插件的 `mcp_config.json` 中将 `env.OPENCODE_BIN` 设为**原生可执行文件的绝对路径**（例如 `%APPDATA%\npm\node_modules\@opencode\cli\bin\opencode.exe`，拒绝 `.cmd`/`.bat`/`.ps1` 包装脚本）。

安装或修改 `mcp_config.json` 后，请刷新 MCP 服务（或重启 Antigravity）并开启**新的 Antigravity 对话**，然后先运行 `opencode_doctor({ deep: true })` 检查运行环境。

## 仓库结构

```text
agy-opencode-mcp/
├── server.mjs                          # 标准 Stdio MCP 服务端入口
├── src/
│   ├── runner.mjs                      # 二进制解析、只读配置注入、进程树与 Git 上下文执行器
│   ├── jobs.mjs                        # 有界异步任务管理器（并发上限、状态轮询与淘汰）
│   ├── events.mjs                      # 流式 NDJSON 事件解析器（含行长/文本截断保护）
│   └── version.mjs                     # 兼容源码与打包产物的版本号读取
├── plugins/opencode-delegate/
│   ├── plugin.json                     # Antigravity 插件清单
│   ├── mcp_config.json                 # MCP 配置（${PLUGIN_ROOT}/mcp/server.mjs，懒加载）
│   ├── mcp/server.mjs                  # 纳入 Git 跟踪的 esbuild 单文件产物
│   ├── assets/logo.svg                 # 插件图标
│   └── skills/opencode-delegate/       # 委派规则（SKILL.md）与参考手册（reference.md）
├── scripts/
│   ├── build-plugin.mjs                # 使用 esbuild 构建 plugins/opencode-delegate/mcp/server.mjs
│   ├── validate-plugin.mjs             # 零依赖插件契约校验脚本
│   └── smoke.mjs                       # 面向临时目录的真实模型可选冒烟测试
└── test/                               # Node 原生测试套件（49 项测试）
```

## 开发与验证

```powershell
npm install
npm run build:plugin
npm test
npm run validate:plugin
agy plugin validate ./plugins/opencode-delegate --strict --json
```

可选真实模型冒烟测试（仅读写临时测试目录，需显式传入授权模型）：

```powershell
npm run test:live -- your-provider/your-model
```

## 常见问题排查

- **`MODEL_REQUIRED` / `MODEL_INVALID`**：必须显式传入完整的 `provider/model`（或 `provider/model#variant`），不能留空或包含空格；不确定可用模型时先调用 `opencode_models`。
- **`opencode_doctor` 报 `agent.found: false`**：未找到本机原生可执行文件，或 `OPENCODE_BIN` 指向了 `.cmd`/`.bat`/`.ps1` 包装脚本；请改为原生 `opencode.exe`（或 POSIX `opencode`）的绝对路径。
- **Antigravity 中部分工具未启用或不可见**：检查 Antigravity 插件工具开关、刷新 MCP 服务并开启新对话，使最新的 `mcp_config.json` 与工具 Schema 生效。
- **长耗时任务超时**：请改用 `opencode_start` + `opencode_status` 异步轮询；遇到宿主中断时先检查 `git status` 与 `git diff`，切勿盲目重复派发。
