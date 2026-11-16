#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  runOpenCode,
  listOpenCodeModels,
  runOpenCodeDoctor,
  MODEL_ID_PATTERN,
  redact,
} from "./src/runner.mjs";
import { createJobManager } from "./src/jobs.mjs";
import { readVersionFromModuleUrl } from "./src/version.mjs";

const VERSION = readVersionFromModuleUrl(import.meta.url);

export const executionInputSchema = {
  task: z.string().min(10).describe("Task, scope and expected output. Start with ordinary text, not a CLI option."),
  cwd: z.string().describe("Existing absolute project directory."),
  readOnly: z.boolean().default(true).describe("Allow file reading/search only. Denies edit, shell, external directories and network tools."),
  autoApprove: z.boolean().default(false).describe("Approve tools that are not explicitly denied. Enable only for tasks whose tool actions are authorized."),
  agent: z.string().min(1).optional().describe("Optional OpenCode agent in write mode. Read-only mode always uses an isolated reader agent."),
  model: z.string().regex(MODEL_ID_PATTERN, "Use a complete provider/model ID without whitespace").describe("REQUIRED for each delegation: configured provider/model, optionally #variant. Use an explicitly authorized ID; ask or call opencode_models if unspecified. No automatic model selection or fallback."),
  standalone: z.boolean().default(true).describe("Start a private OpenCode server. Required in read-only mode."),
  timeoutMs: z.number().int().min(1000).max(3600000).default(900000).describe("OpenCode process timeout, independent of the MCP request timeout."),
  sessionId: z.string().min(1).optional().describe("Unsupported: omit this field. Old sessions can override the selected project and current permissions."),
  continueSession: z.boolean().default(false).describe("Must remain false. This bridge creates a new session for each task."),
};

function jsonToolResponse(payload) {
  return {
    isError: !payload.ok,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Construct an isolated McpServer instance and register all OpenCode delegation tools.
 */
export function buildServer(deps = {}) {
  const run = deps.runOpenCode ?? runOpenCode;
  const listModels = deps.listOpenCodeModels ?? listOpenCodeModels;
  const doctor = deps.runOpenCodeDoctor ?? runOpenCodeDoctor;

  const server = new McpServer({ name: "opencode-delegate", version: VERSION });
  const active = new Set();
  const jobs = createJobManager({ run, redactError: redact });
  const cancelAll = () => {
    for (const controller of active) controller.abort();
    void jobs.cancelAll();
  };

  server.registerTool("opencode_doctor", {
    description: "Read-only diagnostics for local OpenCode 2 binary resolution, CLI version, and (with deep=true) configured model catalog availability.",
    inputSchema: {
      deep: z.boolean().default(false).describe("Also probe `opencode models --standalone` to verify catalog readiness without invoking any model."),
      cwd: z.string().optional().describe("Optional absolute project directory to inspect project-local OpenCode config."),
      timeoutMs: z.number().int().min(1000).max(60000).default(15000).describe("Probe timeout in milliseconds."),
    },
  }, async (input) => {
    try {
      return jsonToolResponse(await doctor(input));
    } catch (error) {
      return jsonToolResponse({ ok: false, error: redact(error?.message ?? error) });
    }
  });

  server.registerTool("opencode_models", {
    description: "List configured provider/model IDs from local OpenCode 2 without invoking any model. Call this before delegating if the user has not specified an explicit provider/model.",
    inputSchema: {
      cwd: z.string().optional().describe("Optional absolute project directory so project-local OpenCode config is included."),
      provider: z.string().min(1).optional().describe("Optional provider prefix filter (for example, deepseek or opencode)."),
      standalone: z.boolean().default(true).describe("Run with --standalone so project config is read directly."),
      timeoutMs: z.number().int().min(1000).max(60000).default(15000).describe("Command timeout in milliseconds."),
    },
  }, async (input) => {
    try {
      return jsonToolResponse(await listModels(input));
    } catch (error) {
      return jsonToolResponse({ ok: false, error: redact(error?.message ?? error) });
    }
  });

  server.registerTool("opencode_execute", {
    description: "Run a bounded task in a new session with local OpenCode 2. An explicit provider/model is REQUIRED for every task; never infer a model or rely on CLI defaults. Defaults to isolated read-only project analysis. Returns the requested model (not independently verified), text, session ID, exit status and Git context; reports model failures as errors.",
    inputSchema: executionInputSchema,
  }, async (input, extra) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    extra.signal.addEventListener("abort", cancel, { once: true });
    if (extra.signal.aborted) cancel();
    active.add(controller);
    try {
      const result = await run(input, { signal: controller.signal });
      return jsonToolResponse(result);
    } catch (error) {
      return jsonToolResponse({ ok: false, error: redact(error?.message ?? error) });
    } finally {
      active.delete(controller);
      extra.signal.removeEventListener("abort", cancel);
    }
  });

  server.registerTool("opencode_start", {
    description: "Start an OpenCode task in the background and immediately return a job ID. Poll opencode_status; do not start a duplicate task while the job is running.",
    inputSchema: executionInputSchema,
  }, async (input) => jsonToolResponse(jobs.start(input)));

  server.registerTool("opencode_status", {
    description: "Read the progress or terminal result of an OpenCode background job.",
    inputSchema: { jobId: z.string().uuid() },
  }, async ({ jobId }) => jsonToolResponse(jobs.status(jobId)));

  server.registerTool("opencode_cancel", {
    description: "Cancel one OpenCode background job and its owned local process tree. Poll status until the job reaches cancelled.",
    inputSchema: { jobId: z.string().uuid() },
  }, async ({ jobId }) => jsonToolResponse(jobs.cancel(jobId)));

  server.server.onclose = cancelAll;
  return { server, cancelAll };
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    const argPath = realpathSync(process.argv[1]);
    const selfPath = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32"
      ? argPath.toLowerCase() === selfPath.toLowerCase()
      : argPath === selfPath;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(VERSION);
  } else {
    const { server, cancelAll } = buildServer();
    process.on("SIGINT", cancelAll);
    process.on("SIGTERM", cancelAll);
    process.stdin.on("end", cancelAll);
    await server.connect(new StdioServerTransport());
  }
}
