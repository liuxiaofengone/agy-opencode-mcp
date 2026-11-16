import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildServer } from "../server.mjs";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const VALIDATOR = path.join(ROOT, "scripts", "validate-plugin.mjs");
const PLUGIN_DIR = path.join(ROOT, "plugins", "opencode-delegate");
const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

async function runValidator(targetDir) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [VALIDATOR, targetDir], {
      timeout: 15_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err?.code === "number" ? err.code : 1,
      stdout: String(err?.stdout || ""),
      stderr: String(err?.stderr || ""),
    };
  }
}

test("plugins/opencode-delegate passes scripts/validate-plugin.mjs", async () => {
  assert.ok(existsSync(VALIDATOR), "scripts/validate-plugin.mjs must exist");
  const res = await runValidator(PLUGIN_DIR);
  assert.equal(res.code, 0, `validator failed: ${res.stderr}`);
  assert.match(res.stdout, /plugin validation passed/);
});

test("plugin manifest and mcp_config.json match Antigravity contract", () => {
  const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "plugin.json"), "utf8"));
  assert.equal(manifest.name, "opencode-delegate");
  assert.equal(manifest.version, PKG.version);
  assert.ok(typeof manifest.logo === "string" && manifest.logo.length > 0);
  const logoPath = path.join(PLUGIN_DIR, manifest.logo);
  assert.ok(existsSync(logoPath), "manifest.logo must exist inside plugin");

  const mcpConfig = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "mcp_config.json"), "utf8"));
  const server = mcpConfig.mcpServers?.["opencode-delegate"];
  assert.ok(server, "mcpServers.opencode-delegate must exist");
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${PLUGIN_ROOT}/mcp/server.mjs"]);
  assert.equal(server.cwd, "${PLUGIN_ROOT}");
  assert.ok(Number.isFinite(server.timeoutSeconds) && server.timeoutSeconds >= 3600);

  for (const eagerTool of ["opencode_doctor", "opencode_models", "opencode_status"]) {
    assert.equal(server.tools?.[eagerTool]?.eager, true, `${eagerTool} must be eager: true`);
  }
  for (const lazyTool of ["opencode_execute", "opencode_start", "opencode_cancel"]) {
    assert.equal(server.tools?.[lazyTool]?.eager, undefined, `${lazyTool} must remain lazy so Antigravity does not drop it`);
  }
});

test("MCP tool input schemas stay within Gemini 32-bit integer bounds", async () => {
  const { server } = buildServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "schema-compat-test", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    for (const tool of tools) {
      const props = tool.inputSchema?.properties ?? {};
      for (const [key, prop] of Object.entries(props)) {
        if (prop && typeof prop === "object" && prop.type === "integer" && prop.maximum !== undefined) {
          assert.ok(prop.maximum <= 2_147_483_647, `${tool.name}.${key}.maximum exceeds int32`);
        }
      }
    }
  } finally {
    await client.close();
  }
});

test("bundled plugin mcp/server.mjs runs standalone without node_modules", async (t) => {
  const copyDir = await mkdtemp(path.join(tmpdir(), "agyo-bundle-standalone-"));
  t.after(() => rm(copyDir, { recursive: true, force: true }));
  await cp(PLUGIN_DIR, copyDir, { recursive: true });

  const bundledServer = path.join(copyDir, "mcp", "server.mjs");
  const { stdout } = await execFileAsync(process.execPath, [bundledServer, "--version"], { timeout: 10_000 });
  assert.equal(stdout.trim(), PKG.version);

  const client = new Client({ name: "bundle-smoke", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [bundledServer],
    stderr: "pipe",
  }));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["opencode_cancel", "opencode_doctor", "opencode_execute", "opencode_models", "opencode_start", "opencode_status"],
    );
  } finally {
    await client.close();
  }
});

test("validator rejects CLAUDE_PLUGIN_ROOT and machine-specific user paths", async (t) => {
  const copyDir = await mkdtemp(path.join(tmpdir(), "agyo-val-claude-"));
  t.after(() => rm(copyDir, { recursive: true, force: true }));
  await cp(PLUGIN_DIR, copyDir, { recursive: true });

  const mcpPath = path.join(copyDir, "mcp_config.json");
  const cfg = JSON.parse(readFileSync(mcpPath, "utf8"));
  cfg.mcpServers["opencode-delegate"].args = ["${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"];
  await writeFile(mcpPath, JSON.stringify(cfg, null, 2), "utf8");

  const res1 = await runValidator(copyDir);
  assert.notEqual(res1.code, 0);
  assert.match(res1.stderr, /CLAUDE_PLUGIN_ROOT/);

  cfg.mcpServers["opencode-delegate"].args = ["${PLUGIN_ROOT}/mcp/server.mjs"];
  cfg.mcpServers["opencode-delegate"].env = { LEAK: "C:\\Users\\alice\\secret" };
  await writeFile(mcpPath, JSON.stringify(cfg, null, 2), "utf8");

  const res2 = await runValidator(copyDir);
  assert.notEqual(res2.code, 0);
  assert.match(res2.stderr, /Windows user directory/);
});

test("validator rejects symlink or junction escaping plugin root under skills/", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "agyo-val-escape-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const pluginCopy = path.join(base, "plugin");
  const outsideDir = path.join(base, "outside");
  await cp(PLUGIN_DIR, pluginCopy, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(path.join(outsideDir, "SKILL.md"), "---\nname: evil\ndescription: x\n---\n", "utf8");

  const linkPath = path.join(pluginCopy, "skills", "escape");
  await symlink(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");

  const res = await runValidator(pluginCopy);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /outside the plugin root/);
});

test("Antigravity skill and documentation enforce delegation boundaries and explicit model rules", () => {
  const skillPath = path.join(PLUGIN_DIR, "skills", "opencode-delegate", "SKILL.md");
  const refPath = path.join(PLUGIN_DIR, "skills", "opencode-delegate", "reference.md");
  const readmeEn = path.join(ROOT, "README.md");
  const readmeZh = path.join(ROOT, "README.zh-CN.md");
  const agentsMd = path.join(ROOT, "AGENTS.md");

  assert.ok(existsSync(skillPath), "SKILL.md must exist");
  assert.ok(existsSync(refPath), "reference.md must exist");
  assert.ok(existsSync(readmeEn), "README.md must exist");
  assert.ok(existsSync(readmeZh), "README.zh-CN.md must exist");
  assert.ok(existsSync(agentsMd), "AGENTS.md must exist");

  const skill = readFileSync(skillPath, "utf8");
  assert.match(skill, /^---\r?\nname:\s*opencode-delegate\r?\n/);
  assert.match(skill, /run_command/);
  assert.match(skill, /invoke_subagent/);
  assert.match(skill, /swarm/);
  assert.match(skill, /call_mcp_tool/);
  assert.match(skill, /opencode_models/);
  assert.match(skill, /opencode models --standalone/);
  assert.match(skill, /git diff/);

  const zh = readFileSync(readmeZh, "utf8");
  assert.match(zh, /agy plugin validate \.\/plugins\/opencode-delegate --strict/);
  assert.match(zh, /agy plugin install \.\/plugins\/opencode-delegate/);
  assert.match(zh, /junction|目录联接/);
});
