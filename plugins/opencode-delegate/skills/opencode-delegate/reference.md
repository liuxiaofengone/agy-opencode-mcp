# OpenCode Delegate Reference

Architecture: Antigravity -> MCP (`opencode-delegate`) -> `opencode` v2 CLI (`--format json`).

## Tools

### Eager Tools (Read-Only)

- **`opencode_doctor({ deep?, cwd?, timeoutMs? })`**
  - Resolves the native OpenCode executable (`OPENCODE_BIN`, Windows `%APPDATA%\npm\node_modules\@opencode\cli\bin\opencode.exe`, `~/.opencode/bin`, or `PATH`; rejects `.cmd`/`.bat`/`.ps1` wrappers).
  - Runs `opencode --version`.
  - When `deep: true`, also runs `opencode models --standalone` (without invoking any model inference) and reports `totalCount` and up to 10 `sampleModels`.
- **`opencode_models({ cwd?, provider?, standalone?, timeoutMs? })`**
  - Runs `opencode models` (with `--standalone` by default) in `cwd` (or current process directory) and returns deduplicated `provider/model` IDs.
  - Filters client-side by `provider` prefix if supplied.
- **`opencode_status({ jobId })`**
  - Returns `{ ok, jobId, state, startedAt, updatedAt, requestedModel, cwd, progress, result? }`.
  - `state` is `running`, `cancelling`, `completed`, `failed`, or `cancelled`.
  - Live `progress` updates `elapsedMs` and `lastEventAgeMs` even when no new NDJSON event has arrived, helping distinguish model thinking/tool execution from stalls.

### Lazy Tools (Invoke via `call_mcp_tool`)

- **`opencode_execute`** — Synchronous execution in a fresh OpenCode session.
- **`opencode_start`** — Background execution; returns immediately with `jobId` (up to 4 concurrent jobs, up to 50 retained terminal results in memory).
- **`opencode_cancel({ jobId })`** — Aborts the job and kills its owned local process tree (`taskkill.exe /T /F` on Windows; process-group `SIGTERM`/`SIGKILL` on POSIX). Poll `opencode_status` until `cancelled`.

## Execution Parameters (`opencode_execute` / `opencode_start`)

| Parameter | Default | Constraints & Notes |
| --- | --- | --- |
| `task` | required | Non-empty string, min 10 chars, must not start with `-`. |
| `cwd` | required | Existing absolute directory path; synced to child `cwd` and `PWD`. |
| `model` | required | Matches `^[^/#\s]+\/[^#\s]+(?:#[^#\s]+)?$`. Explicitly authorized `provider/model[#variant]`. |
| `readOnly` | `true` | Injects inline `OPENCODE_CONFIG_CONTENT` with `agy-mcp-reader` denying edit/write/patch/bash/shell/task/external_directory/webfetch/websearch. |
| `autoApprove` | `false` | Adds `--auto` only when `true`. Does not override explicit `deny` rules. |
| `standalone` | `true` | Adds `--standalone`. Required when `readOnly: true` so isolated permissions apply. |
| `agent` | omitted | Optional custom agent in write mode (`readOnly: false`). Ignored/overridden by `agy-mcp-reader` when `readOnly: true`. |
| `timeoutMs` | `900000` | Integer `1000..3600000` (ms). Subprocess timeout independent of MCP request timeout. |
| `sessionId` | omitted | Unsupported; passing a value fails validation before spawning. |
| `continueSession` | `false` | Must remain `false`; bridge always starts a new session. |

## Output Fields

Execution results include:
`ok`, `error` (when failed), `errorCode` (on validation/job errors), `killedByTimeout`, `cancelled`, `exitCode`, `signal`, `sessionID`, `requestedModel`, `cwd`, `readOnly`, `stdoutOverflow`, `textOverflow`, `text` (max 12,000 chars, credential-redacted), `stepFinish`, `diffStat`, `statusShort`, `stderrTail` (max 4,000 chars, redacted), and `progress` (`eventCount`, `completedToolCount`, `lastEventType`, `elapsedMs`, `lastEventAgeMs`).

## Failure Triage Order

1. **`MODEL_REQUIRED` / `MODEL_INVALID` / `INVALID_INPUT`**: Rejected before spawning CLI. Confirm `model`, `cwd`, and `task`.
2. **`opencode_doctor` fails (`agent.found: false`)**: Native binary not found or wrapper path provided in `OPENCODE_BIN`. Set `OPENCODE_BIN` to the native `opencode.exe` / `opencode` binary path.
3. **Model routing / auth / region error**: Run `opencode session export --sanitize <sessionID>` locally if strict verification of the actual assistant `providerID`, `modelID`, and `variant` is needed. Do not auto-switch models.
4. **Silent running async job**: Check `progress.lastEventType` and `progress.lastEventAgeMs` via `opencode_status` before assuming a hang; do not spawn duplicate jobs.
5. **`ok: true` with workspace edits**: `diffStat` and `statusShort` include pre-existing dirty files. Always inspect `git status` and `git diff` directly.
