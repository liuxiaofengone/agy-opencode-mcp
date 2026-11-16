#!/usr/bin/env node
// Portable Antigravity plugin package validator for agy-opencode-mcp.
// Runs on Node >= 22 with zero third-party dependencies.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

const problems = [];
const fail = (message) => problems.push(message);

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function fileType(stat) {
  return stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "non-regular file";
}

function readJsonSecure(file, label) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    fail(`${label}: cannot read file`);
    return { text: undefined, value: undefined };
  }
  if (text.charCodeAt(0) === 0xfeff) {
    fail(`${label}: starts with a UTF-8 byte order mark`);
  }
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    const position = /position (\d+)/.exec(error?.message ?? "");
    fail(`${label}: invalid JSON` + (position ? ` at position ${position[1]}` : ""));
    return { text, value: undefined };
  }
}

function guardRealTarget(rootReal, label, target, { expectDir = false } = {}) {
  let real;
  try {
    real = realpathSync(target);
  } catch {
    fail(`${label}: path does not exist: ${target}`);
    return undefined;
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    fail(`${label}: resolves outside the plugin root (symlink/junction escape): ${target} -> ${real}`);
    return undefined;
  }
  let stat;
  try {
    stat = statSync(real);
  } catch {
    fail(`${label}: cannot stat resolved path: ${target}`);
    return undefined;
  }
  if (expectDir && !stat.isDirectory()) {
    fail(`${label}: expected a directory, got ${fileType(stat)}: ${target}`);
    return undefined;
  }
  if (!expectDir && !stat.isFile()) {
    fail(`${label}: expected a file, got ${fileType(stat)}: ${target}`);
    return undefined;
  }
  return { real, stat };
}

function expandPluginRoot(value) {
  if (value === "${PLUGIN_ROOT}") return ".";
  if (value.startsWith("${PLUGIN_ROOT}/") || value.startsWith("${PLUGIN_ROOT}\\")) {
    return "./" + value.slice("${PLUGIN_ROOT}/".length);
  }
  return value;
}

function guardPluginRelative(pluginRoot, label, value, { allowPluginRootMacro = false } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label}: must be a non-empty plugin-relative string`);
    return undefined;
  }
  const normalized = allowPluginRootMacro ? expandPluginRoot(value) : value;
  if (isAbsolute(normalized)) {
    fail(`${label}: must be plugin-relative, not absolute: ${value}`);
    return undefined;
  }
  const resolved = resolve(pluginRoot, normalized);
  if (resolved !== pluginRoot && !resolved.startsWith(pluginRoot + sep)) {
    fail(`${label}: escapes the plugin root: ${value}`);
    return undefined;
  }
  return resolved;
}

function scanMachineSpecific(text, label) {
  if (text.includes("/Users/")) fail(`${label}: contains a macOS user directory path`);
  if (/[A-Za-z]:[\\/]+Users[\\/]/.test(text)) fail(`${label}: contains a Windows user directory path`);
  if (text.includes("${CLAUDE_PLUGIN_ROOT}") || text.includes("${CLAUDE_PLUGIN_DATA}")) {
    fail(`${label}: contains Claude-specific plugin placeholder (CLAUDE_PLUGIN_ROOT/DATA)`);
  }
}

function collectSkillFiles(rootReal, dir, label, depth, found) {
  const dirInfo = guardRealTarget(rootReal, `${label}: directory`, dir, { expectDir: true });
  if (!dirInfo) return found;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    fail(`${label}: cannot read directory: ${dir}`);
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const info = guardRealTarget(rootReal, `${label}: ${full}`, full);
      if (!info) continue;
      if (info.stat.isDirectory()) {
        if (depth + 1 > 3) {
          fail(`${label}: directory nesting deeper than 3 levels: ${full}`);
          continue;
        }
        collectSkillFiles(rootReal, full, label, depth + 1, found);
      } else if (entry.name === "SKILL.md") {
        found.push(full);
      }
    } else if (entry.isDirectory()) {
      if (depth + 1 > 3) {
        fail(`${label}: directory nesting deeper than 3 levels: ${full}`);
        continue;
      }
      collectSkillFiles(rootReal, full, label, depth + 1, found);
    } else if (entry.name === "SKILL.md") {
      if (guardRealTarget(rootReal, `${label}: ${full}`, full)) {
        found.push(full);
      }
    }
  }
  return found;
}

function validate(pluginRootArg) {
  if (!pluginRootArg) {
    fail("usage: node scripts/validate-plugin.mjs <plugin-root>");
    return;
  }
  const pluginRoot = resolve(pluginRootArg);
  if (!existsSync(pluginRoot) || !statSync(pluginRoot).isDirectory()) {
    fail(`plugin root not found or not a directory: ${pluginRoot}`);
    return;
  }
  let rootReal;
  try {
    rootReal = realpathSync(pluginRoot);
  } catch {
    fail(`plugin root cannot be resolved: ${pluginRoot}`);
    return;
  }

  const manifestPath = join(pluginRoot, "plugin.json");
  const manifestInfo = guardRealTarget(rootReal, "plugin manifest", manifestPath);
  if (!manifestInfo) return;
  const { text: manifestText, value: manifest } = readJsonSecure(manifestInfo.real, "plugin manifest");
  if (manifestText !== undefined) scanMachineSpecific(manifestText, "plugin manifest");
  const manifestObject = manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)
    ? manifest
    : {};
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("plugin manifest: root value must be a non-null, non-array JSON object");
  }

  if (typeof manifestObject.name !== "string" || manifestObject.name.length === 0) fail("manifest: name must be a non-empty string");
  if (typeof manifestObject.version !== "string" || !SEMVER_RE.test(manifestObject.version)) {
    fail("manifest: version must be a full semantic version, got " + JSON.stringify(manifestObject.version));
  }
  if (typeof manifestObject.description !== "string" || manifestObject.description.length === 0) {
    fail("manifest: description is required");
  }
  if (typeof manifestObject.author?.name !== "string" || manifestObject.author.name.length === 0) fail("manifest: author.name is required");
  if (typeof manifestObject.repository !== "string" || manifestObject.repository.length === 0) fail("manifest: repository is required");
  if (manifestObject.logo !== undefined) {
    const logoPath = guardPluginRelative(pluginRoot, "manifest: logo", manifestObject.logo);
    if (logoPath) guardRealTarget(rootReal, "manifest: logo", logoPath);
  }

  const skillsDir = join(pluginRoot, "skills");
  if (guardRealTarget(rootReal, "skills directory", skillsDir, { expectDir: true })) {
    const skillFiles = collectSkillFiles(rootReal, skillsDir, "skills tree", 0, []);
    if (skillFiles.length === 0) {
      fail("skills: no SKILL.md found under skills/");
    }
  }

  const mcpConfigPath = join(pluginRoot, "mcp_config.json");
  const mcpInfo = guardRealTarget(rootReal, "mcp config", mcpConfigPath);
  if (!mcpInfo) return;
  const { text: mcpText, value: mcpConfig } = readJsonSecure(mcpInfo.real, "mcp config");
  if (mcpText !== undefined) scanMachineSpecific(mcpText, "mcp config");
  if (mcpConfig === null || typeof mcpConfig !== "object" || Array.isArray(mcpConfig)) {
    fail("mcp config: root value must be a non-null, non-array JSON object");
    return;
  }
  const servers = mcpConfig.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers) || Object.keys(servers).length === 0) {
    fail("mcp config: mcpServers must define at least one server");
    return;
  }

  for (const [serverName, server] of Object.entries(servers)) {
    if (server === null || typeof server !== "object" || Array.isArray(server)) {
      fail(`mcp config: server ${serverName} must be a non-null, non-array object`);
      continue;
    }
    if (typeof server.command !== "string" || server.command.length === 0) {
      fail(`mcp config: server ${serverName} is missing a command`);
      continue;
    }
    if (server.command !== "node" && !/^node\d*$/.test(server.command)) {
      fail(`mcp config: server ${serverName} command must be a portable node executable, got ${JSON.stringify(server.command)}`);
    }
    if (!Array.isArray(server.args) || server.args.length === 0) {
      fail(`mcp config: server ${serverName} must declare bundle args`);
      continue;
    }
    if (server.timeoutSeconds !== undefined && (typeof server.timeoutSeconds !== "number" || !Number.isFinite(server.timeoutSeconds) || server.timeoutSeconds <= 0)) {
      fail(`mcp config: server ${serverName} timeoutSeconds must be a positive finite number`);
    }
    let serverCwd = pluginRoot;
    if (server.cwd !== undefined) {
      const guardedCwd = guardPluginRelative(pluginRoot, `mcp config: server ${serverName} cwd`, server.cwd, { allowPluginRootMacro: true });
      if (guardedCwd && guardRealTarget(rootReal, `mcp config: server ${serverName} cwd`, guardedCwd, { expectDir: true })) {
        serverCwd = guardedCwd;
      }
    }
    for (const arg of server.args) {
      if (typeof arg !== "string") {
        fail(`mcp config: server ${serverName} arg must be plugin-relative, got ${JSON.stringify(arg)}`);
        continue;
      }
      const expandedArg = expandPluginRoot(arg);
      if (isAbsolute(expandedArg)) {
        fail(`mcp config: server ${serverName} arg must be plugin-relative, got ${JSON.stringify(arg)}`);
        continue;
      }
      const baseDir = arg === "${PLUGIN_ROOT}" || arg.startsWith("${PLUGIN_ROOT}/") || arg.startsWith("${PLUGIN_ROOT}\\")
        ? pluginRoot
        : serverCwd;
      const bundlePath = resolve(baseDir, expandedArg);
      if (bundlePath !== pluginRoot && !bundlePath.startsWith(pluginRoot + sep)) {
        fail(`mcp config: server ${serverName} arg escapes the plugin root: ${arg}`);
        continue;
      }
      const bundleInfo = guardRealTarget(rootReal, `mcp config: server ${serverName} bundle`, bundlePath);
      if (!bundleInfo) continue;
      if (bundleInfo.stat.size === 0) {
        fail(`mcp config: server ${serverName} bundle is empty: ${arg}`);
      } else {
        scanMachineSpecific(readFileSync(bundleInfo.real, "utf8"), `bundle ${arg}`);
      }
    }
  }
}

validate(process.argv[2]);

if (problems.length > 0) {
  process.stderr.write(`plugin validation failed (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}
process.stdout.write("plugin validation passed\n");
