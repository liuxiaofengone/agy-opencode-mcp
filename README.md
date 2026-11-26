# Antigravity OpenCode Delegate (`agy-opencode-mcp`)

**English** | [简体中文](README.zh-CN.md)

An **Antigravity (`agy`)** native plugin and stdio MCP bridge that delegates read-only codebase analysis and bounded development tasks to local **OpenCode 2** (`opencode`), while Antigravity retains specification, planning, `git diff` review, and independent verification.

Ported from [liuxiaofengone/opencode-mcp](https://github.com/liuxiaofengone/opencode-mcp) (originally forked from [yuriisamohvalov-creator/opencode-mcp](https://github.com/yuriisamohvalov-creator/opencode-mcp), preserving the MIT license and upstream attribution in [NOTICE.md](NOTICE.md)) specifically for **Antigravity**.

## Key Characteristics

- **Clear Responsibility Split**: Antigravity acts as planner, reviewer, and verifier; local OpenCode 2 runs as a bounded executor inside an isolated session (`--format json`) and returns structured results with Git context (`diffStat`, `statusShort`).
- **Native Antigravity Plugin (`plugins/opencode-delegate/`)**: Ships [plugin.json](plugins/opencode-delegate/plugin.json), [mcp_config.json](plugins/opencode-delegate/mcp_config.json) (`${PLUGIN_ROOT}/mcp/server.mjs`, `timeoutSeconds: 3660`), [assets/logo.svg](plugins/opencode-delegate/assets/logo.svg), and the [opencode-delegate skill](plugins/opencode-delegate/skills/opencode-delegate/SKILL.md) with [reference.md](plugins/opencode-delegate/skills/opencode-delegate/reference.md).
- **Zero-Install Single-File Bundle**: [build-plugin.mjs](scripts/build-plugin.mjs) bundles `server.mjs` and `src/` with `esbuild` into `plugins/opencode-delegate/mcp/server.mjs` (tracked in Git), so the plugin runs offline without `npm install`.
- **Lazy Tool Loading & Gemini Schema Compatibility**: All 6 tools (`opencode_doctor`, `opencode_models`, `opencode_status`, `opencode_execute`, `opencode_start`, `opencode_cancel`) are lazy-loaded via `call_mcp_tool` ([mcp_config.json](plugins/opencode-delegate/mcp_config.json) intentionally avoids `"eager": true` so Antigravity does not drop tools from the enabled set), and all integer schema bounds stay within 32-bit signed limits.
- **Mandatory Explicit Model Gate**: Every `opencode_execute` and `opencode_start` call requires a complete `provider/model[#variant]` ID (`MODEL_REQUIRED` / `MODEL_INVALID` rejects missing or malformed IDs before spawning). Use `opencode_models` to inspect configured models first—there is no silent default or fallback model selection.
- **Read-Only & Isolation Defaults**: Defaults to `readOnly: true`, `standalone: true`, and `autoApprove: false`, injecting an isolated `agy-mcp-reader` agent via `OPENCODE_CONFIG_CONTENT` (overriding both legacy and native permission fields to deny `edit`, `write`, `patch`, `bash`, `shell`, `task`, `external_directory`, `webfetch`, and `websearch`). Session continuation (`sessionId`, `continueSession: true`) is rejected so `cwd` and permissions remain authoritative. *(Note: OpenCode permissions are application-level controls, not an OS sandbox; exclude sensitive files such as `.env` or private keys in task briefs.)*
- **Shell-Free Execution, Redaction & Process-Tree Cleanup**: Never spawns OpenCode through a shell (`shell: false`) and rejects `.cmd`/`.bat`/`.ps1` wrappers for `OPENCODE_BIN`. Redacts common credentials (`server password`, `Bearer` tokens, API keys/passwords) from output and errors, caps stdout line/text/stderr buffers, and terminates owned process trees (`taskkill.exe /T /F` on Windows; process-group `SIGTERM`/`SIGKILL` on POSIX) on timeout, cancellation, or MCP disconnect.
- **Async Background Job Lifecycle**: `opencode_start`, `opencode_status`, and `opencode_cancel` support up to 4 concurrent background jobs (retaining up to 50 terminal results in memory) with live `elapsedMs` and `lastEventAgeMs` progress tracking to distinguish long thinking/tool calls from hangs.
- **Portable Validator & Cross-Platform Test Suite**: [validate-plugin.mjs](scripts/validate-plugin.mjs) runs with zero third-party dependencies to verify manifest semver, UTF-8 BOM hygiene, `${PLUGIN_ROOT}` relative paths, symlink/junction escapes, and absence of leaked user paths, backed by 49 automated tests and a Linux/Windows/macOS CI matrix (Node 22 & 24).

## MCP Tools Overview

| Tool | Loading | Purpose | Key Notes |
| --- | --- | --- | --- |
| `opencode_doctor` | Lazy | Verify native OpenCode binary, `--version`, and optional `deep: true` model catalog probe | Read-only; rejects `.cmd`/`.bat`/`.ps1` wrappers |
| `opencode_models` | Lazy | List deduplicated `provider/model` IDs via `opencode models --standalone` | Supports `provider` prefix filter; invokes no LLM |
| `opencode_status` | Lazy | Poll async job state (`running`, `cancelling`, `completed`, `failed`, `cancelled`) and live progress | Reports `elapsedMs` and `lastEventAgeMs` |
| `opencode_execute` | Lazy | Run a bounded task synchronously in a fresh session | Requires `task`, `cwd`, `model`; default `timeoutMs: 900000` (max `3600000`) |
| `opencode_start` | Lazy | Start an async background job and return `jobId` immediately | Max 4 active jobs; poll `opencode_status` |
| `opencode_cancel` | Lazy | Abort an active job and terminate its owned process tree | Poll `opencode_status` until `cancelled` |

## Prerequisites

- **Node.js >= 22**
- **Antigravity (`agy` CLI)**
- **Local [OpenCode 2](https://opencode.ai/)** installed with at least one configured model provider (verify with `opencode --version` and `opencode models`)

## Install From Git

```powershell
git clone https://github.com/liuxiaofengone/agy-opencode-mcp.git
Set-Location agy-opencode-mcp
agy plugin validate ./plugins/opencode-delegate --strict
agy plugin install ./plugins/opencode-delegate
agy plugin list --json
```

> **Windows directory junction note:** If the repository checkout sits under a directory junction (causing `agy plugin install` to fail with path/rename errors), copy `plugins/opencode-delegate` directly to `~/.gemini/config/plugins/opencode-delegate` and verify with `agy plugin validate ~/.gemini/config/plugins/opencode-delegate --strict`.

If OpenCode is not discovered automatically, set `OPENCODE_BIN` in the installed plugin's `mcp_config.json` (`env.OPENCODE_BIN`) to the **native executable absolute path** (never a `.cmd`, `.bat`, or `.ps1` wrapper).

After installing or updating `mcp_config.json`, refresh MCP servers (or restart Antigravity) and open a **new Antigravity chat**, then run `opencode_doctor({ deep: true })` to verify the OpenCode binary and model catalog.

## Repository Structure

```text
agy-opencode-mcp/
├── server.mjs                          # Canonical stdio MCP server entrypoint
├── src/
│   ├── runner.mjs                      # Executable discovery, read-only config injection, process & git runner
│   ├── jobs.mjs                        # Bounded async job manager (start/status/cancel/prune)
│   ├── events.mjs                      # Streaming NDJSON event parser with line/text overflow bounds
│   └── version.mjs                     # Package/plugin version resolver
├── plugins/opencode-delegate/
│   ├── plugin.json                     # Antigravity plugin manifest
│   ├── mcp_config.json                 # MCP config (${PLUGIN_ROOT}/mcp/server.mjs, lazy loading)
│   ├── mcp/server.mjs                  # Tracked single-file esbuild bundle
│   ├── assets/logo.svg                 # Plugin icon
│   └── skills/opencode-delegate/       # Delegation rules (SKILL.md) & reference (reference.md)
├── scripts/
│   ├── build-plugin.mjs                # esbuild bundler for plugins/opencode-delegate/mcp/server.mjs
│   ├── validate-plugin.mjs             # Zero-dependency Antigravity plugin contract validator
│   └── smoke.mjs                       # Opt-in live smoke test against a temporary fixture directory
└── test/                               # Node built-in test suite (49 tests)
```

## Development & Verification

```powershell
npm install
npm run build:plugin
npm test
npm run validate:plugin
agy plugin validate ./plugins/opencode-delegate --strict --json
```

Optional live smoke test (uses an explicitly authorized model and only touches a temporary fixture directory):

```powershell
npm run test:live -- your-provider/your-model
```

## Troubleshooting

- **`MODEL_REQUIRED` / `MODEL_INVALID`**: Always pass a full `provider/model` (or `provider/model#variant`) ID without whitespace. Call `opencode_models` if unsure which models are configured locally.
- **`agent.found: false` in `opencode_doctor`**: OpenCode native binary was not found, or `OPENCODE_BIN` points to a `.cmd`/`.bat`/`.ps1` script. Set `OPENCODE_BIN` to the native `opencode.exe` (or `opencode` on POSIX) path.
- **New/updated tools not visible in Antigravity**: Check plugin tool toggles in Antigravity, refresh MCP servers, and start a new chat session so the updated `mcp_config.json` and schemas load.
- **Long-running tasks timing out**: Prefer `opencode_start` + `opencode_status` instead of synchronous `opencode_execute`, and check `git status` / `git diff` before retrying any interrupted run.
