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

- **Never bypass the MCP server**: do not run `opencode` via `run_command` to execute delegated tasks.
- **Never substitute Antigravity native subagents**: when the user asks to delegate to OpenCode, do not use `invoke_subagent`, `swarm`, or `research` instead of the `opencode-delegate` MCP tools.
- **Tool loading in Antigravity**:
  - Read-only inspection tools (`opencode_doctor`, `opencode_models`, `opencode_status`) are eagerly registered (`eager: true`).
  - Execution and cancellation tools (`opencode_execute`, `opencode_start`, `opencode_cancel`) are lazy-loaded: read their schema first and invoke them through `call_mcp_tool`.
- **Explicit `model` is REQUIRED on every delegation**:
  - Every `opencode_execute` and `opencode_start` call must pass a complete `provider/model` ID (optionally with `#variant`, e.g. `provider/model#high`).
  - Only use a model explicitly specified by the user or explicitly authorized for the current task.
  - If the user has not specified a model, call `opencode_models` to list configured IDs and ask the user to choose. Never guess, infer from display labels, or fall back to defaults/free models.
  - If a model fails (rate limit, auth, region, or unavailable error), report the error and stop; never silently switch to another model.
- **Scope and permissions**:
  - Read-only analysis must keep `readOnly: true` and `standalone: true` (default). This injects an isolated `agy-mcp-reader` agent that denies edit, write, shell, external-directory, and network tools. Note: OpenCode permissions are not an OS sandbox; exclude `.env`, private keys, and sensitive files in the task brief.
  - Implementation or command tasks require explicit `readOnly: false` plus clear allowed files, boundaries, and verification commands. Enable `autoApprove: true` only when the user authorizes non-interactive approval of non-denied tools.
  - Session continuation (`sessionId`, `continueSession`) is unsupported by this bridge; each call starts a clean session so `cwd` and permissions remain authoritative.

## Sync vs Async Execution

- **Short bounded tasks**: use `opencode_execute` (default `timeoutMs: 900000`, max `3600000`).
- **Long tasks** (likely to exceed host per-call timeout): use `opencode_start`, keep the returned `jobId`, and poll `opencode_status` until terminal (`completed`, `failed`, or `cancelled`).
- **Never duplicate unknown runs**: if a synchronous `opencode_execute` call is interrupted by host timeout, do not blindly resend the task—check `git status` / `git diff` first, and use `opencode_start` for long tasks.
- **Cancellation**: call `opencode_cancel({ jobId })` and continue polling `opencode_status` until `state === "cancelled"` before changing files or reassigning ownership. Note that async jobs live in the MCP server's memory; disconnecting or restarting the MCP server cancels active jobs.

## Delegation Workflow

1. **Confirm model**: verify the user's explicit `provider/model[#variant]` (or call `opencode_models` first and ask).
2. **Pass a tight `cwd`**: pass an existing absolute directory containing the task's files (or the project root). Never pass a relative path, `$HOME`, or `/`.
3. **Write a bounded `task` brief** (at least 10 characters, never starting with `-`):
   - Goal and expected output format.
   - Allowed files/directories and explicit exclusions (skip `.env`, secrets, dependencies, build artifacts).
   - Verification commands (when `readOnly: false`).
4. **Independently review & verify**:
   - Inspect `requestedModel` (note: this records what was requested, not independent proof of upstream routing), `sessionID`, `diffStat`, `statusShort`, `progress`, and `text`.
   - `ok: true` only confirms the CLI exited cleanly with text; always inspect real `git status`, `git diff`, untracked files, and run tests/checks independently before accepting the work.
   - See [reference.md](reference.md) for full parameter tables, progress fields, and failure triage.
