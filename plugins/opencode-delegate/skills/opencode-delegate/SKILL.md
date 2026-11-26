---
name: opencode-delegate
description: >
  Delegate read-only project analysis or bounded coding tasks to local OpenCode 2 via the
  opencode-delegate MCP server in Antigravity. Use when the user asks to delegate to OpenCode,
  run a task with an OpenCode provider/model, inspect configured OpenCode models, or diagnose
  OpenCode delegation setup. Never shell out to opencode via run_command and never substitute
  Antigravity native subagents when OpenCode execution is requested.
license: MIT
---

# OpenCode Delegate (Antigravity)

Antigravity owns the specification, implementation plan, `git diff` review, independent verification, and final completion decision. Local OpenCode 2 (`opencode`) owns bounded analysis or execution through the `opencode-delegate` MCP server.

## Rules

- **Never bypass the MCP server**: do not run `opencode` via `run_command` to execute delegated tasks (a read-only `opencode models --standalone` lookup is allowed only as a fallback when `opencode_models` is disabled or unavailable in the MCP session).
- **Never substitute Antigravity native subagents**: when the user asks to delegate to OpenCode, do not use `invoke_subagent`, `swarm`, or `research` instead of the `opencode-delegate` MCP tools.
- **Tool loading in Antigravity**:
  - All 6 MCP tools (`opencode_doctor`, `opencode_models`, `opencode_status`, `opencode_execute`, `opencode_start`, `opencode_cancel`) are lazy-loaded via `call_mcp_tool` (`mcp_config.json` omits `"eager": true` so Antigravity does not drop `opencode_doctor`, `opencode_models`, or `opencode_status`).
  - Read a tool's schema first and invoke it through `call_mcp_tool`.
- **Explicit `model` is REQUIRED on every delegation**:
  - Every `opencode_execute` and `opencode_start` call must pass a complete `provider/model` ID (optionally with `#variant`, e.g. `provider/model#high`).
  - Only use a model explicitly specified by the user or explicitly authorized for the current task.
  - If the user has not specified a model, **always fetch and display the available model list before asking the user to choose** (never ask the user to type a `provider/model` ID blindly without showing options):
    1. Call `opencode_models` first to retrieve configured `provider/model` IDs.
    2. If `opencode_models` is disabled or unavailable in the current MCP session, run `opencode models --standalone` via `run_command` as a read-only fallback (and mention that `opencode_models` can be enabled in Antigravity's MCP tool settings).
    3. Present the retrieved `provider/model` IDs clearly (e.g., via `ask_question` when concise, or grouped by provider when large) and let the user pick one. Never guess, infer from display labels, or fall back to defaults/free models.
  - If a model fails (rate limit, auth, region, or unavailable error), report the error and stop; never silently switch to another model.
- **Scope and permissions**:
  - Read-only analysis must keep `readOnly: true` and `standalone: true` (default). This injects an isolated `agy-mcp-reader` agent that denies edit, write, shell, external-directory, and network tools. Note: OpenCode permissions are not an OS sandbox; exclude `.env`, private keys, and sensitive files in the task brief.
  - Implementation or command tasks require explicit `readOnly: false` plus clear allowed files, boundaries, and verification commands. Enable `autoApprove: true` only when the user authorizes non-interactive approval of non-denied tools (either for the specific task or as an explicit session/project authorization—no need to re-prompt on every call within an already-authorized scope).
  - Session continuation (`sessionId`, `continueSession`) is unsupported by this bridge; each call starts a clean session so `cwd` and permissions remain authoritative.

## Sync vs Async Execution

- **Short bounded tasks**: use `opencode_execute` (default `timeoutMs: 900000`, max `3600000`).
- **Long tasks** (likely to exceed host per-call timeout): use `opencode_start`, keep the returned `jobId`, and poll `opencode_status` until terminal (`completed`, `failed`, or `cancelled`).
- **Never duplicate unknown runs**: if a synchronous `opencode_execute` call is interrupted by host timeout, do not blindly resend the task—check `git status` / `git diff` first, and use `opencode_start` for long tasks.
- **Cancellation**: call `opencode_cancel({ jobId })` and continue polling `opencode_status` until `state === "cancelled"` before changing files or reassigning ownership. Note that async jobs live in the MCP server's memory; disconnecting or restarting the MCP server cancels active jobs.

## Delegation Workflow

1. **Confirm model**: verify the user's explicit `provider/model[#variant]`; if unspecified, fetch and display the model list via `opencode_models` (or `opencode models --standalone` fallback if disabled) before asking the user to choose.
2. **Pass a tight `cwd`**: pass an existing absolute directory containing the task's files (or the project root). Never pass a relative path, `$HOME`, or `/`.
3. **Write a bounded `task` brief** (at least 10 characters, never starting with `-`):
   - Goal and expected output format.
   - Allowed files/directories and explicit exclusions (skip `.env`, secrets, dependencies, build artifacts).
   - Verification commands (when `readOnly: false`).
4. **Independently review & verify**:
   - Inspect `requestedModel` (note: this records what was requested, not independent proof of upstream routing), `sessionID`, `diffStat`, `statusShort`, `progress`, and `text`.
   - `ok: true` only confirms the CLI exited cleanly with text; always inspect real `git status`, `git diff`, untracked files, and run tests/checks independently before accepting the work.
   - See [reference.md](reference.md) for full parameter tables, progress fields, and failure triage.
