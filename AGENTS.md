# AGENTS.md

Project instructions for `agy-opencode-mcp`.

## Architecture

- Root `server.mjs` and `src/` are the canonical ESM source (Node >= 22).
- `plugins/opencode-delegate/` is the distributable Antigravity plugin bundle:
  - `plugin.json` — Antigravity plugin manifest.
  - `mcp_config.json` — MCP server definition (`${PLUGIN_ROOT}/mcp/server.mjs`, `timeoutSeconds: 3660`). Only read-only tools (`opencode_doctor`, `opencode_models`, `opencode_status`) are marked `eager: true`; execution/cancellation tools stay lazy (`call_mcp_tool`).
  - `mcp/server.mjs` — Tracked `esbuild` single-file ESM bundle built by `npm run build:plugin`.
  - `skills/opencode-delegate/SKILL.md` — Antigravity delegation rules and verification workflow.

## Hard Invariants

- Never remove the explicit `model` requirement (`MODEL_REQUIRED` / `MODEL_INVALID`) or add silent default/fallback model selection.
- Never launch OpenCode through a shell (`shell: false` always) or accept `.cmd`/`.bat`/`.ps1` wrappers as `OPENCODE_BIN`.
- Always keep `readOnly: true`, `standalone: true`, and `autoApprove: false` as defaults.
- Whenever `server.mjs` or `src/*.mjs` changes, rebuild the tracked bundle (`npm run build:plugin`) and re-run all tests and validators:
  - `npm test`
  - `npm run validate:plugin`
  - `agy plugin validate ./plugins/opencode-delegate --strict --json`
