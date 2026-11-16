import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

if (args.includes("--version")) {
  process.stdout.write("opencode v2.3.0-fixture\n");
} else if (args.includes("models")) {
  if (process.env.TEST_MODELS_FAIL === "1") {
    process.stderr.write("Bearer SECRET_MODELS_ERR\nfailed to load models\n");
    process.exit(1);
  }
  process.stdout.write([
    "deepseek/deepseek-flash",
    "deepseek/deepseek-v4-pro",
    "opencode/big-pickle",
    "deepseek/deepseek-flash",
    "not-a-model-log-line",
  ].join("\n") + "\n");
} else {
  const mode = args.at(-1);
  if (mode === "fragmented") {
    const bytes = Buffer.from(JSON.stringify({ type: "text", sessionID: "ses_fixture", part: { text: "你好，结果完整" } }));
    for (const byte of bytes) {
      process.stdout.write(Buffer.from([byte]));
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  } else if (mode === "provider-error") {
    emit({ type: "error", error: { message: "Model unavailable" } });
  } else if (mode === "inspect-environment") {
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
    emit({ type: "text", part: { text: JSON.stringify({ pwd: process.env.PWD, args, config }) } });
  } else if (mode === "stderr-secret") {
    process.stderr.write("server password EXAMPLE_SECRET\n");
    emit({ type: "text", part: { text: "OK" } });
  } else if (mode === "delay-tree") {
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    await writeFile(process.env.TEST_CHILD_PID_FILE, String(descendant.pid));
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  } else if (mode === "delay") {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  } else if (mode === "progress-delay") {
    emit({ type: "step_start", sessionID: "ses_progress", part: { id: "step_1" } });
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  } else if (mode !== "quiet") {
    emit({ type: "text", part: { text: "OK" } });
  }
}
