import { spawn, execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { createEventParser } from "./events.mjs";
import { readVersionFromModuleUrl } from "./version.mjs";

const execFileAsync = promisify(execFile);
export const MODEL_ID_PATTERN = /^[^/#\s]+\/[^#\s]+(?:#[^#\s]+)?$/;
export const READER_AGENT = "agy-mcp-reader";
const READ_PERMISSIONS = Object.freeze({
  "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow",
  edit: "deny", write: "deny", patch: "deny", bash: "deny", shell: "deny",
  task: "deny", external_directory: "deny", webfetch: "deny", websearch: "deny",
});

async function fileExists(candidate) {
  try { return (await stat(candidate)).isFile(); } catch { return false; }
}
async function directoryExists(candidate) {
  try { return (await stat(candidate)).isDirectory(); } catch { return false; }
}
function envValue(env, name) {
  const key = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}
export async function resolveOpenCodeExecutable(env = process.env, { commandName = "opencode" } = {}) {
  const rawExplicit = envValue(env, "OPENCODE_BIN");
  const explicit = typeof rawExplicit === "string" ? rawExplicit.trim() : "";
  if (explicit) {
    if (!path.isAbsolute(explicit) || !await fileExists(explicit)) {
      throw new Error("OPENCODE_BIN must point to an existing absolute executable path");
    }
    if (/\.(cmd|bat|ps1)$/i.test(explicit)) throw new Error("OPENCODE_BIN must point to the native executable, not a shell wrapper");
    return explicit;
  }
  const candidates = [];
  if (commandName === "opencode") {
    if (process.platform === "win32") {
      const appData = envValue(env, "APPDATA");
      if (appData) candidates.push(path.join(appData, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe"));
    }
    candidates.push(path.join(envValue(env, "USERPROFILE") || env.HOME || homedir(), ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode"));
  }
  const names = process.platform === "win32" && !path.extname(commandName) ? [commandName + ".exe", commandName] : [commandName];
  for (const directory of (envValue(env, "PATH") || "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) candidates.push(path.join(directory.replace(/^"|"$/g, ""), name));
  }
  for (const candidate of candidates) if (path.isAbsolute(candidate) && await fileExists(candidate)) return candidate;
  throw new Error("OpenCode executable not found. Set OPENCODE_BIN to the native OpenCode 2 executable path.");
}

export function redact(value) {
  return String(value ?? "")
    .replace(/(server password\s*[:=]?\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|authorization|password)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[REDACTED]");
}

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true, timeout: 5000, maxBuffer: 1_000_000 });
    return stdout.trim().slice(0, 12000);
  } catch { return null; }
}

function childEnvironment(env, input) {
  const childEnv = { ...env, PWD: input.cwd };
  if (!input.readOnly) return childEnv;
  let config = {};
  if (env.OPENCODE_CONFIG_CONTENT) {
    try { config = JSON.parse(env.OPENCODE_CONFIG_CONTENT); }
    catch { throw new Error("OPENCODE_CONFIG_CONTENT must be valid JSON for read-only execution"); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object");
  }
  // Override legacy AND native permission forms: native fields otherwise take
  // precedence over migrated legacy configuration in OpenCode 2.
  delete config.permissions;
  delete config.agents;
  childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config,
    permission: READ_PERMISSIONS,
    agent: { ...config.agent, [READER_AGENT]: {
      mode: "primary", description: "Read project files and summarize without changing files or running commands.",
      prompt: "You are a project reader. Read files with the permitted read, glob and grep tools. Summarize your findings. All write, shell, external-directory and network tools are denied.",
      permission: READ_PERMISSIONS,
    } },
  });
  return childEnv;
}

async function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try { await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }); }
    catch { child.kill(); }
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 1000);
    timer.unref();
  }
}

async function resolveTargetCwd(cwd, defaultCwd) {
  if (cwd === undefined) return defaultCwd;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new Error("cwd must be an absolute directory path");
  }
  if (!await directoryExists(cwd)) {
    throw new Error("cwd directory does not exist");
  }
  return cwd;
}

async function verifyNativeExecutable(executable) {
  if (!path.isAbsolute(executable) || !await fileExists(executable) || /\.(cmd|bat|ps1)$/i.test(executable)) {
    throw new Error("OpenCode executable must be an existing absolute native executable path");
  }
}

/**
 * List configured provider/model IDs via `opencode models` without invoking LLM inference.
 */
export async function listOpenCodeModels(input = {}, options = {}) {
  const settings = { standalone: true, timeoutMs: 15000, ...input };
  const baseEnv = options.env ?? process.env;
  let targetCwd = null;
  let executable = null;
  let providerFilter = null;
  try {
    targetCwd = await resolveTargetCwd(settings.cwd, options.defaultCwd ?? process.cwd());
    if (!Number.isInteger(settings.timeoutMs) || settings.timeoutMs <= 0 || settings.timeoutMs > 60000) {
      throw new Error("timeoutMs must be an integer between 1 and 60000");
    }
    if (settings.provider !== undefined) {
      if (typeof settings.provider !== "string" || !settings.provider.trim() || /\s/.test(settings.provider)) {
        throw new Error("provider filter must be a non-empty string without whitespace");
      }
      providerFilter = settings.provider.trim();
    }
    executable = options.executable ?? await resolveOpenCodeExecutable(baseEnv);
    await verifyNativeExecutable(executable);
  } catch (error) {
    return {
      ok: false,
      errorCode: error.code ?? "INVALID_INPUT",
      error: redact(error.message),
      executable,
      cwd: targetCwd,
    };
  }

  const args = [...(options.prefixArgs ?? []), "models"];
  if (settings.standalone) args.push("--standalone");

  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      cwd: targetCwd,
      env: { ...baseEnv, PWD: targetCwd },
      windowsHide: true,
      timeout: settings.timeoutMs,
      maxBuffer: 2_000_000,
    });
    const seen = new Set();
    const allModels = [];
    for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line && MODEL_ID_PATTERN.test(line) && !seen.has(line)) {
        seen.add(line);
        allModels.push(line);
      }
    }
    const prefix = providerFilter ? `${providerFilter.toLowerCase()}/` : null;
    const models = prefix
      ? allModels.filter((id) => id.toLowerCase().startsWith(prefix))
      : allModels;
    return {
      ok: true,
      executable,
      cwd: targetCwd,
      standalone: settings.standalone,
      provider: providerFilter,
      totalCount: allModels.length,
      filteredCount: models.length,
      models,
      stderrTail: redact(stderr).slice(-2000),
    };
  } catch (error) {
    const killedByTimeout = Boolean(error?.killed && error?.signal);
    const exitCode = typeof error?.code === "number" ? error.code : null;
    const stderrTail = redact(error?.stderr ?? "").slice(-4000);
    return {
      ok: false,
      errorCode: killedByTimeout ? "TIMEOUT" : "MODELS_COMMAND_FAILED",
      error: redact(error?.message || "Failed to list OpenCode models"),
      killedByTimeout,
      exitCode,
      executable,
      cwd: targetCwd,
      stderrTail,
    };
  }
}

/**
 * Inspect local OpenCode CLI resolution, binary version, and optional model catalog readiness.
 */
export async function runOpenCodeDoctor(input = {}, options = {}) {
  const settings = { deep: false, timeoutMs: 15000, ...input };
  const baseEnv = options.env ?? process.env;
  const pluginVersion = readVersionFromModuleUrl(import.meta.url);
  const rawExplicit = envValue(baseEnv, "OPENCODE_BIN");
  const source = typeof rawExplicit === "string" && rawExplicit.trim() ? "OPENCODE_BIN" : "auto";
  const runtime = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    transport: "stdio",
  };

  let executable = null;
  try {
    executable = options.executable ?? await resolveOpenCodeExecutable(baseEnv);
    await verifyNativeExecutable(executable);
  } catch (error) {
    return {
      ok: false,
      pluginVersion,
      runtime,
      agent: { found: false, executable: null, source, version: null, error: redact(error.message) },
    };
  }

  let version = null;
  let versionError = null;
  try {
    const { stdout, stderr } = await execFileAsync(executable, [...(options.prefixArgs ?? []), "--version"], {
      windowsHide: true,
      timeout: Math.min(settings.timeoutMs, 10000),
      maxBuffer: 256_000,
    });
    const line = String(stdout ?? "").trim().split(/\r?\n/).find(Boolean);
    version = line || null;
    if (!version) versionError = redact(stderr || "Empty --version output").slice(-1000);
  } catch (error) {
    versionError = redact(error?.message || "Failed to run --version").slice(-1000);
  }

  const agent = {
    found: true,
    executable,
    source,
    version,
    ...(versionError ? { error: versionError } : {}),
  };

  if (!settings.deep || versionError) {
    return {
      ok: !versionError,
      pluginVersion,
      runtime,
      agent,
    };
  }

  const modelsResult = await listOpenCodeModels(
    { cwd: settings.cwd, standalone: true, timeoutMs: settings.timeoutMs },
    options,
  );
  return {
    ok: modelsResult.ok,
    pluginVersion,
    runtime,
    agent,
    modelsProbe: modelsResult.ok
      ? {
          ok: true,
          cwd: modelsResult.cwd,
          totalCount: modelsResult.totalCount,
          sampleModels: modelsResult.models.slice(0, 10),
        }
      : {
          ok: false,
          cwd: modelsResult.cwd,
          errorCode: modelsResult.errorCode,
          error: modelsResult.error,
        },
  };
}

export async function runOpenCode(input, options = {}) {
  const settings = { readOnly: true, autoApprove: false, standalone: true, timeoutMs: 900000, ...input };
  let executable, env, requestedModel = null;
  try {
    if (typeof settings.cwd !== "string" || !path.isAbsolute(settings.cwd)) throw new Error("cwd must be an absolute directory path");
    if (!await directoryExists(settings.cwd)) throw new Error("cwd directory does not exist");
    if (typeof settings.task !== "string" || !settings.task.trim() || settings.task.startsWith("-")) throw new Error("task must be nonempty and must not start with a CLI option");
    if (!Number.isInteger(settings.timeoutMs) || settings.timeoutMs <= 0 || settings.timeoutMs > 3600000) throw new Error("timeoutMs must be an integer between 1 and 3600000");
    // OpenCode resumes at the saved session location, and saved permission
    // rules outrank agent rules. A new session keeps cwd and reader permissions
    // authoritative for this bounded invocation.
    if (settings.sessionId || settings.continueSession) throw new Error("Session continuation is unsupported: start a new task so cwd and current permissions control the execution");
    if (settings.readOnly && !settings.standalone) throw new Error("Read-only execution requires standalone=true to apply isolated permissions");
    if (settings.model === undefined || settings.model === null || settings.model === "") {
      throw Object.assign(new Error("model is required: explicitly select a configured provider/model for every task; implicit CLI defaults are disabled"), { code: "MODEL_REQUIRED" });
    }
    if (typeof settings.model !== "string" || !MODEL_ID_PATTERN.test(settings.model)) {
      throw Object.assign(new Error("model must be a complete provider/model ID, optionally followed by #variant, without whitespace"), { code: "MODEL_INVALID" });
    }
    requestedModel = settings.model;
    env = childEnvironment(options.env ?? process.env, settings);
    executable = options.executable ?? await resolveOpenCodeExecutable(env);
    await verifyNativeExecutable(executable);
  } catch (error) { return { ok: false, error: redact(error.message), errorCode: error.code ?? "INVALID_INPUT", requestedModel, cwd: settings.cwd }; }
  if (options.signal?.aborted) return { ok: false, cancelled: true, error: "OpenCode task cancelled", requestedModel, cwd: settings.cwd };
  const args = [...(options.prefixArgs ?? []), "run", "--format", "json"];
  if (settings.standalone) args.push("--standalone");
  if (settings.autoApprove) args.push("--auto");
  const agent = settings.readOnly ? READER_AGENT : settings.agent;
  if (agent) args.push("--agent", agent);
  args.push("--model", requestedModel);
  args.push(settings.task);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const parser = createEventParser({ onProgress: (progress) => options.onProgress?.({
      ...progress, elapsedMs: Date.now() - startedAt,
      lastEventAgeMs: progress.lastEventAt === null ? null : Date.now() - progress.lastEventAt,
    }) });
    const stderrDecoder = new StringDecoder("utf8");
    let stderr = "", spawnError = null, killedByTimeout = false, cancelled = false;
    let timer;
    const child = spawn(executable, args, { cwd: settings.cwd, env,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
      detached: process.platform !== "win32" });
    const abort = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      cancelled = true;
      clearTimeout(timer);
      void terminateTree(child);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      killedByTimeout = true;
      void terminateTree(child);
    }, settings.timeoutMs);
    timer.unref();
    // Handle an abort between the initial check and listener registration.
    if (options.signal?.aborted) abort();
    options.onProgress?.({ eventCount: 0, completedToolCount: 0, lastEventType: null,
      lastEventAt: null, elapsedMs: Date.now() - startedAt, lastEventAgeMs: null });
    child.stdout.on("data", (chunk) => parser.write(chunk));
    child.stderr.on("data", (chunk) => { stderr = (stderr + stderrDecoder.write(chunk)).slice(-8000); });
    child.on("error", (error) => { spawnError = error; });
    child.on("close", async (exitCode, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      parser.end();
      stderr += stderrDecoder.end();
      const result = parser.result();
      const finishedAt = Date.now();
      const progress = { ...result.progress, elapsedMs: finishedAt - startedAt,
        lastEventAgeMs: result.progress.lastEventAt === null ? null : finishedAt - result.progress.lastEventAt };
      let error = null;
      if (spawnError) error = `Failed to spawn OpenCode: ${spawnError.message}`;
      else if (killedByTimeout) error = "OpenCode task exceeded timeout";
      else if (cancelled) error = "OpenCode task cancelled";
      else if (result.errors.length) error = result.errors.join("\n");
      else if (exitCode !== 0) error = `OpenCode exited with code ${exitCode}${signal ? ` (${signal})` : ""}`;
      else if (result.stdoutOverflow) error = "OpenCode output exceeded the event line limit; result is incomplete";
      else if (!result.text) error = "OpenCode completed with no final text";
      const [diffStat, statusShort] = await Promise.all([
        git(settings.cwd, ["diff", "--stat"]), git(settings.cwd, ["status", "--short"]),
      ]);
      resolve({ ok: !error, ...(error ? { error: redact(error) } : {}),
        killedByTimeout, cancelled, exitCode, signal,
        sessionID: result.sessionID, requestedModel, cwd: settings.cwd, readOnly: settings.readOnly,
        stdoutOverflow: result.stdoutOverflow, textOverflow: result.textOverflow,
        text: redact(result.text), stepFinish: result.stepFinish, diffStat, statusShort,
        stderrTail: redact(stderr).slice(-4000), progress });
    });
  });
}
